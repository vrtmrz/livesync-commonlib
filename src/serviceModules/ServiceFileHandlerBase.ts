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
    createBlob,
    getDocDataAsArray,
    isDocContentSame,
    isTextBlob,
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

async function isIncomingTextClearExtension(
    incomingContent: string | string[] | Blob | ArrayBuffer,
    localContent: string | string[] | Blob | ArrayBuffer
): Promise<boolean> {
    const incomingBlob = createBlob(incomingContent);
    const localBlob = createBlob(localContent);
    if (!isTextBlob(incomingBlob) || !isTextBlob(localBlob)) {
        return false;
    }
    const incomingText = await incomingBlob.text();
    const localText = await localBlob.text();
    return incomingText.startsWith(localText) || incomingText.endsWith(localText);
}

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
        return await this.storeFileToDBFromRevision(info, force, onlyChunks);
    }

    private async storeFileToDBFromRevision(
        info: UXFileInfoStub | UXFileInfo | UXInternalFileInfoStub | FilePathWithPrefix,
        force: boolean = false,
        onlyChunks: boolean = false,
        preferredBasePath?: FilePathWithPrefix
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

        const readFile = await this.readFileFromStub(file);
        // First, check the file on the database
        const entry = await this.db.fetchEntry(file, undefined, true, true);
        const conflictedRevs = await this.db.getConflictedRevs(file);
        const isConflicted = conflictedRevs.length > 0;

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
                await this.conflict.queueCheckFor(file.path);
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
                await this.conflict.queueCheckFor(file.path);
                return false;
            }
            const storedRevision = await this.db.storeAsConflictedRevisionWithResult(readFile, currentRevision, true);
            if (storedRevision === false) {
                this._log(`Could not preserve the unknown conflict branch for ${file.path}`, LOG_LEVEL_NOTICE);
                await this.conflict.queueCheckFor(file.path);
                return false;
            }
            if (preferredBasePath && preferredBasePath !== file.path) {
                await this.deleteProvenance(preferredBasePath);
            }
            await this.setProvenance(file.path, storedRevision, readFile.stat.mtime);
            await this.conflict.queueCheckFor(file.path);
            return true;
        }

        if (!entry || entry.deleted || entry._deleted) {
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
        if (!force && !onlyChunks) {
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
        const storedRevision = await this.db.storeWithBaseRevision(readFile, entry._rev, true);
        if (storedRevision === false) return false;
        if (preferredBasePath && preferredBasePath !== file.path) {
            await this.deleteProvenance(preferredBasePath);
        }
        await this.setProvenance(file.path, storedRevision, readFile.stat.mtime);
        return true;
    }

    async deleteFileFromDB(info: UXFileInfoStub | UXInternalFileInfoStub | FilePath): Promise<boolean> {
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
                    await this.conflict.queueCheckFor(path);
                    return true;
                }
                const storedRevision = await this.db.storeDeletionWithBaseRevision(path, provenance.revision);
                if (storedRevision === false) return false;
                await this.deleteProvenance(path);
                await this.conflict.queueCheckFor(path);
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
                await this.conflict.queueCheckFor(file.path);
                return true;
            }
            const storedRevision = await this.db.storeDeletionWithBaseRevision(file.path, baseRevision);
            if (storedRevision === false) return false;
            await this.deleteProvenance(file.path);
            await this.conflict.queueCheckFor(file.path);
            return true;
        }
        // Otherwise, the file should be deleted simply. This is the previous behaviour.
        const deleted = await this.db.delete(file);
        if (deleted) await this.deleteProvenance(file.path);
        return deleted;
    }

    async renameFileInDB(info: UXFileInfoStub | UXFileInfo, oldPath: FilePath | FilePathWithPrefix): Promise<boolean> {
        const newPath = getStoragePathFromUXFileInfo(info);
        const [oldDocumentId, newDocumentId] = await Promise.all([
            this.path.path2id(oldPath),
            this.path.path2id(newPath),
        ]);

        if (oldDocumentId === newDocumentId) {
            this._log(`Updating the stored path for case-only rename: ${oldPath} -> ${newPath}`, LOG_LEVEL_VERBOSE);
            return await this.storeFileToDBFromRevision(info, true, false, oldPath as FilePathWithPrefix);
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
        if (!(await this.storeFileToDB(info, true))) {
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
                await this.conflict.queueCheckFor(oldPath as FilePathWithPrefix);
                return true;
            }
            const storedRevision = await this.db.storeDeletionWithBaseRevision(
                oldPath as FilePathWithPrefix,
                baseRevision
            );
            if (storedRevision === false) return false;
            await this.deleteProvenance(oldPath as FilePathWithPrefix);
            await this.conflict.queueCheckFor(oldPath as FilePathWithPrefix);
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
        //TODO: Possibly check the conflicting.
        return await this.db.delete(info, rev);
    }

    async resolveConflictedByDeletingRevision(
        info: UXFileInfoStub | FilePath,
        rev: string
    ): Promise<boolean | undefined> {
        const path = getStoragePathFromUXFileInfo(info);
        if (!(await this.deleteRevisionFromDB(info, rev))) {
            this._log(`Failed to delete the conflicted revision ${rev} of ${path}`, LOG_LEVEL_VERBOSE);
            return false;
        }
        if (!(await this.dbToStorageWithSpecificRev(info, rev, true))) {
            this._log(`Failed to apply the resolved revision ${rev} of ${path} to the storage`, LOG_LEVEL_VERBOSE);
            return false;
        }
    }

    async dbToStorageWithSpecificRev(
        info: UXFileInfoStub | UXFileInfo | FilePath | null,
        rev: string,
        force?: boolean
    ): Promise<boolean> {
        const file = await this.infoToStub(info);
        if (file == null) {
            this._log(`File ${tryGetFilePath(info)} is not exist on the storage`, LOG_LEVEL_VERBOSE);
            return false;
        }
        const docEntry = await this.db.fetchEntryMeta(file, rev, true);
        if (!docEntry) {
            this._log(`File ${file.path} is not exist on the database`, LOG_LEVEL_VERBOSE);
            return false;
        }
        return await this.applyDatabaseEntryToStorage(docEntry, file, force);
    }

    async dbToStorage(
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

    private async applyDatabaseEntryToStorage(
        docEntry: MetaEntry,
        file: UXFileInfoStub | UXFileInfo | null,
        force?: boolean
    ): Promise<boolean> {
        const mode = file == null ? "create" : "modify";
        const path = this.getPath(docEntry);
        const settings = this.setting.currentSettings();
        // 1. Check if it already conflicted.
        const revs = await this.db.getConflictedRevs(path);
        if (revs.length > 0) {
            // Some conflicts are exist.
            if (settings.writeDocumentsIfConflicted) {
                // If configured to write the document even if conflicted, then it should be written.
                // NO OP
            } else {
                // If not, then it should be checked. and will be processed later (i.e., after the conflict is resolved).
                await this.conflict.queueCheckForIfOpen(path);
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
            if (
                !force &&
                !settings.writeDocumentsIfConflicted &&
                (await this.preserveUnsyncedStorageAsConflict(path, existDoc, docEntry))
            ) {
                return true;
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
            if (
                !force &&
                !settings.writeDocumentsIfConflicted &&
                (await this.preserveUnsyncedStorageAsConflict(path, existDoc, docEntry, docData))
            ) {
                return true;
            }
            // Let's apply the changes.
        } else {
            this._log(
                `File ${docRead.path} ${existDoc ? "(new) " : ""} ${force ? " (forced)" : ""}`,
                LOG_LEVEL_VERBOSE
            );
        }
        await this.storage.ensureDir(path);
        const ret = await this.storage.writeFileAuto(path, docData, { ctime: docRead.ctime, mtime: docRead.mtime });
        await this.storage.touched(path);
        this.storage.triggerFileEvent(mode, path);
        if (ret && this.fileReflectionProvenance) {
            const storedStat = await this.storage.stat(path);
            await this.setProvenance(path, docEntry._rev, storedStat?.mtime);
        }
        return ret;
    }

    private async preserveUnsyncedStorageAsConflict(
        path: FilePathWithPrefix,
        existDoc: UXFileInfoStub,
        incomingEntry: MetaEntry,
        incomingContent?: string | string[] | Blob | ArrayBuffer
    ): Promise<boolean> {
        const readFile = await this.readFileFromStub(existDoc);
        if (incomingContent && (await isDocContentSame(incomingContent, readFile.body))) {
            return false;
        }
        if (incomingContent && (await isIncomingTextClearExtension(incomingContent, readFile.body))) {
            return false;
        }
        if (!incomingEntry._rev) {
            return false;
        }
        if (await this.db.hasContentInRevisionHistory(path, readFile.body, incomingEntry._rev)) {
            return false;
        }
        const storedRevision = await this.db.storeAsConflictedRevisionWithResult(readFile, incomingEntry._rev, true);
        if (storedRevision === false) {
            this._log(`Prevented overwriting unsynchronised local changes for ${path}`, LOG_LEVEL_NOTICE);
            return true;
        }
        await this.setProvenance(path, storedRevision, readFile.stat.mtime);
        this._log(`Preserved unsynchronised local changes as a conflict for ${path}`, LOG_LEVEL_NOTICE);
        await this.conflict.queueCheckFor(path);
        return true;
    }

    private async _anyHandlerProcessesFileEvent(item: FileEventItem): Promise<boolean> {
        const eventItem = item.args;
        const type = item.type;
        const path = eventItem.file.path;
        if (!(await this.vault.isTargetFile(path))) {
            this._log(`File ${path} is not the target file`, LOG_LEVEL_VERBOSE);
            return false;
        }
        if (shouldBeIgnored(path)) {
            this._log(`File ${path} should be ignored`, LOG_LEVEL_VERBOSE);
            return false;
        }
        if (type === "RENAME" && !eventItem.oldPath) {
            this._log(`Rename event for ${path} has no source path`, LOG_LEVEL_VERBOSE);
            return false;
        }
        const eventPaths = type === "RENAME" ? [path, eventItem.oldPath as FilePathWithPrefix] : [path];
        const documentIds = await Promise.all(eventPaths.map((eventPath) => this.path.path2id(eventPath)));
        const lockKeys = [...new Set(documentIds)].sort().map((documentId) => `processFileEvent-${documentId}`);
        return await serializedByKeys(lockKeys, async () => {
            switch (type) {
                case "CREATE":
                case "CHANGED":
                    return await this.storeFileToDB(item.args.file);
                case "DELETE":
                    return await this.deleteFileFromDB(item.args.file);
                case "RENAME":
                    return await this.renameFileInDB(
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

    async _anyProcessReplicatedDoc(entry: MetaEntry): Promise<boolean> {
        return await serialized(`processReplicatedDoc-${entry._id}`, async () => {
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
                const ret = await this.dbToStorage(entry, targetFile);
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
