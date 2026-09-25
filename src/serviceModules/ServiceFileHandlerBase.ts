import { LOG_LEVEL_INFO, LOG_LEVEL_NOTICE, LOG_LEVEL_VERBOSE } from "octagonal-wheels/common/logger";
import { serialized } from "octagonal-wheels/concurrency/lock";
import type {
    AnyEntry,
    FileEventItem,
    FilePath,
    FilePathWithPrefix,
    MetaEntry,
    UXFileInfo,
    UXFileInfoStub,
    UXFolderInfo,
    UXInternalFileInfoStub,
} from "@lib/common/types";
import {
    getDocDataAsArray,
    isDocContentSame,
    readAsBlob,
    readContent,
} from "@lib/common/utils";
import { EVENT_CONFLICT_CANCELLED } from "@lib/events/coreEvents";
import { shouldBeIgnored, stripAllPrefixes } from "@lib/string_and_binary/path";
import { Semaphore } from "octagonal-wheels/concurrency/semaphore";
import type { LiveSyncEventHub } from "@lib/hub/hub";
import type { IFileHandler } from "@lib/interfaces/FileHandler.ts";
import { ServiceModuleBase } from "@lib/serviceModules/ServiceModuleBase";
import type { APIService } from "@lib/services/base/APIService.ts";
import type { DatabaseFileAccess } from "@lib/interfaces/DatabaseFileAccess.ts";
import type { StorageAccess } from "@lib/interfaces/StorageAccess.ts";
import type { FileProcessingService } from "@lib/services/base/FileProcessingService.ts";
import type { ReplicationService } from "@lib/services/base/ReplicationService.ts";
import type { ConflictService } from "@lib/services/base/ConflictService.ts";
import type { PathService } from "@lib/services/base/PathService.ts";
import type { SettingService } from "@lib/services/base/SettingService.ts";
import type { VaultService } from "@lib/services/base/VaultService.ts";
import { getStoragePathFromUXFileInfo } from "@lib/common/typeUtils";
import { EVEN } from "@lib/common/models/shared.const.symbols";
import { tryGetFilePath } from "@lib/common/utils.doc";
import type {
    FileReflectionProvenance,
    FileReflectionProvenanceRecord,
} from "@lib/interfaces/FileReflectionProvenance.ts";

export interface ServiceFileHandlerDependencies {
    events: LiveSyncEventHub;
    API: APIService;
    databaseFileAccess: DatabaseFileAccess;
    storageAccess: StorageAccess;
    fileProcessing: FileProcessingService;
    replication: ReplicationService;
    conflict: ConflictService;
    path: PathService;
    setting: SettingService;
    vault: VaultService;
    /**
     * Device-local record of the exact database revision reflected in storage.
     *
     * This is optional for compatibility hosts. Maintained hosts should provide
     * it so edits made while a document is conflicted extend the displayed
     * branch instead of whichever branch PouchDB currently selects as winner.
     * The host must finish opening its backing store before it dispatches file
     * or replication events; provenance does not hide lifecycle violations by
     * waiting for readiness.
     */
    fileReflectionProvenance?: FileReflectionProvenance;
}

/** Acquire every key before running the callback; callers supply sorted, unique keys. */
async function serializedByKeys<T>(keys: readonly string[], callback: () => Promise<T>): Promise<T> {
    const [key, ...remainingKeys] = keys;
    if (key === undefined) return await callback();
    return await serialized(key, () => serializedByKeys(remainingKeys, callback));
}

function getParentPath(path: string): string {
    const lastSeparator = path.lastIndexOf("/");
    return lastSeparator < 0 ? "" : path.slice(0, lastSeparator);
}

function isFolderInfo(info: UXFileInfoStub | UXFolderInfo | null): info is UXFolderInfo {
    return info?.isFolder === true;
}

type RestoredFileEventAction =
    | { kind: "none" }
    | { kind: "store"; file: UXFileInfoStub }
    | { kind: "delete"; path: FilePath }
    | { kind: "rename"; file: UXFileInfoStub; oldPath: FilePathWithPrefix };

/** Storage bytes and the exact provenance observed with those bytes. */
type StorageSnapshot = { file: UXFileInfo; revision: string | undefined };

/**
 * Result of protecting storage from an incoming database reflection.
 * `preserved` stops the incoming write; `snapshot` is reusable only after a
 * caller has revalidated the same bytes, timestamp, and provenance.
 */
type PreservationResult = { preserved: boolean; snapshot?: StorageSnapshot };

/** Conflict checks requested while a document lock is held. */
type DeferredConflictCheck = { path: FilePathWithPrefix; ifOpen: boolean };

export abstract class ServiceFileHandlerBase
    extends ServiceModuleBase<ServiceFileHandlerDependencies>
    implements IFileHandler
{
    private events: LiveSyncEventHub;
    private databaseFileAccess: DatabaseFileAccess;
    private storageAccess: StorageAccess;
    private conflict: ConflictService;
    private path: PathService;
    private setting: SettingService;
    private vault: VaultService;
    private fileReflectionProvenance?: FileReflectionProvenance;
    private readonly deferredConflictChecks = new Map<string, DeferredConflictCheck[]>();
    constructor(services: ServiceFileHandlerDependencies) {
        super(services);
        this.events = services.events;
        this.databaseFileAccess = services.databaseFileAccess;
        this.storageAccess = services.storageAccess;
        this.conflict = services.conflict;
        this.path = services.path;
        this.setting = services.setting;
        this.vault = services.vault;
        this.fileReflectionProvenance = services.fileReflectionProvenance;
        services.fileProcessing.processFileEvent.addHandler(this._anyHandlerProcessesFileEvent.bind(this), 100);
        services.replication.processSynchroniseResult.addHandler(this._anyProcessReplicatedDoc.bind(this), 100);
    }
    get db() {
        return this.databaseFileAccess;
    }
    get storage() {
        return this.storageAccess;
    }

    private async getProvenance(path: FilePathWithPrefix): Promise<FileReflectionProvenanceRecord | undefined> {
        if (!this.fileReflectionProvenance) return undefined;
        try {
            const record = await this.fileReflectionProvenance.get(path);
            if (!record) return undefined;
            const entry = await this.db.fetchEntryMeta(path, record.revision, true);
            if (entry && !entry._deleted && !entry.deleted) {
                return record;
            }
            await this.fileReflectionProvenance.delete(path);
        } catch (ex) {
            // Store readiness is owned by the host lifecycle. Do not wait or
            // retry here: that can hang failed initialisation or become
            // self-referential during reset. Treat an unavailable record as
            // unknown provenance so the operation takes the conservative
            // preserve-for-review path instead of guessing a winner.
            this._log(`Could not read file reflection provenance for ${path}`, LOG_LEVEL_VERBOSE);
            this._log(ex, LOG_LEVEL_VERBOSE);
        }
        return undefined;
    }

    private async setProvenance(
        path: FilePathWithPrefix,
        revision: string | undefined,
        observedStorageMtime?: number
    ): Promise<void> {
        if (!this.fileReflectionProvenance || !revision) return;
        try {
            await this.fileReflectionProvenance.set(path, {
                revision,
                observedStorageMtime,
            });
        } catch (ex) {
            this._log(`Could not record file reflection provenance for ${path}`, LOG_LEVEL_VERBOSE);
            this._log(ex, LOG_LEVEL_VERBOSE);
        }
    }

    private async deleteProvenance(path: FilePathWithPrefix): Promise<void> {
        if (!this.fileReflectionProvenance) return;
        try {
            await this.fileReflectionProvenance.delete(path);
        } catch (ex) {
            this._log(`Could not delete file reflection provenance for ${path}`, LOG_LEVEL_VERBOSE);
            this._log(ex, LOG_LEVEL_VERBOSE);
        }
    }

    private async findUniqueContentRevision(file: UXFileInfo): Promise<string | undefined> {
        try {
            const revisions = await this.db.findContentRevisions(file, file.body);
            return revisions.length === 1 ? revisions[0] : undefined;
        } catch (ex) {
            this._log(`Could not reconstruct file reflection provenance for ${file.path}`, LOG_LEVEL_VERBOSE);
            this._log(ex, LOG_LEVEL_VERBOSE);
            return undefined;
        }
    }

    private async getProvenBaseRevision(
        file: UXFileInfo,
        preferredPath?: FilePathWithPrefix
    ): Promise<string | undefined> {
        const path = (preferredPath ?? file.path) as FilePathWithPrefix;
        const recorded =
            (await this.getProvenance(path)) ??
            (preferredPath && preferredPath !== file.path ? await this.getProvenance(file.path) : undefined);
        // A stored record identifies the branch which produced the displayed
        // file. Its current content may legitimately have been edited to equal
        // another branch, so content matching must never override that identity.
        if (recorded) {
            return recorded.revision;
        }
        const matched = await this.findUniqueContentRevision(file);
        if (matched) {
            await this.setProvenance(path, matched, file.stat.mtime);
            return matched;
        }
        return undefined;
    }

    /**
     * Classify a storage read against its displayed database branch.
     *
     * A recorded revision identifies the branch and therefore takes precedence
     * over byte matches. Without a readable base, only current live leaves are
     * considered. Any match avoids a duplicate write, but only a unique match
     * identifies provenance; no match is `unknown`.
     * `preferredPath` selects the provenance key during a rename, and
     * `currentLoaded` supplies an already decoded candidate body when available.
     * Missing chunks do not clear provenance unless their metadata is also
     * missing or deleted.
     */
    private async classifyStorageContent(
        file: UXFileInfo,
        currentEntry: { _rev?: string; deleted?: boolean; _deleted?: boolean } | false,
        preferredPath?: FilePathWithPrefix,
        recordedRevision?: string,
        currentLoaded?: { _rev?: string; data: string | string[] | Blob | ArrayBuffer }
    ): Promise<
        | { kind: "unchanged" | "edited"; revision: string }
        | { kind: "matching-leaf"; revision?: string }
        | { kind: "unknown" }
    > {
        const path = (preferredPath ?? file.path) as FilePathWithPrefix;
        if (recordedRevision) {
            const loadedContentIsDecoded = currentLoaded?._rev === recordedRevision;
            const base = loadedContentIsDecoded
                ? currentLoaded
                : await this.db.fetchEntry(file, recordedRevision, true, true, true);
            if (base && base._rev === recordedRevision && !("deleted" in base && base.deleted) &&
                !("_deleted" in base && base._deleted)) {
                const baseContent = loadedContentIsDecoded ? base.data : readContent(base as Parameters<typeof readContent>[0]);
                return await isDocContentSame(baseContent, file.body)
                    ? { kind: "unchanged", revision: recordedRevision }
                    : { kind: "edited", revision: recordedRevision };
            }
            // A missing body cannot establish whether storage was changed.
            // Clear only metadata which is itself missing or deleted; missing chunks
            // may recover later.
            if (!base) {
                const meta = await this.db.fetchEntryMeta(file, recordedRevision, true);
                if (!meta || meta.deleted || meta._deleted) await this.deleteProvenance(path);
            }
        }
        const matches = currentEntry ? await this.db.findLiveContentRevisions(file, file.body) : [];
        if (matches.length) {
            return { kind: "matching-leaf", revision: matches.length === 1 ? matches[0] : undefined };
        }
        return { kind: "unknown" };
    }

    /** Record provenance only when storage matches one unambiguous live leaf. */
    private async rememberMatchingLeaf(path: FilePathWithPrefix, revision: string | undefined, mtime: number) {
        if (revision) await this.setProvenance(path, revision, mtime);
    }

    /**
     * Read the raw provenance value used by an optimistic storage snapshot.
     * Unlike `getProvenance`, this does not validate or remove the referenced
     * database revision; an unreadable value is represented as `undefined`.
     */
    private async readProvenanceSnapshot(path: FilePathWithPrefix): Promise<string | undefined> {
        try {
            return (await this.fileReflectionProvenance?.get(path))?.revision;
        } catch {
            return undefined;
        }
    }

    /**
     * Check that storage still has the same path, bytes, timestamp, and
     * provenance as a previously captured snapshot.
     */
    private async currentStorageSnapshotMatches(file: UXFileInfo, revision: string | undefined): Promise<boolean> {
        const current = await this.storage.getStub(file.path);
        if (!current || isFolderInfo(current) || current.path !== file.path) return false;
        const readCurrent = await this.readFileFromStub(current);
        return readCurrent.stat.mtime === file.stat.mtime &&
            await isDocContentSame(readCurrent.body, file.body) &&
            (await this.readProvenanceSnapshot(file.path)) === revision;
    }

    /**
     * Publish provenance after a durable database write if storage is unchanged.
     * A failed revalidation leaves the database revision stored and asks the
     * caller to reread storage before proceeding.
     */
    private async finaliseStoredRevision(
        file: UXFileInfo,
        observedProvenance: string | undefined,
        storedRevision: string
    ): Promise<boolean> {
        if (await this.currentStorageSnapshotMatches(file, observedProvenance)) {
            await this.setProvenance(file.path, storedRevision, file.stat.mtime);
            return true;
        } else {
            // The write is durable, but the storage changed before its provenance
            // could be recorded. The caller must reconcile the current file.
            return false;
        }
    }

    /**
     * Reread storage after a restored startup snapshot changed and retry a save.
     * The bounded counter prevents an unstable file from causing an endless
     * startup loop; the next event or scan can reconcile a final refusal.
     */
    private async retryCurrentStorage(
        path: FilePathWithPrefix,
        preferredBasePath: FilePathWithPrefix | undefined,
        snapshotRetry: number
    ): Promise<boolean> {
        if (snapshotRetry >= 2) {
            this._log(`Storage kept changing while saving ${path}; a fresh event is required`, LOG_LEVEL_NOTICE);
            return false;
        }
        const fresh = await this.storage.getStub(path);
        if (!fresh || isFolderInfo(fresh)) return false;
        return await this.storeFileToDBFromRevision(fresh, false, false, preferredBasePath, true, snapshotRetry + 1);
    }

    getPath(entry: AnyEntry): FilePathWithPrefix {
        return this.path.getPath(entry);
    }
    getPathWithoutPrefix(entry: AnyEntry): FilePathWithPrefix {
        return stripAllPrefixes(this.path.getPath(entry));
    }

    async readFileFromStub(file: UXFileInfoStub | UXFileInfo) {
        if ("body" in file && file.body) {
            return file;
        }
        const readFile = await this.storage.readStubContent(file);
        if (!readFile) {
            throw new Error(`File ${file.path} is not exist on the storage`);
        }
        return readFile;
    }

    async tryRecordUntrackedFileRevision(
        info: UXFileInfoStub | UXFileInfo,
        expectedRevision: string
    ): Promise<boolean> {
        if (!this.fileReflectionProvenance || !expectedRevision) return false;
        const path = getStoragePathFromUXFileInfo(info);
        try {
            return await this.serializedByFileEventPaths([path], async () => {
                const provenance = this.fileReflectionProvenance!;
                // A recorded branch remains authoritative, even when its
                // current bytes happen to match the database winner.
                if (await provenance.get(path)) return false;
                const stub = await this.storage.getStub(path);
                if (!stub || isFolderInfo(stub) || stub.path !== path) return false;
                const file = await this.readFileFromStub(stub);
                const current = await this.db.fetchEntryMeta(path, undefined, true);
                if (!current || current._rev !== expectedRevision || current.deleted || current._deleted) return false;
                if ((await this.db.getConflictedRevs(path)).length > 0) return false;
                const entry = await this.db.fetchEntry(path, expectedRevision, true, true, true);
                if (!entry || entry._rev !== expectedRevision || entry.deleted || entry._deleted) return false;
                if (!await isDocContentSame(readContent(entry), file.body)) return false;

                const latest = await this.db.fetchEntryMeta(path, undefined, true);
                if (!latest || latest._rev !== expectedRevision || latest.deleted || latest._deleted) return false;
                if ((await this.db.getConflictedRevs(path)).length > 0) return false;
                if (!await this.currentStorageSnapshotMatches(file, undefined)) return false;
                if (await provenance.get(path)) return false;
                await provenance.set(path, { revision: expectedRevision, observedStorageMtime: file.stat.mtime });
                return true;
            });
        } catch (ex) {
            this._log(`Could not record unchanged file provenance for ${path}`, LOG_LEVEL_VERBOSE);
            this._log(ex, LOG_LEVEL_VERBOSE);
            return false;
        }
    }
    private async infoToStub<T extends UXFileInfoStub | UXFileInfo | UXInternalFileInfoStub>(
        info: null | T | FilePathWithPrefix | FilePath
    ): Promise<T | UXFileInfoStub | null> {
        if (info == null) return null;
        const file = typeof info === "string" ? await this.storage.getFileStub(info) : info;
        return file;
    }

    async storeFileToDB(
        info: UXFileInfoStub | UXFileInfo | UXInternalFileInfoStub | FilePathWithPrefix,
        force: boolean = false,
        onlyChunks: boolean = false
    ): Promise<boolean> {
        return await this.serializedByFileEventPaths([getStoragePathFromUXFileInfo(info)], () =>
            this.storeFileToDBFromRevision(info, force, onlyChunks)
        );
    }

    async storeFileToDBWithBaseRevision(
        info: UXFileInfoStub | UXFileInfo | FilePathWithPrefix,
        baseRevision: string,
        createIfDifferent: boolean = true
    ): Promise<boolean> {
        return await this.serializedByFileEventPaths([getStoragePathFromUXFileInfo(info)], () =>
            this.storeFileToDBWithBaseRevisionCore(info, baseRevision, createIfDifferent)
        );
    }

    /**
     * Store current storage content below an exact live revision. A differing
     * body is rejected when `createIfDifferent` is false; callers hold the
     * document lock for this core operation.
     */
    private async storeFileToDBWithBaseRevisionCore(
        info: UXFileInfoStub | UXFileInfo | FilePathWithPrefix,
        baseRevision: string,
        createIfDifferent: boolean
    ): Promise<boolean> {
        const file = await this.infoToStub(info);
        if (file == null) {
            this._log(`File ${tryGetFilePath(info)} is not exist on the storage`, LOG_LEVEL_VERBOSE);
            return false;
        }
        if (file.isInternal) {
            this._log(
                `Internal file ${file.path} is not allowed to be stored through the ordinary file handler`,
                LOG_LEVEL_VERBOSE
            );
            return false;
        }

        const [baseEntry, currentEntry, conflictedRevisions] = await Promise.all([
            this.db.fetchEntryMeta(file, baseRevision, true),
            this.db.fetchEntryMeta(file, undefined, true),
            this.db.getConflictedRevs(file),
        ]);
        const liveRevisions = new Set([
            ...(currentEntry && currentEntry._rev ? [currentEntry._rev] : []),
            ...conflictedRevisions,
        ]);
        if (!baseEntry || baseEntry._rev !== baseRevision || !liveRevisions.has(baseRevision)) {
            this._log(
                `Could not store ${file.path} on revision ${baseRevision}; the selected revision is no longer live`,
                LOG_LEVEL_NOTICE
            );
            return false;
        }

        const readFile = await this.readFileFromStub(file);
        if (!baseEntry.deleted && !baseEntry._deleted) {
            const loadedBase = await this.db.fetchEntry(file, baseRevision, true, true);
            if (loadedBase && (await isDocContentSame(getDocDataAsArray(loadedBase.data), readFile.body))) {
                await this.setProvenance(file.path, baseRevision, readFile.stat.mtime);
                await this.queueConflictCheckFor(file.path);
                return true;
            }
        }
        if (!createIfDifferent) {
            this._log(
                `Could not mark ${file.path} as revision ${baseRevision}; the storage content differs`,
                LOG_LEVEL_NOTICE
            );
            return false;
        }

        const storedRevision = await this.db.storeWithBaseRevision(readFile, baseRevision, true);
        if (storedRevision === false) {
            return false;
        }
        await this.setProvenance(file.path, storedRevision, readFile.stat.mtime);
        await this.queueConflictCheckFor(file.path);
        return true;
    }

    /**
     * Save one storage snapshot while the caller holds its document lock.
     * Ordinary saves read once inside the lock and leave retries disabled.
     * Restored startup events retain bounded rereads because file watching has
     * not yet started and cannot supply a new event for a concurrent edit.
     */
    private async storeFileToDBFromRevision(
        info: UXFileInfoStub | UXFileInfo | UXInternalFileInfoStub | FilePathWithPrefix,
        force: boolean = false,
        onlyChunks: boolean = false,
        preferredBasePath?: FilePathWithPrefix,
        retryIfStorageChanges = false,
        snapshotRetry = 0
    ): Promise<boolean> {
        const file = await this.infoToStub(info);
        if (file == null) {
            this._log(`File ${tryGetFilePath(info)} is not exist on the storage`, LOG_LEVEL_VERBOSE);
            return false;
        }
        // const file = item.args.file;
        if (file.isInternal) {
            this._log(
                `Internal file ${file.path} is not allowed to be processed on processFileEvent`,
                LOG_LEVEL_VERBOSE
            );
            return false;
        }
        // Chunk-only repair does not create a document revision and therefore
        // does not change which revision storage represents.
        if (onlyChunks) {
            const readFile = await this.readFileFromStub(file);
            return await this.db.createChunks(readFile, force, true);
        }

        // Keep the storage read and its observed branch together for this save.
        // Restored startup calls opt into revalidation below because their
        // persisted event snapshot may be stale; ordinary events use one read.
        const observedProvenance = await this.readProvenanceSnapshot(
            (preferredBasePath ?? file.path) as FilePathWithPrefix
        );
        const readFile = await this.readFileFromStub(file);
        // First, check the file on the database
        const entry = await this.db.fetchEntry(file, undefined, true, true, true);
        const currentEntry = entry || await this.db.fetchEntryMeta(file, undefined, true);
        const conflictedRevs = await this.db.getConflictedRevs(file);
        const isConflicted = conflictedRevs.length > 0;

        if (!force && currentEntry && !currentEntry.deleted && !currentEntry._deleted) {
            const classification = await this.classifyStorageContent(
                readFile, currentEntry, preferredBasePath, observedProvenance,
                entry ? { _rev: entry._rev, data: readContent(entry) } : undefined
            );
            if (retryIfStorageChanges && !(await this.currentStorageSnapshotMatches(readFile, observedProvenance))) {
                return await this.retryCurrentStorage(file.path, preferredBasePath, snapshotRetry);
            }
            if (classification.kind === "unchanged") {
                if (isConflicted) {
                    await this.queueConflictCheckFor(file.path);
                } else if (classification.revision !== currentEntry._rev) {
                    if (!entry) return false;
                    return await this.dbToStorageCore(file.path as FilePathWithPrefix, file);
                } else {
                    this.path.markChangesAreSame(readFile, readFile.stat.mtime, currentEntry.mtime);
                }
                return true;
            }
            if (classification.kind === "matching-leaf") {
                await this.rememberMatchingLeaf(file.path, classification.revision, readFile.stat.mtime);
                if (isConflicted) await this.queueConflictCheckFor(file.path);
                return true;
            }
            const storedRevision = classification.kind === "edited"
                ? await this.db.storeWithBaseRevision(readFile, classification.revision, true)
                : await this.db.storeIndependentRevision(readFile, true);
            if (storedRevision === false) return false;
            if (preferredBasePath && preferredBasePath !== file.path) await this.deleteProvenance(preferredBasePath);
            if (retryIfStorageChanges &&
                !(await this.finaliseStoredRevision(readFile, observedProvenance, storedRevision))) {
                return await this.retryCurrentStorage(file.path, preferredBasePath, snapshotRetry);
            }
            if (!retryIfStorageChanges) await this.setProvenance(file.path, storedRevision, readFile.stat.mtime);
            if (isConflicted || classification.kind === "unknown") await this.queueConflictCheckFor(file.path);
            return true;
        }

        if (isConflicted) {
            const baseRevision = await this.getProvenBaseRevision(readFile, preferredBasePath);
            if (baseRevision) {
                const baseEntry = await this.db.fetchEntry(file, baseRevision, true, true);
                if (baseEntry && (await isDocContentSame(getDocDataAsArray(baseEntry.data), readFile.body)) && !force) {
                    await this.setProvenance(file.path, baseRevision, readFile.stat.mtime);
                    this._log(`File ${file.path} is not changed on its displayed conflict branch`, LOG_LEVEL_VERBOSE);
                    return true;
                }
                const storedRevision = await this.db.storeWithBaseRevision(readFile, baseRevision, true);
                if (storedRevision === false) return false;
                if (preferredBasePath && preferredBasePath !== file.path) {
                    await this.deleteProvenance(preferredBasePath);
                }
                await this.setProvenance(file.path, storedRevision, readFile.stat.mtime);
                await this.queueConflictCheckFor(file.path);
                return true;
            }
            // Missing chunks can make the winning entry body unavailable while its metadata
            // and revision tree remain readable. Preserving the local bytes as a sibling only
            // requires the exact winning revision; it does not require trusting its content.
            const currentEntry = entry || (await this.db.fetchEntryMeta(file, undefined, true));
            const currentRevision = currentEntry && currentEntry._rev;
            if (!currentRevision) {
                this._log(
                    `Could not preserve the unknown conflict branch for ${file.path}; no current revision is available`,
                    LOG_LEVEL_NOTICE
                );
                await this.queueConflictCheckFor(file.path);
                return false;
            }
            const storedRevision = await this.db.storeAsConflictedRevisionWithResult(readFile, currentRevision, true);
            if (storedRevision === false) {
                this._log(`Could not preserve the unknown conflict branch for ${file.path}`, LOG_LEVEL_NOTICE);
                await this.queueConflictCheckFor(file.path);
                return false;
            }
            if (preferredBasePath && preferredBasePath !== file.path) {
                await this.deleteProvenance(preferredBasePath);
            }
            await this.setProvenance(file.path, storedRevision, readFile.stat.mtime);
            await this.queueConflictCheckFor(file.path);
            return true;
        }

        if (!currentEntry || currentEntry.deleted || currentEntry._deleted) {
            // If the file is not exist on the database, then it should be created.
            const storedRevision = await this.db.storeWithBaseRevision(readFile, entry && entry._rev, true);
            if (storedRevision === false) return false;
            if (preferredBasePath && preferredBasePath !== file.path) {
                await this.deleteProvenance(preferredBasePath);
            }
            await this.setProvenance(file.path, storedRevision, readFile.stat.mtime);
            return true;
        }

        // entry is exist on the database, check the difference between the file and the entry.

        let shouldApplied = false;
        if (!force && !onlyChunks && entry) {
            // 1. if the time stamp is far different, then it should be updated.
            // Note: This checks only the mtime with the resolution reduced to 2 seconds.
            //       2 seconds it for the ZIP file's mtime. If not, we cannot backup the vault as the ZIP file.
            //       This is hardcoded on `compareMtime` of `src/common/utils.ts`.
            if (this.path.compareFileFreshness(file, entry) !== EVEN) {
                shouldApplied = true;
            }
            // 2. if not, the content should be checked.
            if (!shouldApplied) {
                if (await isDocContentSame(getDocDataAsArray(entry.data), readFile.body)) {
                    // Timestamp is different but the content is same. therefore, two timestamps should be handled as same.
                    // So, mark the changes are same.
                    this.path.markChangesAreSame(readFile, readFile.stat.mtime, entry.mtime);
                } else {
                    shouldApplied = true;
                }
            }

            if (!shouldApplied) {
                await this.setProvenance(file.path, entry._rev, readFile.stat.mtime);
                this._log(`File ${file.path} is not changed`, LOG_LEVEL_VERBOSE);
                return true;
            }
        }
        const storedRevision = await this.db.storeWithBaseRevision(readFile, currentEntry._rev, true);
        if (storedRevision === false) return false;
        if (preferredBasePath && preferredBasePath !== file.path) {
            await this.deleteProvenance(preferredBasePath);
        }
        await this.setProvenance(file.path, storedRevision, readFile.stat.mtime);
        return true;
    }

    async deleteFileFromDB(info: UXFileInfoStub | UXInternalFileInfoStub | FilePath): Promise<boolean> {
        return await this.serializedByFileEventPaths([getStoragePathFromUXFileInfo(info)], () =>
            this.deleteFileFromDBCore(info)
        );
    }

    /**
     * Record a storage deletion under the caller's document lock, preserving
     * the displayed conflict branch when its provenance is known.
     */
    private async deleteFileFromDBCore(info: UXFileInfoStub | UXInternalFileInfoStub | FilePath): Promise<boolean> {
        const file = await this.infoToStub(info);
        const path = (typeof info === "string" ? info : tryGetFilePath(info)) as FilePathWithPrefix | undefined;
        if (file == null) {
            // infoToStub -> getFileStub stats the storage, but in the offline-scanner
            // `delete-db` path the file is by definition already gone from storage, so the
            // stub is always null and the delete silently no-ops (returns false). No
            // tombstone ever reaches the database and the next scan resurrects the file.
            // Fall back to a path-based database delete, the same approach the CLI `rm`
            // command uses (databaseFileAccess.delete accepts a bare path).
            if (path === undefined) {
                this._log(`File ${tryGetFilePath(info)} is not exist on the storage`, LOG_LEVEL_VERBOSE);
                return false;
            }
            const entryByPath = await this.db.fetchEntry(path as FilePathWithPrefix, undefined, true, true);
            if (!entryByPath || entryByPath.deleted || entryByPath._deleted) {
                this._log(
                    `File ${path} is not exist on the storage nor the database (or already deleted)`,
                    LOG_LEVEL_VERBOSE
                );
                return false;
            }
            const conflictedRevs = await this.db.getConflictedRevs(path);
            if (conflictedRevs.length > 0) {
                const provenance = await this.getProvenance(path);
                if (!provenance) {
                    this._log(
                        `The deleted storage file ${path} has conflicts, but its displayed revision is unknown; preserving every database branch`,
                        LOG_LEVEL_NOTICE
                    );
                    await this.queueConflictCheckFor(path);
                    return true;
                }
                const storedRevision = await this.db.storeDeletionWithBaseRevision(path, provenance.revision);
                if (storedRevision === false) return false;
                await this.deleteProvenance(path);
                await this.queueConflictCheckFor(path);
                return true;
            }
            this._log(`File ${path} is missing on storage; deleting from the database by path`, LOG_LEVEL_INFO);
            const deleted = await this.db.delete(path);
            if (deleted) await this.deleteProvenance(path);
            return deleted;
        }
        // const file = item.args.file;
        if (file.isInternal) {
            this._log(
                `Internal file ${file.path} is not allowed to be processed on processFileEvent`,
                LOG_LEVEL_VERBOSE
            );
            return false;
        }
        // First, check the file on the database
        const entry = await this.db.fetchEntry(file, undefined, true, true);
        if (!entry || entry.deleted || entry._deleted) {
            this._log(`File ${file.path} is not exist or already deleted on the database`, LOG_LEVEL_VERBOSE);
            return false;
        }
        // Check the file is already conflicted. if so, only the conflicted one should be deleted.
        const conflictedRevs = await this.db.getConflictedRevs(file);
        if (conflictedRevs.length > 0) {
            let baseRevision = (await this.getProvenance(file.path))?.revision;
            if (!baseRevision) {
                try {
                    const readFile = await this.readFileFromStub(file);
                    baseRevision = await this.findUniqueContentRevision(readFile);
                } catch {
                    // A deletion event can arrive after storage has removed the
                    // file, so content reconstruction is only opportunistic.
                }
            }
            if (!baseRevision) {
                this._log(
                    `The deleted storage file ${file.path} has conflicts, but its displayed revision is unknown; preserving every database branch`,
                    LOG_LEVEL_NOTICE
                );
                await this.queueConflictCheckFor(file.path);
                return true;
            }
            const storedRevision = await this.db.storeDeletionWithBaseRevision(file.path, baseRevision);
            if (storedRevision === false) return false;
            await this.deleteProvenance(file.path);
            await this.queueConflictCheckFor(file.path);
            return true;
        }
        // Otherwise, the file should be deleted simply. This is the previous behaviour.
        const deleted = await this.db.delete(file);
        if (deleted) await this.deleteProvenance(file.path);
        return deleted;
    }

    async renameFileInDB(info: UXFileInfoStub | UXFileInfo, oldPath: FilePath | FilePathWithPrefix): Promise<boolean> {
        const newPath = getStoragePathFromUXFileInfo(info);
        return await this.serializedByFileEventPaths([oldPath as FilePathWithPrefix, newPath], () =>
            this.renameFileInDBCore(info, oldPath)
        );
    }

    /**
     * Record a rename under the caller's source and target locks. Case-only
     * renames retain the source provenance while other renames handle the
     * source conflict before deleting its old path.
     */
    private async renameFileInDBCore(
        info: UXFileInfoStub | UXFileInfo,
        oldPath: FilePath | FilePathWithPrefix,
        retryIfStorageChanges = false
    ): Promise<boolean> {
        const newPath = getStoragePathFromUXFileInfo(info);
        const [oldDocumentId, newDocumentId] = await Promise.all([
            this.path.path2id(oldPath),
            this.path.path2id(newPath),
        ]);

        if (oldDocumentId === newDocumentId) {
            this._log(`Updating the stored path for case-only rename: ${oldPath} -> ${newPath}`, LOG_LEVEL_VERBOSE);
            return await this.storeFileToDBFromRevision(
                info, true, false, oldPath as FilePathWithPrefix, retryIfStorageChanges
            );
        }

        const oldEntry = await this.db.fetchEntryMeta(oldPath, undefined, true);
        const newEntry = await this.db.fetchEntryMeta(newPath, undefined, true);
        if (newEntry && !newEntry.deleted && !newEntry._deleted) {
            this._log(
                `Refusing to overwrite the existing database entry while renaming ${oldPath} to ${newPath}`,
                LOG_LEVEL_NOTICE
            );
            return false;
        }
        if (!(await this.storeFileToDBFromRevision(info, true, false, undefined, retryIfStorageChanges))) {
            this._log(`Failed to store rename target; preserving source in the database: ${oldPath}`, LOG_LEVEL_NOTICE);
            return false;
        }
        if (!oldEntry || oldEntry.deleted || oldEntry._deleted) {
            this._log(`Rename source is not present in the database: ${oldPath}`, LOG_LEVEL_VERBOSE);
            return true;
        }

        const oldConflicts = await this.db.getConflictedRevs(oldPath);
        if (oldConflicts.length > 0) {
            let baseRevision = (await this.getProvenance(oldPath as FilePathWithPrefix))?.revision;
            if (!baseRevision) {
                const readFile = await this.readFileFromStub(info);
                const revisions = await this.db.findContentRevisions(oldPath as FilePathWithPrefix, readFile.body);
                baseRevision = revisions.length === 1 ? revisions[0] : undefined;
            }
            if (!baseRevision) {
                this._log(
                    `Renamed ${oldPath} to ${newPath}, but preserved every conflicted source branch because the displayed source revision is unknown`,
                    LOG_LEVEL_NOTICE
                );
                await this.queueConflictCheckFor(oldPath as FilePathWithPrefix);
                return true;
            }
            const storedRevision = await this.db.storeDeletionWithBaseRevision(
                oldPath as FilePathWithPrefix,
                baseRevision
            );
            if (storedRevision === false) return false;
            await this.deleteProvenance(oldPath as FilePathWithPrefix);
            await this.queueConflictCheckFor(oldPath as FilePathWithPrefix);
            return true;
        }
        const deleted = await this.db.delete(oldPath as FilePathWithPrefix);
        if (deleted) await this.deleteProvenance(oldPath as FilePathWithPrefix);
        return deleted;
    }

    async deleteRevisionFromDB(
        info: UXFileInfoStub | FilePath | FilePathWithPrefix,
        rev: string
    ): Promise<boolean | undefined> {
        return await this.serializedByFileEventPaths([getStoragePathFromUXFileInfo(info)], () =>
            this.deleteRevisionFromDBCore(info, rev)
        );
    }

    /** Delete one selected revision and clear matching provenance under the caller's document lock. */
    private async deleteRevisionFromDBCore(
        info: UXFileInfoStub | FilePath | FilePathWithPrefix,
        rev: string
    ): Promise<boolean | undefined> {
        const path = getStoragePathFromUXFileInfo(info);
        const provenance = await this.getProvenance(path);
        const deleted = await this.db.delete(info, rev);
        if (deleted && provenance?.revision === rev) {
            await this.deleteProvenance(path);
        }
        return deleted;
    }

    async resolveConflictedByDeletingRevision(
        info: UXFileInfoStub | FilePath,
        rev: string
    ): Promise<boolean | undefined> {
        return await this.serializedByFileEventPaths([getStoragePathFromUXFileInfo(info)], () =>
            this.resolveConflictedByDeletingRevisionCore(info, rev)
        );
    }

    /**
     * Apply the legacy resolve-by-delete sequence while holding one document
     * lock; metadata is captured before the selected revision is removed.
     */
    private async resolveConflictedByDeletingRevisionCore(
        info: UXFileInfoStub | FilePath,
        rev: string
    ): Promise<boolean | undefined> {
        const path = getStoragePathFromUXFileInfo(info);
        const file = await this.infoToStub(info);
        const docEntry = await this.db.fetchEntryMeta(file ?? info, rev, true);
        if (!docEntry) {
            this._log(`Failed to read the conflicted revision ${rev} of ${path}`, LOG_LEVEL_VERBOSE);
            return false;
        }
        if (!(await this.deleteRevisionFromDBCore(info, rev))) {
            this._log(`Failed to delete the conflicted revision ${rev} of ${path}`, LOG_LEVEL_VERBOSE);
            return false;
        }
        // This legacy operation deliberately applies the branch which it has
        // just removed. The public exact-revision operation accepts only live
        // branches, so it cannot be used after the deletion. Preserve the old
        // ordering by applying the metadata captured before deletion, then
        // discard any provenance for the now non-live revision.
        if (!(await this.applyDatabaseEntryToStorage(docEntry, file, true))) {
            this._log(`Failed to apply the resolved revision ${rev} of ${path} to the storage`, LOG_LEVEL_VERBOSE);
            return false;
        }
        await this.deleteProvenance(path);
    }

    async dbToStorageWithSpecificRev(
        info: UXFileInfoStub | UXFileInfo | FilePath | FilePathWithPrefix | null,
        rev: string,
        force?: boolean
    ): Promise<boolean> {
        if (info == null) {
            this._log(`Cannot select database revision ${rev} without a file path`, LOG_LEVEL_VERBOSE);
            return false;
        }
        return await this.serializedByFileEventPaths([getStoragePathFromUXFileInfo(info)], () =>
            this.dbToStorageWithSpecificRevCore(info, rev, force)
        );
    }

    /**
     * Reflect a selected live revision under the caller's document lock.
     * The public wrapper performs the same lock acquisition before entering here.
     */
    private async dbToStorageWithSpecificRevCore(
        info: UXFileInfoStub | UXFileInfo | FilePath | FilePathWithPrefix,
        rev: string,
        force?: boolean
    ): Promise<boolean> {
        const file = await this.infoToStub(info);
        const databaseTarget = file ?? info;
        const [docEntry, currentEntry, conflictedRevisions] = await Promise.all([
            this.db.fetchEntryMeta(databaseTarget, rev, true),
            this.db.fetchEntryMeta(databaseTarget, undefined, true),
            this.db.getConflictedRevs(databaseTarget),
        ]);
        if (!docEntry) {
            this._log(`File ${tryGetFilePath(info)} is not exist on the database`, LOG_LEVEL_VERBOSE);
            return false;
        }
        const liveRevisions = new Set([
            ...(currentEntry && currentEntry._rev ? [currentEntry._rev] : []),
            ...conflictedRevisions,
        ]);
        if (!liveRevisions.has(rev)) {
            this._log(
                `Could not apply ${tryGetFilePath(info)} revision ${rev}; the selected revision is no longer live`,
                LOG_LEVEL_NOTICE
            );
            return false;
        }
        return await this.applyDatabaseEntryToStorage(docEntry, file, force, true);
    }

    async dbToStorage(
        entryInfo: MetaEntry | FilePathWithPrefix,
        info: UXFileInfoStub | UXFileInfo | FilePath | null,
        force?: boolean
    ): Promise<boolean> {
        const pathFromEntryInfo = typeof entryInfo === "string" ? entryInfo : this.getPath(entryInfo);
        return await this.serializedByFileEventPaths([pathFromEntryInfo], () =>
            this.dbToStorageCore(entryInfo, info, force)
        );
    }

    /** Fetch the current metadata and reflect it while the caller holds its lock. */
    private async dbToStorageCore(
        entryInfo: MetaEntry | FilePathWithPrefix,
        info: UXFileInfoStub | UXFileInfo | FilePath | null,
        force?: boolean
    ): Promise<boolean> {
        const file = await this.infoToStub(info);
        const pathFromEntryInfo = typeof entryInfo === "string" ? entryInfo : this.getPath(entryInfo);
        const docEntry = await this.db.fetchEntryMeta(pathFromEntryInfo, undefined, true);
        if (!docEntry) {
            this._log(`File ${pathFromEntryInfo} is not exist on the database`, LOG_LEVEL_VERBOSE);
            return false;
        }
        return await this.applyDatabaseEntryToStorage(docEntry, file, force);
    }

    /**
     * Reflect one database revision while protecting concurrent storage edits.
     * Overwrite and deletion paths preserve changed bytes first, then revalidate
     * their snapshot and the current database revision immediately before the
     * destructive operation.
     */
    private async applyDatabaseEntryToStorage(
        docEntry: MetaEntry,
        file: UXFileInfoStub | UXFileInfo | null,
        force?: boolean,
        allowExistingConflicts: boolean = false,
        incomingRetry = 0
    ): Promise<boolean> {
        const mode = file == null ? "create" : "modify";
        const path = this.getPath(docEntry);
        const settings = this.setting.currentSettings();
        // 1. Check if it already conflicted.
        const revs = await this.db.getConflictedRevs(path);
        if (revs.length > 0 && !allowExistingConflicts) {
            // Some conflicts are exist.
            if (settings.writeDocumentsIfConflicted) {
                // If configured to write the document even if conflicted, then it should be written.
                // NO OP
            } else {
                // If not, then it should be checked. and will be processed later (i.e., after the conflict is resolved).
                await this.queueConflictCheckFor(path, true);
                return true;
            }
        }

        // 2. Check if the file is already exist on the storage.
        let existDoc = await this.storage.getStub(path);
        if (isFolderInfo(existDoc)) {
            this._log(`Folder ${path} is already exist on the storage as a folder`, LOG_LEVEL_VERBOSE);
            // We can do nothing, and other modules should also nothing to do.
            return true;
        }

        // Check existence of both file and docEntry.
        const existOnDB = !(docEntry._deleted || docEntry.deleted || false);
        if (!existOnDB && !existDoc) {
            this._log(`File ${path} seems to be deleted, but already not on storage`, LOG_LEVEL_VERBOSE);
            await this.deleteProvenance(path);
            return true;
        }
        if (!existOnDB && existDoc) {
        // Deletion is destructive, so retain the protected storage snapshot
        // through every asynchronous database recheck.
        let safeDeletionSnapshot: StorageSnapshot | undefined;
            if (!force && !settings.writeDocumentsIfConflicted) {
                let protection = await this.preserveUnsyncedStorageAsConflict(path, existDoc, docEntry);
                if (protection.preserved) return true;
                if (!protection.snapshot ||
                    !(await this.currentStorageSnapshotMatches(protection.snapshot.file, protection.snapshot.revision))) {
                    protection = await this.recheckIncomingStorage(path, docEntry, undefined, allowExistingConflicts);
                    if (protection.preserved) return true;
                    if (!protection.snapshot ||
                        !(await this.currentStorageSnapshotMatches(protection.snapshot.file, protection.snapshot.revision))) {
                        return false;
                    }
                }
                safeDeletionSnapshot = protection.snapshot;
            }
            let latest = await this.reconcileAdvancedIncomingRevision(
                docEntry, path, force, allowExistingConflicts, incomingRetry
            );
            if (latest !== undefined) return latest;
            if (safeDeletionSnapshot &&
                !(await this.currentStorageSnapshotMatches(safeDeletionSnapshot.file, safeDeletionSnapshot.revision))) {
                const protection = await this.recheckIncomingStorage(path, docEntry, undefined, allowExistingConflicts);
                if (protection.preserved) return true;
                if (!protection.snapshot ||
                    !(await this.currentStorageSnapshotMatches(protection.snapshot.file, protection.snapshot.revision))) {
                    return false;
                }
                safeDeletionSnapshot = protection.snapshot;
                latest = await this.reconcileAdvancedIncomingRevision(
                    docEntry, path, force, allowExistingConflicts, incomingRetry
                );
                if (latest !== undefined) return latest;
                if (!(await this.currentStorageSnapshotMatches(safeDeletionSnapshot.file, safeDeletionSnapshot.revision))) {
                    return false;
                }
            }
            // Deletion has been Transferred. Storage files will be deleted.
            // Note: If the folder becomes empty, the folder will be deleted if not configured to keep it.
            // And it does not care actually deleted.
            await this.storage.deleteVaultItem(path);
            await this.deleteProvenance(path);
            return true;
        }
        if (existDoc && existDoc.path !== path) {
            const [existingDocumentId, targetDocumentId] = await Promise.all([
                this.path.path2id(existDoc.path),
                this.path.path2id(path),
            ]);
            if (existingDocumentId !== targetDocumentId) {
                this._log(
                    `Refusing to overwrite ${existDoc.path} while applying the distinct path ${path}`,
                    LOG_LEVEL_NOTICE
                );
                return false;
            }
            if (getParentPath(existDoc.path) !== getParentPath(path)) {
                this._log(
                    `Refusing to apply a filename case change across differently cased parent directories: ${existDoc.path} -> ${path}`,
                    LOG_LEVEL_NOTICE
                );
                return false;
            }
            const renamedFile = await this.storage.renameFile(existDoc, path);
            if (!renamedFile) {
                this._log(`Could not apply the stored filename case: ${existDoc.path} -> ${path}`, LOG_LEVEL_NOTICE);
                return false;
            }
            await this.deleteProvenance(existDoc.path);
            existDoc = renamedFile;
        }
        // Okay, the file is exist on the database. Let's check the file is exist on the storage.
        const docRead = await this.db.fetchEntryFromMeta(docEntry);
        if (!docRead) {
            this._log(`File ${path} is not exist on the database`, LOG_LEVEL_VERBOSE);
            return false;
        }
        // If we want to process size mismatched files -- in case of having files created by some integrations, enable the toggle.
        if (!settings.processSizeMismatchedFiles) {
            // Check the file is not corrupted
            // (Zero is a special case, may be created by some APIs and it might be acceptable).
            if (docRead.size != 0 && docRead.size !== readAsBlob(docRead).size) {
                this._log(
                    `File ${path} seems to be corrupted! Writing prevented. (${docRead.size} != ${readAsBlob(docRead).size})`,
                    LOG_LEVEL_NOTICE
                );
                return false;
            }
        }

        const docData = readContent(docRead);

        if (allowExistingConflicts && existDoc && !force) {
            const readFile = await this.readFileFromStub(existDoc);
            if (await isDocContentSame(docData, readFile.body)) {
                await this.setProvenance(path, docEntry._rev, existDoc.stat.mtime);
                this.path.markChangesAreSame(docRead, docRead.mtime, existDoc.stat.mtime);
                return true;
            }
        }

        // The snapshot returned by preservation is only a candidate. Every
        // later await must revalidate it before an incoming write can overwrite
        // or delete the current storage bytes.
        let safeSnapshot: StorageSnapshot | undefined;
        if (existDoc && !force) {
            // The file is exist on the storage. Let's check the difference between the file and the entry.
            // But, if force is true, then it should be updated.
            // Ok, we have to compare.
            let shouldApplied = false;
            // 1. if the time stamp is far different, then it should be updated.
            // Note: This checks only the mtime with the resolution reduced to 2 seconds.
            //       2 seconds it for the ZIP file's mtime. If not, we cannot backup the vault as the ZIP file.
            //       This is hardcoded on `compareMtime` of `src/common/utils.ts`.
            const freshness = this.path.compareFileFreshness(existDoc, docEntry);
            if (freshness !== EVEN) {
                shouldApplied = true;
            }
            // 2. if not, the content should be checked.

            if (!shouldApplied) {
                const readFile = await this.readFileFromStub(existDoc);
                if (await isDocContentSame(docData, readFile.body)) {
                    // The content is same. So, we do not need to update the file.
                    shouldApplied = false;
                    // Timestamp is different but the content is same. therefore, two timestamps should be handled as same.
                    // So, mark the changes are same.
                    this.path.markChangesAreSame(docRead, docRead.mtime, existDoc.stat.mtime);
                } else {
                    shouldApplied = true;
                }
            }
            if (!shouldApplied) {
                await this.setProvenance(path, docEntry._rev, existDoc.stat.mtime);
                this._log(`File ${docRead.path} is not changed`, LOG_LEVEL_VERBOSE);
                return true;
            }
            if (!force && !settings.writeDocumentsIfConflicted) {
                let protection = await this.preserveUnsyncedStorageAsConflict(path, existDoc, docEntry, docData);
                if (protection.preserved) return true;
                if (!protection.snapshot) {
                    protection = await this.recheckIncomingStorage(path, docEntry, docData, allowExistingConflicts);
                    if (protection.preserved) return true;
                    if (!protection.snapshot) return false;
                }
                safeSnapshot = protection.snapshot;
            }
            // Let's apply the changes.
        } else {
            this._log(
                `File ${docRead.path} ${existDoc ? "(new) " : ""} ${force ? " (forced)" : ""}`,
                LOG_LEVEL_VERBOSE
            );
        }
        await this.storage.ensureDir(path);
        if (safeSnapshot && !(await this.currentStorageSnapshotMatches(safeSnapshot.file, safeSnapshot.revision))) {
            const protection = await this.recheckIncomingStorage(path, docEntry, docData, allowExistingConflicts);
            if (protection.preserved) return true;
            if (!protection.snapshot ||
                !(await this.currentStorageSnapshotMatches(protection.snapshot.file, protection.snapshot.revision))) {
                return false;
            }
            safeSnapshot = protection.snapshot;
        }
        const latest = await this.reconcileAdvancedIncomingRevision(
            docEntry, path, force, allowExistingConflicts, incomingRetry
        );
        if (latest !== undefined) return latest;
        if (safeSnapshot && !(await this.currentStorageSnapshotMatches(safeSnapshot.file, safeSnapshot.revision))) {
            return false;
        }
        const ret = await this.storage.writeFileAuto(path, docData, { ctime: docRead.ctime, mtime: docRead.mtime });
        await this.storage.touched(path);
        this.storage.triggerFileEvent(mode, path);
        if (ret && this.fileReflectionProvenance) {
            const storedStat = await this.storage.stat(path);
            // A host may update provenance outside the handler's document lock.
            // Preserve that newer branch identity. A plain user edit leaves the
            // record unchanged, so the written revision remains its correct base.
            if (safeSnapshot &&
                (await this.readProvenanceSnapshot(path)) !== safeSnapshot.revision) {
                return ret;
            }
            await this.setProvenance(path, docEntry._rev, storedStat?.mtime);
        }
        return ret;
    }

    /**
     * Preserve storage bytes before an incoming reflection can replace them.
     *
     * The initial read and provenance form one candidate snapshot. Classification
     * gives a recorded branch priority, deduplicates matching live leaves, or
     * creates an independent root for unknown origin. Optional `incomingContent` avoids
     * re-reading an already loaded incoming body. Storage is revalidated before
     * and after the database write; `preserved: true` stops the incoming write,
     * while a returned `snapshot` lets the caller continue only after revalidation.
     */
    private async preserveUnsyncedStorageAsConflict(
        path: FilePathWithPrefix,
        existDoc: UXFileInfoStub,
        incomingEntry: MetaEntry,
        incomingContent?: string | string[] | Blob | ArrayBuffer
    ): Promise<PreservationResult> {
        // Capture bytes and branch identity before classifying against database
        // revisions. A later storage change requires a fresh snapshot.
        const observedProvenance = await this.readProvenanceSnapshot(path);
        const readFile = await this.readFileFromStub(existDoc);
        const snapshot = { file: readFile, revision: observedProvenance };
        if (incomingContent && (await isDocContentSame(incomingContent, readFile.body))) {
            return await this.currentStorageSnapshotMatches(readFile, observedProvenance)
                ? { preserved: false, snapshot }
                : { preserved: false };
        }
        if (!incomingEntry._rev) {
            return { preserved: false };
        }
        const classification = await this.classifyStorageContent(
            readFile, incomingEntry, undefined, observedProvenance,
            incomingContent ? { _rev: incomingEntry._rev, data: incomingContent } : undefined
        );
        // Classification can await chunk reads or leaf discovery. Revalidate
        // before creating a branch so an edit during that wait is not lost.
        if (!(await this.currentStorageSnapshotMatches(readFile, observedProvenance))) {
            return { preserved: false };
        }
        if (classification.kind === "unchanged") {
            return { preserved: false, snapshot };
        }
        if (classification.kind === "matching-leaf") {
            await this.rememberMatchingLeaf(path, classification.revision, readFile.stat.mtime);
            await this.queueConflictCheckFor(path);
            return { preserved: true };
        }
        const storedRevision = classification.kind === "edited"
            ? await this.db.storeWithBaseRevision(readFile, classification.revision, true)
            : await this.db.storeIndependentRevision(readFile, true);
        if (storedRevision === false) {
            this._log(`Prevented overwriting unsynchronised local changes for ${path}`, LOG_LEVEL_NOTICE);
            return { preserved: true };
        }
        // Publish the new provenance only after the same storage snapshot has
        // survived the database write; otherwise the caller must reread it.
        if (!(await this.finaliseStoredRevision(readFile, observedProvenance, storedRevision))) {
            return { preserved: false };
        }
        this._log(`Preserved unsynchronised local changes as a conflict for ${path}`, LOG_LEVEL_NOTICE);
        await this.queueConflictCheckFor(path);
        return { preserved: true };
    }

    /**
     * Repeat overwrite protection from a fresh storage read after a snapshot
     * becomes stale. Existing conflicts may defer reflection and request an
     * open-only check while leaving the current storage untouched.
     */
    private async recheckIncomingStorage(
        path: FilePathWithPrefix,
        incomingEntry: MetaEntry,
        incomingContent: string | string[] | Blob | ArrayBuffer | undefined,
        allowExistingConflicts: boolean
    ): Promise<PreservationResult> {
        const current = await this.storage.getStub(path);
        if (!current || isFolderInfo(current)) return { preserved: false };
        const protection = await this.preserveUnsyncedStorageAsConflict(path, current, incomingEntry, incomingContent);
        if (protection.preserved || !protection.snapshot) return protection;
        if (!allowExistingConflicts && !this.setting.currentSettings().writeDocumentsIfConflicted &&
            (await this.db.getConflictedRevs(path)).length > 0) {
            await this.queueConflictCheckFor(path, true);
            return { preserved: true };
        }
        return protection;
    }

    /**
     * Re-read database metadata immediately before reflecting an incoming entry.
     * If the current revision advanced, recurse with fresh storage; force and
     * explicitly allowed conflict writes retain the caller's selected entry.
     * `incomingRetry` bounds repeated database churn.
     */
    private async reconcileAdvancedIncomingRevision(
        incomingEntry: MetaEntry,
        path: FilePathWithPrefix,
        force: boolean | undefined,
        allowExistingConflicts: boolean,
        incomingRetry: number
    ): Promise<boolean | undefined> {
        if (force || allowExistingConflicts) return undefined;
        // Protection above may await storage work, so the incoming metadata can
        // be stale even though it was current when this reflection began.
        const current = await this.db.fetchEntryMeta(path, undefined, true);
        if (!current) return false;
        if (current._rev === incomingEntry._rev) return undefined;
        if (incomingRetry >= 2) {
            this._log(`Database kept changing while reflecting ${path}`, LOG_LEVEL_NOTICE);
            return false;
        }
        const storage = await this.storage.getStub(path);
        if (isFolderInfo(storage)) return false;
        return await this.applyDatabaseEntryToStorage(current, storage, force, allowExistingConflicts, incomingRetry + 1);
    }

    private async _anyHandlerProcessesFileEvent(item: FileEventItem): Promise<boolean> {
        if (item.restoredFromPreviousRuntime) {
            return await this._processRestoredFileEvent(item);
        }
        // Ordinary watcher events use their captured event snapshot. Restored
        // events are persisted intentions and are reread and revalidated below.
        const eventItem = item.args;
        const type = item.type;
        const path = eventItem.file.path;
        if (type === "RENAME" && !eventItem.oldPath) {
            this._log(`Rename event for ${path} has no source path`, LOG_LEVEL_VERBOSE);
            return false;
        }
        const relatedPath = type === "RENAME" ? eventItem.oldPath : type === "DELETE" ? eventItem.renameTarget : undefined;
        const eventPaths = relatedPath === undefined ? [path] : [path, relatedPath as FilePathWithPrefix];
        return await this.serializedByFileEventPaths(eventPaths, async () => {
            if (!(await this.isCurrentPathSelected(path))) return false;
            switch (type) {
                case "CREATE":
                case "CHANGED":
                    return await this.storeFileToDBFromRevision(item.args.file);
                case "DELETE":
                    if (!(await this.canRecordStorageDeletion(item))) return true;
                    return await this.deleteFileFromDBCore(item.args.file);
                case "RENAME":
                    return await this.renameFileInDBCore(
                        item.args.file as UXFileInfoStub,
                        item.args.oldPath as FilePathWithPrefix
                    );
                case "INTERNAL":
                    // this should be handled on the other module.
                    return false;
                default:
                    this._log(`Unsupported event type: ${type as string}`, LOG_LEVEL_VERBOSE);
                    return false;
            }
        });
    }

    private async canRecordStorageDeletion(item: FileEventItem): Promise<boolean> {
        const path = item.args.file.path;
        try {
            const current = await this.storage.getStub(path);
            let excludedRenameTarget: UXFileInfoStub | null = null;
            if (item.args.renameTarget !== undefined) {
                const targetPath = item.args.renameTarget as FilePathWithPrefix;
                const targetItem = await this.storage.getStub(targetPath);
                const target = this.getExactCurrentFile(targetItem, targetPath);
                if (targetItem !== null && !target) {
                    this._log(`Preserved ${path}: the rename target no longer resolves to ${targetPath}`, LOG_LEVEL_NOTICE);
                    return false;
                }
                // A collision can temporarily reject a destination. Only selection
                // policy or a current size limit establishes a move out of scope.
                const targetIsSelected =
                    !shouldBeIgnored(targetPath) &&
                    (await this.vault.isTargetFile(targetPath, { skipCaseCollisionCheck: true })) &&
                    !(target && this.vault.isFileSizeTooLarge(target.stat.size));
                if (targetIsSelected) {
                    this._log(`Preserved ${path}: rename target ${targetPath} is still selected`, LOG_LEVEL_NOTICE);
                    return false;
                }
                excludedRenameTarget = target;
            }
            if (current === null) return true;
            if (!isFolderInfo(current)) {
                const [currentId, deletedId] = await Promise.all([
                    this.path.path2id(current.path),
                    this.path.path2id(path),
                ]);
                if (currentId !== deletedId) return true;
                // A deliberate case-only move out of selection removes the DB
                // entry, even though its excluded destination shares that ID.
                if (
                    excludedRenameTarget &&
                    this.storage.normalisePath(current.path) !== this.storage.normalisePath(path) &&
                    this.storage.normalisePath(current.path) === this.storage.normalisePath(excludedRenameTarget.path)
                ) {
                    return true;
                }
            }
            this._log(`Preserved ${path}: a current storage item contradicts its deletion event`, LOG_LEVEL_NOTICE);
            return false;
        } catch (ex) {
            this._log(`Could not validate deletion of ${path}; preserved the database entry`, LOG_LEVEL_NOTICE);
            this._log(ex, LOG_LEVEL_VERBOSE);
            return false;
        }
    }

    /**
     * Serialise work by every document ID represented by the supplied paths.
     * IDs are deduplicated and sorted so aliases take one lock and cross-document renames have one order.
     * The callback runs under those locks and must use core methods; conflict
     * hooks requested inside it are deferred until all locks have been released.
     */
    private async serializedByFileEventPaths<T>(
        eventPaths: readonly FilePathWithPrefix[],
        callback: (isSameDocument: boolean) => Promise<T>
    ): Promise<T> {
        const documentIds = await Promise.all(eventPaths.map((eventPath) => this.path.path2id(eventPath)));
        const uniqueIds = [...new Set(documentIds)].sort();
        const lockKeys = uniqueIds.map((documentId) => `processFileEvent-${documentId}`);
        const pending: DeferredConflictCheck[] = [];
        let result!: T;
        let failed = false;
        let failure: unknown;
        try {
            result = await serializedByKeys(lockKeys, async () => {
                for (const id of uniqueIds) this.deferredConflictChecks.set(id, pending);
                try {
                    return await callback(documentIds.length === 2 && documentIds[0] === documentIds[1]);
                } finally {
                    for (const id of uniqueIds) this.deferredConflictChecks.delete(id);
                }
            });
        } catch (ex) {
            failed = true;
            failure = ex;
        }
        // A conflict hook may synchronously await another operation on this
        // document. Invoke hooks only after every document lock is released;
        // the callback failure remains authoritative if a hook also fails.
        for (const check of pending) {
            try {
                if (check.ifOpen) await this.conflict.queueCheckForIfOpen(check.path);
                else await this.conflict.queueCheckFor(check.path);
            } catch (ex) {
                if (!failed) {
                    failed = true;
                    failure = ex;
                }
                break;
            }
        }
        if (failed) throw failure;
        return result;
    }

    /**
     * Queue a conflict hook while its document lock is held, or run it directly
     * when no matching lock is active. Preserve `ifOpen` across deferral.
     */
    private async queueConflictCheckFor(path: FilePathWithPrefix, ifOpen = false): Promise<void> {
        const documentId = await this.path.path2id(path);
        const pending = this.deferredConflictChecks.get(documentId);
        if (pending) {
            pending.push({ path, ifOpen });
            return;
        }
        if (ifOpen) await this.conflict.queueCheckForIfOpen(path);
        else await this.conflict.queueCheckFor(path);
    }

    /**
     * Revalidate a persisted storage operation against the current storage state.
     *
     * Snapshot entries preserve operation intent and ordering only. Their file
     * stub, timestamps, and existence assumptions can be stale after a restart.
     * Current inclusion is therefore read from storage, while destructive work
     * is allowed only after current absence has been observed. Store and rename
     * actions use the fresh reread with bounded retry because no later watcher
     * event is guaranteed after startup reconciliation.
     */
    private async _processRestoredFileEvent(item: FileEventItem): Promise<boolean> {
        const eventItem = item.args;
        const type = item.type;
        const path = eventItem.file.path;
        if (type === "RENAME" && !eventItem.oldPath) {
            this._log(`Rename event for ${path} has no source path`, LOG_LEVEL_VERBOSE);
            return true;
        }

        const relatedPath = type === "RENAME" ? eventItem.oldPath : type === "DELETE" ? eventItem.renameTarget : undefined;
        const eventPaths = relatedPath === undefined ? [path] : [path, relatedPath as FilePathWithPrefix];
        return await this.serializedByFileEventPaths(eventPaths, async (isSameDocument) => {
            let action: RestoredFileEventAction;
            try {
                action = await this._planRestoredFileEvent(item, isSameDocument);
            } catch (ex) {
                this.logRestoredEventValidationFailure(path, ex);
                return true;
            }

            switch (action.kind) {
                case "none":
                    return true;
                case "store":
                    return await this.storeFileToDBFromRevision(action.file, false, false, undefined, true);
                case "delete":
                    return await this.deleteFileFromDBCore(action.path);
                case "rename":
                    return await this.renameFileInDBCore(action.file, action.oldPath, true);
            }
        });
    }

    private async _planRestoredFileEvent(
        item: FileEventItem,
        isSameDocument: boolean
    ): Promise<RestoredFileEventAction> {
        const path = item.args.file.path;
        switch (item.type) {
            case "CREATE":
            case "CHANGED": {
                const current = this.getExactCurrentFile(await this.storage.getStub(path), path);
                return current && (await this.isCurrentFileSelected(current))
                    ? { kind: "store", file: current }
                    : { kind: "none" };
            }
            case "DELETE": {
                if (item.args.renameTarget !== undefined) {
                    return (await this.canRecordStorageDeletion(item)) && (await this.canApplyRestoredDeletion(path))
                        ? { kind: "delete", path: path as FilePath }
                        : { kind: "none" };
                }
                const current = await this.storage.getStub(path);
                return current === null && (await this.canApplyRestoredDeletion(path))
                    ? { kind: "delete", path: path as FilePath }
                    : { kind: "none" };
            }
            case "RENAME":
                return await this._planRestoredRename(path, item.args.oldPath as FilePathWithPrefix, isSameDocument);
            case "INTERNAL":
                return { kind: "none" };
            default:
                this._log(`Unsupported event type: ${item.type as string}`, LOG_LEVEL_VERBOSE);
                return { kind: "none" };
        }
    }

    private async _planRestoredRename(
        newPath: FilePathWithPrefix,
        oldPath: FilePathWithPrefix,
        isSameDocument: boolean
    ): Promise<RestoredFileEventAction> {
        if (isSameDocument) {
            const currentTarget = this.getExactCurrentFile(await this.storage.getStub(newPath), newPath);
            if (!currentTarget || !(await this.isCurrentFileSelected(currentTarget))) {
                return { kind: "none" };
            }
            return { kind: "rename", file: currentTarget, oldPath };
        }

        const currentTargetItem = await this.storage.getStub(newPath);
        let currentSourceItem: UXFileInfoStub | UXFolderInfo | null = null;
        let sourceWasInspected = true;
        try {
            currentSourceItem = await this.storage.getStub(oldPath);
        } catch (ex) {
            sourceWasInspected = false;
            this.logRestoredEventValidationFailure(oldPath, ex);
        }
        const currentTarget = this.getExactCurrentFile(currentTargetItem, newPath);
        if (currentTargetItem !== null) {
            if (!currentTarget || !(await this.isCurrentFileSelected(currentTarget))) {
                return { kind: "none" };
            }
            if (!sourceWasInspected || currentSourceItem !== null || !(await this.canApplyRestoredDeletion(oldPath))) {
                return { kind: "store", file: currentTarget };
            }
            return { kind: "rename", file: currentTarget, oldPath };
        }

        if (!sourceWasInspected || currentSourceItem !== null || !(await this.canApplyRestoredDeletion(oldPath))) {
            return { kind: "none" };
        }
        return { kind: "delete", path: oldPath as FilePath };
    }

    private getExactCurrentFile(
        current: UXFileInfoStub | UXFolderInfo | null,
        expectedPath: FilePathWithPrefix
    ): UXFileInfoStub | null {
        if (current === null || isFolderInfo(current)) {
            return null;
        }
        return this.storage.normalisePath(current.path) === this.storage.normalisePath(expectedPath) ? current : null;
    }

    private async isCurrentFileSelected(file: UXFileInfoStub): Promise<boolean> {
        if (!(await this.isCurrentPathSelected(file.path))) {
            return false;
        }
        if (this.vault.isFileSizeTooLarge(file.stat.size)) {
            this._log(`File ${file.path} exceeds the current maximum size`, LOG_LEVEL_VERBOSE);
            return false;
        }
        return true;
    }

    private async isCurrentPathSelected(path: FilePathWithPrefix): Promise<boolean> {
        if (!(await this.vault.isTargetFile(path))) {
            this._log(`File ${path} is not the target file`, LOG_LEVEL_VERBOSE);
            return false;
        }
        if (shouldBeIgnored(path)) {
            this._log(`File ${path} should be ignored`, LOG_LEVEL_VERBOSE);
            return false;
        }
        return true;
    }

    private async canApplyRestoredDeletion(path: FilePathWithPrefix): Promise<boolean> {
        try {
            return await this.isCurrentPathSelected(path);
        } catch (ex) {
            this.logRestoredEventValidationFailure(path, ex);
            return false;
        }
    }

    private logRestoredEventValidationFailure(path: FilePathWithPrefix, ex: unknown): void {
        this._log(
            `Could not validate the saved storage operation for ${path} against current storage; the Offline Scanner will reconcile the current state`,
            LOG_LEVEL_NOTICE
        );
        this._log(ex, LOG_LEVEL_VERBOSE);
    }

    async _anyProcessReplicatedDoc(entry: MetaEntry): Promise<boolean> {
        return await this.serializedByFileEventPaths([this.getPath(entry)], async () => {
            if (!(await this.vault.isTargetFile(entry.path))) {
                this._log(`File ${entry.path} is not the target file`, LOG_LEVEL_VERBOSE);
                return false;
            }
            if (this.vault.isFileSizeTooLarge(entry.size)) {
                this._log(`File ${entry.path} is too large (on database) to be processed`, LOG_LEVEL_VERBOSE);
                return false;
            }
            if (shouldBeIgnored(entry.path)) {
                this._log(`File ${entry.path} should be ignored`, LOG_LEVEL_VERBOSE);
                return false;
            }
            const path = this.getPath(entry);

            const targetFile = await this.storage.getStub(this.getPathWithoutPrefix(entry));
            if (isFolderInfo(targetFile)) {
                this._log(`${path} is already exist as the folder`);
                // Nothing to do and other modules should also nothing to do.
                return true;
            } else {
                if (targetFile && this.vault.isFileSizeTooLarge(targetFile.stat.size)) {
                    this._log(`File ${targetFile.path} is too large (on storage) to be processed`, LOG_LEVEL_VERBOSE);
                    return false;
                }
                this._log(
                    `Processing ${path} (${entry._id.substring(0, 8)} :${entry._rev?.substring(0, 5)}) : Started...`,
                    LOG_LEVEL_VERBOSE
                );
                // Before writing (or skipped ), merging dialogue should be cancelled.
                this.events.emitEvent(EVENT_CONFLICT_CANCELLED, path);
                const ret = await this.dbToStorageCore(entry, targetFile);
                this._log(`Processing ${path} (${entry._id.substring(0, 8)} :${entry._rev?.substring(0, 5)}) : Done`);
                return ret;
            }
        });
    }

    async createAllChunks(showingNotice?: boolean): Promise<void> {
        this._log("Collecting local files on the storage", LOG_LEVEL_VERBOSE);
        const semaphore = Semaphore(10);

        let processed = 0;
        const filesStorageSrc = await this.storage.getFiles();
        const incProcessed = () => {
            processed++;
            if (processed % 25 == 0)
                this._log(
                    `Creating missing chunks: ${processed} of ${total} files`,
                    showingNotice ? LOG_LEVEL_NOTICE : LOG_LEVEL_INFO,
                    "chunkCreation"
                );
        };
        const total = filesStorageSrc.length;
        const procAllChunks = filesStorageSrc.map(async (file) => {
            if (!(await this.vault.isTargetFile(file))) {
                incProcessed();
                return true;
            }
            if (this.vault.isFileSizeTooLarge(file.stat.size)) {
                incProcessed();
                return true;
            }
            if (shouldBeIgnored(file.path)) {
                incProcessed();
                return true;
            }
            const release = await semaphore.acquire();
            incProcessed();
            try {
                await this.storeFileToDB(file, false, true);
            } catch (ex) {
                this._log(ex, LOG_LEVEL_VERBOSE);
            } finally {
                release();
            }
        });
        await Promise.all(procAllChunks);
        this._log(
            `Creating chunks Done: ${processed} of ${total} files`,
            showingNotice ? LOG_LEVEL_NOTICE : LOG_LEVEL_INFO,
            "chunkCreation"
        );
    }
}
