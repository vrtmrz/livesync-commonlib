import type {
    UXFileInfoStub,
    FilePathWithPrefix,
    UXFileInfo,
    DocumentID,
    SavingEntry,
    MetaEntry,
    LoadedEntry,
    FilePath,
} from "@lib/common/types";
import type { DatabaseFileAccess } from "@lib/interfaces/DatabaseFileAccess";
import type { StorageAccess } from "@lib/interfaces/StorageAccess";
import type { APIService } from "@lib/services/base/APIService";
import type { DatabaseService } from "@lib/services/base/DatabaseService";
import type { PathService } from "@lib/services/base/PathService";
import type { VaultService } from "@lib/services/base/VaultService";
import { shouldBeIgnored, isPlainText, stripAllPrefixes } from "@lib/string_and_binary/path";
import { LOG_LEVEL_VERBOSE } from "octagonal-wheels/common/logger";
import { serialized } from "octagonal-wheels/concurrency/lock_v2";
import { ServiceModuleBase } from "@lib/serviceModules/ServiceModuleBase";
import type { LiveSyncEventHub } from "@lib/hub/hub";
import { EVENT_FILE_SAVED } from "@lib/events/coreEvents";
import { getDatabasePathFromUXFileInfo, getStoragePathFromUXFileInfo, isInternalMetadata } from "@lib/common/typeUtils";
import { createBlob, createTextBlob, determineTypeFromBlob, isDocContentSame, readContent } from "@lib/common/utils";
import { ICHeader } from "@lib/common/models/fileaccess.const";

export interface ServiceDatabaseFileAccessDependencies {
    events: LiveSyncEventHub;
    API: APIService;
    vault: VaultService;
    storageAccess: StorageAccess;
    path: PathService;
    database: DatabaseService;
}

/** Metadata write policy; chunk-only repairs do not create a document revision. */
type StoreRevisionTarget =
    /** Keep the ordinary content comparison and current-winner write policy. */
    | { mode: "default" }
    /** Always write below the supplied revision, including an ancestor; undefined retains the legacy winner policy. */
    | { mode: "force-base"; baseRevision: string | undefined }
    /** Advance only the specified live leaf; return false if another write has already advanced it. */
    | { mode: "live-base"; baseRevision: string }
    /** Import a fresh root under the same document ID without inferring any parent. */
    | { mode: "independent-root" };

export class ServiceDatabaseFileAccessBase
    extends ServiceModuleBase<ServiceDatabaseFileAccessDependencies>
    implements DatabaseFileAccess
{
    private events: LiveSyncEventHub;
    private vault: VaultService;
    private storageAccess: StorageAccess;
    private path: PathService;
    private database: DatabaseService;
    constructor(services: ServiceDatabaseFileAccessDependencies) {
        super(services);
        this.events = services.events;
        this.vault = services.vault;
        this.storageAccess = services.storageAccess;
        this.database = services.database;
        this.path = services.path;
    }

    async checkIsTargetFile(file: UXFileInfoStub | FilePathWithPrefix): Promise<boolean> {
        const path = getStoragePathFromUXFileInfo(file);
        if (!(await this.vault.isTargetFile(path))) {
            this._log(`File is not target: ${path}`, LOG_LEVEL_VERBOSE);
            return false;
        }
        if (shouldBeIgnored(path)) {
            this._log(`File should be ignored: ${path}`, LOG_LEVEL_VERBOSE);
            return false;
        }
        return true;
    }

    async delete(file: UXFileInfoStub | FilePathWithPrefix, rev?: string): Promise<boolean> {
        if (!(await this.checkIsTargetFile(file))) {
            return true;
        }
        const fullPath = getDatabasePathFromUXFileInfo(file);
        try {
            this._log(`deleteDB By path:${fullPath}`);
            return await this.deleteFromDBbyPath(fullPath, rev);
        } catch (ex) {
            this._log(`Failed to delete ${fullPath}`);
            this._log(ex, LOG_LEVEL_VERBOSE);
            return false;
        }
    }

    async createChunks(file: UXFileInfo, force: boolean = false, skipCheck?: boolean): Promise<boolean> {
        return (await this.__store(file, force, skipCheck, true)) !== false;
    }

    async store(file: UXFileInfo, force: boolean = false, skipCheck?: boolean): Promise<boolean> {
        return (await this.__store(file, force, skipCheck, false)) !== false;
    }
    /** Force a child below the supplied base, even if advanced; an undefined base uses the winner. */
    async storeWithBaseRevision(
        file: UXFileInfo,
        baseRevision: string | undefined,
        skipCheck?: boolean
    ): Promise<string | false> {
        const result = await this.__store(file, true, skipCheck, false, {
            mode: "force-base",
            baseRevision,
        });
        return result !== null && typeof result === "object" && "rev" in result ? result.rev : false;
    }
    /** Extend a current leaf with ordinary MVCC; an advanced base returns `false`. */
    async storeWithLiveBaseRevision(
        file: UXFileInfo,
        baseRevision: string,
        skipCheck?: boolean
    ): Promise<string | false> {
        const result = await this.__store(file, true, skipCheck, false, {
            mode: "live-base",
            baseRevision,
        });
        return result !== null && typeof result === "object" && "rev" in result ? result.rev : false;
    }
    /**
     * Store Chunks and a fresh Metadata root for content with unknown ancestry.
     * Return its exact revision for provenance, or `false` if no Metadata write succeeded.
     */
    async storeIndependentRevision(file: UXFileInfo, skipCheck?: boolean): Promise<string | false> {
        const result = await this.__store(file, true, skipCheck, false, { mode: "independent-root" });
        return result !== null && typeof result === "object" && "rev" in result ? result.rev : false;
    }
    async storeAsConflictedRevision(file: UXFileInfo, currentRev: string, skipCheck?: boolean): Promise<boolean> {
        return (await this.storeAsConflictedRevisionWithResult(file, currentRev, skipCheck)) !== false;
    }
    /** Create a sibling of the selected revision; refuse when its parent cannot be found. */
    async storeAsConflictedRevisionWithResult(
        file: UXFileInfo,
        currentRev: string,
        skipCheck?: boolean
    ): Promise<string | false> {
        const conflictBaseRev = await this.getParentRev(file, currentRev);
        if (!conflictBaseRev) {
            this._log(`Could not find parent revision for ${file.path} (${currentRev})`, LOG_LEVEL_VERBOSE);
            return false;
        }
        return await this.storeWithBaseRevision(file, conflictBaseRev, skipCheck);
    }
    /** Record a logical deletion below the displayed branch and return its exact revision. */
    async storeDeletionWithBaseRevision(
        file: UXFileInfoStub | FilePathWithPrefix,
        baseRevision: string
    ): Promise<string | false> {
        if (!(await this.checkIsTargetFile(file))) {
            return false;
        }
        const fullPath = getDatabasePathFromUXFileInfo(file);
        const result = await this.database.localDatabase.storeDeletionAtRevision(fullPath, baseRevision);
        if (result === false) {
            return false;
        }
        this.events.emitEvent(EVENT_FILE_SAVED);
        return result.rev;
    }
    async storeContent(path: FilePathWithPrefix, content: string): Promise<boolean> {
        const blob = createTextBlob(content);
        const bytes = (await blob.arrayBuffer()).byteLength;
        const isInternal = path.startsWith(".") ? true : undefined;
        const dummyUXFileInfo: UXFileInfo = {
            name: path.split("/").pop() as string,
            path: path,
            stat: {
                size: bytes,
                ctime: Date.now(),
                mtime: Date.now(),
                type: "file",
            },
            body: blob,
            isInternal,
        };
        return (await this.__store(dummyUXFileInfo, true, false, false)) !== false;
    }

    private async __store(
        file: UXFileInfo,
        force: boolean = false,
        skipCheck?: boolean,
        onlyChunks?: boolean,
        revisionTarget: StoreRevisionTarget = { mode: "default" }
    ): Promise<true | false | PouchDB.Core.Response> {
        if (!skipCheck) {
            if (!(await this.checkIsTargetFile(file))) {
                return true;
            }
        }
        if (!file) {
            this._log("File seems bad", LOG_LEVEL_VERBOSE);
            return false;
        }
        // const path = getPathFromUXFileInfo(file);
        const isPlain = isPlainText(file.name);
        const possiblyLarge = !isPlain;
        const content = file.body;

        const datatype = determineTypeFromBlob(content);
        const idPrefix = file.isInternal ? ICHeader : "";
        const fullPath = getStoragePathFromUXFileInfo(file);
        const fullPathOnDB = getDatabasePathFromUXFileInfo(file);

        if (possiblyLarge) this._log(`Processing: ${fullPath}`, LOG_LEVEL_VERBOSE);

        // if (isInternalMetadata(fullPath)) {
        //     this._log(`Internal file: ${fullPath}`, LOG_LEVEL_VERBOSE);
        //     return false;
        // }
        if (file.isInternal) {
            if (file.deleted) {
                file.stat = {
                    size: 0,
                    ctime: Date.now(),
                    mtime: Date.now(),
                    type: "file",
                };
            } else if (file.stat == undefined) {
                const stat = await this.storageAccess.statHidden(file.path);
                if (!stat) {
                    // We stored actually deleted or not since here, so this is an unexpected case. we should raise an error.
                    this._log(`Internal file not found: ${fullPath}`, LOG_LEVEL_VERBOSE);
                    return false;
                }
                file.stat = stat;
            }
        }

        const idMain = await this.path.path2id(fullPath);

        const id = (idPrefix + idMain) as DocumentID;
        const d: SavingEntry = {
            _id: id,
            path: fullPathOnDB,
            data: content,
            ctime: file.stat.ctime,
            mtime: file.stat.mtime,
            size: file.stat.size,
            children: [],
            datatype: datatype,
            type: datatype,
            eden: {},
        };
        //upsert should locked
        const msg = `STORAGE -> DB (${datatype}) `;
        const isNotChanged = await serialized("file-" + fullPath, async () => {
            if (revisionTarget.mode !== "default") {
                // Equality with the winner cannot cancel an explicit branch write:
                // the selected parent, or the absence of a parent, is part of its intent.
                return false;
            }
            if (force) {
                this._log(msg + "Force writing " + fullPath, LOG_LEVEL_VERBOSE);
                return false;
            }
            // Commented out temporarily: this checks that the file was made ourself.
            // if (this.core.storageAccess.recentlyTouched(file)) {
            //     return true;
            // }
            try {
                const old = await this.database.localDatabase.getDBEntry(d.path, undefined, false, true, false);
                if (old !== false) {
                    const oldData = { data: old.data, deleted: old._deleted || old.deleted };
                    const newData = { data: d.data, deleted: d._deleted || d.deleted };
                    if (oldData.deleted != newData.deleted) return false;
                    if (!(await isDocContentSame(old.data, newData.data))) return false;
                    this._log(
                        msg + "Skipped (not changed) " + fullPath + (d._deleted || d.deleted ? " (deleted)" : ""),
                        LOG_LEVEL_VERBOSE
                    );
                    this.path.markChangesAreSame(old, d.mtime, old.mtime);
                    return true;
                    // d._rev = old._rev;
                }
            } catch (ex) {
                this._log(
                    msg +
                        "Error, Could not check the diff for the old one." +
                        (force ? "force writing." : "") +
                        fullPath +
                        (d._deleted || d.deleted ? " (deleted)" : ""),
                    LOG_LEVEL_VERBOSE
                );
                this._log(ex, LOG_LEVEL_VERBOSE);
                return !force;
            }
            return false;
        });
        if (isNotChanged) {
            this._log(msg + " Skip " + fullPath, LOG_LEVEL_VERBOSE);
            return true;
        }
        const ret: false | PouchDB.Core.Response =
            revisionTarget.mode === "independent-root"
                ? await this.database.localDatabase.putDBEntryAsIndependentRoot(d)
                : revisionTarget.mode === "live-base"
                ? await this.database.localDatabase.putDBEntryWithLiveBaseRevision(
                      d,
                      revisionTarget.baseRevision,
                      onlyChunks
                  )
                : await this.database.localDatabase.putDBEntry(
                      d,
                      onlyChunks,
                      revisionTarget.mode === "force-base" ? revisionTarget.baseRevision : undefined
                  );
        if (ret !== false) {
            this._log(msg + fullPath);
            this.events.emitEvent(EVENT_FILE_SAVED);
        }
        return ret;
    }

    /** Reconstruct the immediate parent ID from revision history, or return `false` if unavailable. */
    private async getParentRev(file: UXFileInfoStub | FilePathWithPrefix, rev: string): Promise<string | false> {
        const filename = getDatabasePathFromUXFileInfo(file);
        try {
            const doc = await this.database.localDatabase.getDBEntryMeta(filename, { rev, revs: true }, true);
            if (doc === false) {
                return false;
            }
            const revisions = (doc as { _revisions?: { start: number; ids: string[] } })._revisions;
            if (!revisions || revisions.ids.length < 2) {
                return false;
            }
            return `${revisions.start - 1}-${revisions.ids[1]}`;
        } catch (ex) {
            this._log(`Could not read revision history for ${filename} (${rev})`, LOG_LEVEL_VERBOSE);
            this._log(ex, LOG_LEVEL_VERBOSE);
            return false;
        }
    }

    /**
     * Search available revision bodies across branches and their ancestors.
     * `stopAfterFirstMatch` serves existence checks without decoding the remaining candidates.
     * Historical matches alone do not establish the origin of current storage content.
     */
    private async findContentRevisionsInternal(
        file: UXFileInfoStub | FilePathWithPrefix,
        content: string | string[] | Blob | ArrayBuffer,
        currentRev?: string,
        stopAfterFirstMatch = false
    ): Promise<string[]> {
        const filename = getDatabasePathFromUXFileInfo(file);
        try {
            const doc = await this.database.localDatabase.getDBEntryMeta(
                filename,
                { rev: currentRev, revs_info: true },
                true
            );
            if (doc === false) {
                return [];
            }
            const revisions = (doc as LoadedEntry & { _revs_info?: { rev: string; status: string }[] })._revs_info;
            const availableRevs = new Set((revisions || []).filter((e) => e.status === "available").map((e) => e.rev));
            if (currentRev) {
                availableRevs.add(currentRev);
            }
            type OpenRevision = { ok?: { _rev?: string } };
            const leaves = (await this.database.localDatabase.getRaw(doc._id, {
                open_revs: "all",
            } as unknown as PouchDB.Core.GetOptions)) as unknown as OpenRevision[];
            if (!Array.isArray(leaves)) {
                return [];
            }
            for (const leaf of leaves) {
                const leafRev = leaf.ok?._rev;
                if (!leafRev) {
                    continue;
                }
                const branch = await this.database.localDatabase.getDBEntryMeta(
                    filename,
                    { rev: leafRev, revs_info: true },
                    true
                );
                if (branch === false) {
                    continue;
                }
                const branchRevisions = (branch as LoadedEntry & { _revs_info?: { rev: string; status: string }[] })
                    ._revs_info;
                for (const revision of branchRevisions || []) {
                    if (revision.status === "available") {
                        availableRevs.add(revision.rev);
                    }
                }
            }
            const matchingRevisions: string[] = [];
            for (const rev of availableRevs) {
                const entry = await this.database.localDatabase.getDBEntry(filename, { rev }, false, true, true);
                if (entry !== false && !entry._deleted && (await isDocContentSame(readContent(entry), content))) {
                    matchingRevisions.push(rev);
                    if (stopAfterFirstMatch) {
                        return matchingRevisions;
                    }
                }
            }
            return matchingRevisions;
        } catch (ex) {
            this._log(`Could not check revision history for ${filename}`, LOG_LEVEL_VERBOSE);
            this._log(ex, LOG_LEVEL_VERBOSE);
        }
        return [];
    }

    /** Find matching content throughout available history, including non-leaf revisions. */
    async findContentRevisions(
        file: UXFileInfoStub | FilePathWithPrefix,
        content: string | string[] | Blob | ArrayBuffer,
        currentRev?: string
    ): Promise<string[]> {
        if (!(await this.checkIsTargetFile(file))) {
            return [];
        }
        return await this.findContentRevisionsInternal(file, content, currentRev);
    }

    /**
     * Find live leaves which already represent these bytes, for deduplication when provenance
     * is unknown. `open_revs` includes conflicting branches; both deletion markers are excluded.
     * Unlike the historical search, ancestors cannot match and missing Chunks are not fetched.
     * A read failure yields no confirmed match. Callers decide whether the result identifies a
     * unique origin; this method does not mutate provenance or hold the revision tree stable.
     */
    async findLiveContentRevisions(
        file: UXFileInfoStub | FilePathWithPrefix,
        content: string | string[] | Blob | ArrayBuffer
    ): Promise<string[]> {
        if (!(await this.checkIsTargetFile(file))) return [];
        const filename = getDatabasePathFromUXFileInfo(file);
        try {
            const current = await this.database.localDatabase.getDBEntryMeta(filename, undefined, true);
            if (current === false) return [];
            type OpenRevision = { ok?: { _rev?: string; deleted?: boolean; _deleted?: boolean } };
            const leaves = (await this.database.localDatabase.getRaw(current._id, {
                open_revs: "all",
            } as PouchDB.Core.GetOptions)) as unknown as OpenRevision[];
            if (!Array.isArray(leaves)) return [];
            const matches: string[] = [];
            for (const leaf of leaves) {
                const rev = leaf.ok?._rev;
                if (!rev || leaf.ok?.deleted || leaf.ok?._deleted) continue;
                // The final argument makes this a local-only comparison, even with waitForReady set.
                const entry = await this.database.localDatabase.getDBEntry(filename, { rev }, false, true, true, true);
                if (entry !== false && !entry.deleted && !entry._deleted &&
                    await isDocContentSame(readContent(entry), content)) {
                    matches.push(rev);
                }
            }
            return matches;
        } catch (ex) {
            // A changing revision tree or unavailable chunk leaves the base
            // unknown; it never proves that a local file was unchanged.
            this._log(`Could not check live revision content for ${filename}`, LOG_LEVEL_VERBOSE);
            this._log(ex, LOG_LEVEL_VERBOSE);
            return [];
        }
    }

    async hasContentInRevisionHistory(
        file: UXFileInfoStub | FilePathWithPrefix,
        content: string | string[] | Blob | ArrayBuffer,
        currentRev?: string
    ): Promise<boolean> {
        if (!(await this.checkIsTargetFile(file))) {
            return true;
        }
        return (await this.findContentRevisionsInternal(file, content, currentRev, true)).length > 0;
    }

    async getConflictedRevs(file: UXFileInfoStub | FilePathWithPrefix): Promise<string[]> {
        if (!(await this.checkIsTargetFile(file))) {
            return [];
        }
        const filename = getDatabasePathFromUXFileInfo(file);
        const doc = await this.database.localDatabase.getDBEntryMeta(filename, { conflicts: true }, true);
        if (doc === false) {
            return [];
        }
        return doc._conflicts || [];
    }

    async fetch(
        file: UXFileInfoStub | FilePathWithPrefix,
        rev?: string,
        waitForReady?: boolean,
        skipCheck = false
    ): Promise<UXFileInfo | false> {
        if (skipCheck && !(await this.checkIsTargetFile(file))) {
            return false;
        }

        const entry = await this.fetchEntry(file, rev, waitForReady, true);
        if (entry === false) {
            return false;
        }
        const data = createBlob(readContent(entry));
        const path = stripAllPrefixes(entry.path);
        const fileInfo: UXFileInfo = {
            name: path.split("/").pop() as string,
            path: path,
            stat: {
                size: entry.size,
                ctime: entry.ctime,
                mtime: entry.mtime,
                type: "file",
            },
            body: data,
            deleted: entry.deleted || entry._deleted,
        };
        if (isInternalMetadata(entry.path)) {
            fileInfo.isInternal = true;
        }
        return fileInfo;
    }
    async fetchEntryMeta(
        file: UXFileInfoStub | FilePathWithPrefix,
        rev?: string,
        skipCheck = false
    ): Promise<MetaEntry | false> {
        const dbFileName = getDatabasePathFromUXFileInfo(file);
        if (skipCheck && !(await this.checkIsTargetFile(file))) {
            return false;
        }

        const doc = await this.database.localDatabase.getDBEntryMeta(dbFileName, rev ? { rev: rev } : undefined, true);
        if (doc === false) {
            return false;
        }
        return doc as MetaEntry;
    }
    async fetchEntryFromMeta(
        meta: MetaEntry,
        waitForReady: boolean = true,
        skipCheck = false,
        localOnly = false
    ): Promise<LoadedEntry | false> {
        if (skipCheck && !(await this.checkIsTargetFile(meta.path))) {
            return false;
        }
        const doc = await this.database.localDatabase.getDBEntryFromMeta(meta, false, waitForReady, localOnly);
        if (doc === false) {
            return false;
        }
        return doc;
    }
    async fetchEntry(
        file: UXFileInfoStub | FilePathWithPrefix,
        rev?: string,
        waitForReady: boolean = true,
        skipCheck = false,
        localOnly = false
    ): Promise<LoadedEntry | false> {
        if (skipCheck && !(await this.checkIsTargetFile(file))) {
            return false;
        }
        const entry = await this.fetchEntryMeta(file, rev, true);
        if (entry === false) {
            return false;
        }
        const doc = await this.fetchEntryFromMeta(entry, waitForReady, true, localOnly);
        return doc;
    }
    async deleteFromDBbyPath(fullPath: FilePath | FilePathWithPrefix, rev?: string): Promise<boolean> {
        if (!(await this.checkIsTargetFile(fullPath))) {
            this._log(`deleteFromDBbyPath: File is not target: ${fullPath}`);
            return true;
        }
        const opt = rev ? { rev: rev } : undefined;
        const ret = await this.database.localDatabase.deleteDBEntry(fullPath, opt);
        this.events.emitEvent(EVENT_FILE_SAVED);
        return ret;
    }
}
