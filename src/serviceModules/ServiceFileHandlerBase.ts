import { createFileHandlerContext } from "./ServiceFileHandlerBase/context";
import { processFileEvent, processReplicatedDocument } from "./ServiceFileHandlerBase/events";
import { getFileEntryPath, getFileStoragePath, readStorageFile } from "./ServiceFileHandlerBase/storage";
import { canSkipUnchangedFile, tryRecordUntrackedFileRevision } from "./ServiceFileHandlerBase/scanning";
import { storeFileToDB, storeFileToDBWithBaseRevision } from "./ServiceFileHandlerBase/saving";
import {
    deleteFileFromDB,
    deleteRevisionFromDB,
    resolveConflictedByDeletingRevision,
} from "./ServiceFileHandlerBase/deletion";
import { renameFileInDB } from "./ServiceFileHandlerBase/renaming";
import { dbToStorageWithSpecificRev, dbToStorage } from "./ServiceFileHandlerBase/reflection";
import { createAllChunks } from "./ServiceFileHandlerBase/chunks";

import type {
    AnyEntry,
    FilePath,
    FilePathWithPrefix,
    MetaEntry,
    UXFileInfo,
    UXFileInfoStub,
    UXInternalFileInfoStub,
} from "@lib/common/types";
import type { IFileHandler, StoreFileOptions } from "@lib/interfaces/FileHandler";
import type { DatabaseFileAccess } from "@lib/interfaces/DatabaseFileAccess";
import type { StorageAccess } from "@lib/interfaces/StorageAccess";
import { ServiceModuleBase } from "./ServiceModuleBase";
import { type FileHandlerContext, type ServiceFileHandlerDependencies } from "./ServiceFileHandlerBase/context";
export type { ServiceFileHandlerDependencies } from "./ServiceFileHandlerBase/context";

/** Compatibility facade retaining public host methods while delegating file responsibilities. */
export abstract class ServiceFileHandlerBase
    extends ServiceModuleBase<ServiceFileHandlerDependencies>
    implements IFileHandler
{
    /** Database service captured at construction; the public getter remains virtual. */
    private readonly databaseFileAccess: DatabaseFileAccess;
    /** Storage service captured at construction; the public getter remains virtual. */
    private readonly storageAccess: StorageAccess;
    /** Captured services, per-instance state, and the dynamic public host boundary. */
    private readonly context: FileHandlerContext;

    /**
     * Capture services and register the existing storage and replication handlers.
     * @param services - Host-owned services, copied by value into this facade and its context.
     * @remarks Replication registration binds the current subclass method at construction,
     * retaining the original callback capture semantics. No database or storage I/O starts here.
     */
    constructor(services: ServiceFileHandlerDependencies) {
        super(services);
        this.databaseFileAccess = services.databaseFileAccess;
        this.storageAccess = services.storageAccess;
        this.context = createFileHandlerContext(services, {
            /**
             * Resolve the virtual database service at its original access site.
             * @returns The current database getter result.
             * @remarks No service property is cached through this seam.
             */
            db: () => this.db,
            /**
             * Resolve the virtual storage service at its original access site.
             * @returns The current storage getter result.
             * @remarks No service property is cached through this seam.
             */
            storage: () => this.storage,
            /**
             * Deliver diagnostics through the current public logger.
             * @param args - Original logging arguments, including optional key arity.
             * @returns Completion without a value.
             * @remarks A later logger replacement remains visible.
             */
            log: (...args) => this._log(...args),
            /**
             * Resolve the metadata path through the current host override.
             * @param entry - Database metadata being processed.
             * @returns The current host path.
             * @remarks This does not acquire a document lock.
             */
            getPath: (entry) => this.getPath(entry),
            /**
             * Resolve the storage path through its independent host override.
             * @param entry - Database metadata being processed.
             * @returns The current unprefixed host path.
             * @remarks The original independence from getPath is preserved.
             */
            getPathWithoutPrefix: (entry) => this.getPathWithoutPrefix(entry),
            /**
             * Acquire content through the current public reader.
             * @param file - The original file observation.
             * @returns Its supplied or current body.
             * @remarks The caller retains its existing document lock and read count.
             */
            readFileFromStub: (file) => this.readFileFromStub(file),
            /**
             * Invoke the current public save override for chunk repair.
             * @param args - Original save arguments, retaining omitted optional arguments.
             * @returns The host save result.
             * @remarks The public method retains document-lock ownership.
             */
            storeFileToDB: (...args) => this.storeFileToDB(...args),
        });
        services.fileProcessing.processFileEvent.addHandler((item) => processFileEvent(this.context, item), 100);
        services.replication.processSynchroniseResult.addHandler(this._anyProcessReplicatedDoc.bind(this), 100);
    }
    /**
     * Expose the database service captured when the facade was constructed.
     * @returns The captured database access service.
     * @remarks Responsibility functions resolve this virtual getter at each original access site.
     */
    get db() {
        return this.databaseFileAccess;
    }
    /**
     * Expose the storage service captured when the facade was constructed.
     * @returns The captured storage access service.
     * @remarks Responsibility functions resolve this virtual getter at each original access site.
     */
    get storage() {
        return this.storageAccess;
    }

    /**
     * Resolve an entry through the captured host path service.
     * @param entry - The database metadata being processed.
     * @returns The path reported by the captured path service.
     * @remarks Resolve through the path service captured at construction. This synchronous method acquires no document lock.
     */
    getPath(entry: AnyEntry): FilePathWithPrefix {
        return getFileEntryPath(this.context, entry);
    }

    /**
     * Resolve a storage path through the path service and remove its namespace prefix.
     * @param entry - The database metadata being processed.
     * @returns The path without a storage namespace prefix.
     * @remarks Resolve through the captured path service independently of getPath overrides, then strip the namespace. No document lock is acquired.
     */
    getPathWithoutPrefix(entry: AnyEntry): FilePathWithPrefix {
        return getFileStoragePath(this.context, entry);
    }

    /**
     * Reuse a supplied body or acquire the current content through storage.
     * @param file - The supplied storage observation; its body is reused when present.
     * @returns The supplied or acquired complete file; missing content rejects the operation.
     * @remarks This public reader acquires no document lock. It reuses a supplied body or reads storage, and missing/read failures reject its promise.
     */
    async readFileFromStub(file: UXFileInfoStub | UXFileInfo) {
        return await readStorageFile(this.context, file);
    }

    /**
     * Offer a metadata-only scan hint without certifying bytes or changing provenance.
     * @param info - The supplied file observation or path.
     * @param expected - The database metadata expected by this scan.
     * @returns Whether the scan may skip this unchanged metadata observation.
     * @remarks Acquire the document lock while checking a metadata-only hint. No revision or file content is written; inspection failures are logged and return false.
     */
    async canSkipUnchangedFile(info: UXFileInfoStub, expected: MetaEntry): Promise<boolean> {
        return await canSkipUnchangedFile(this.context, info, expected);
    }

    /**
     * Record an unchanged current revision after rechecking storage and database evidence.
     * @param info - The supplied file observation or path.
     * @param expectedRevision - The exact revision the scan expects to remain current.
     * @returns Whether the exact still-current revision was recorded without writing file content.
     * @remarks Acquire the document lock before attempting an evidence-only provenance update. No database revision or file content is written; inspection/store failures are logged and return false.
     */
    async tryRecordUntrackedFileRevision(
        info: UXFileInfoStub | UXFileInfo,
        expectedRevision: string
    ): Promise<boolean> {
        return await tryRecordUntrackedFileRevision(this.context, info, expectedRevision);
    }

    /**
     * Save ordinary storage content under its document lock.
     * @param info - The supplied file observation or path.
     * @param force - Whether the existing force policy bypasses ordinary unchanged-content checks.
     * @param onlyChunks - Whether to repair chunks without creating a document revision.
     * @param options - The existing recovery revalidation option for this save.
     * @returns True when current bytes are represented or chunk repair succeeds; false for refused or unstable observations.
     * @remarks Acquire the document lock and retain deferred post-lock conflict hooks. Ordinary revision writes reuse the captured body; legacy-evidence upgrades and recovery retain their existing validation reads. Provenance publication is best-effort.
     */
    async storeFileToDB(
        info: UXFileInfoStub | UXFileInfo | UXInternalFileInfoStub | FilePathWithPrefix,
        force: boolean = false,
        onlyChunks: boolean = false,
        options: StoreFileOptions = {}
    ): Promise<boolean> {
        return await storeFileToDB(this.context, info, force, onlyChunks, options);
    }

    /**
     * Save current bytes under one selected live database revision.
     * @param info - The supplied file observation or path.
     * @param baseRevision - The exact selected live database revision.
     * @param createIfDifferent - Whether differing bytes may create a child of the selected revision.
     * @returns True when matching bytes are certified or a selected-base child is stored; false when the live-base or content condition refuses it.
     * @remarks Acquire the document lock and reject a selected base that is no longer live. Matching bytes or a new selected-base child may complete; provenance publication is best-effort.
     */
    async storeFileToDBWithBaseRevision(
        info: UXFileInfoStub | UXFileInfo | FilePathWithPrefix,
        baseRevision: string,
        createIfDifferent: boolean = true
    ): Promise<boolean> {
        return await storeFileToDBWithBaseRevision(this.context, info, baseRevision, createIfDifferent);
    }

    /**
     * Record a storage deletion under the corresponding document lock.
     * @param info - The supplied file observation or path.
     * @returns True after deletion or conservative conflict preservation; false for absent/deleted records or a refused write.
     * @remarks Acquire the source document lock. Unknown conflict ancestry is preserved for review; database errors reject and optional provenance cleanup remains best-effort.
     */
    async deleteFileFromDB(info: UXFileInfoStub | UXInternalFileInfoStub | FilePath): Promise<boolean> {
        return await deleteFileFromDB(this.context, info);
    }

    /**
     * Record a rename under both source and destination document locks.
     * @param info - The destination file observation, optionally already containing its body.
     * @param oldPath - The rename source path whose branch must be preserved or deleted safely.
     * @returns True after target/source handling or conservative source preservation; false on target collision or refused work.
     * @remarks Acquire deduplicated source and target document locks. Save the target before guarded source cleanup; unknown source ancestry is preserved for review.
     */
    async renameFileInDB(info: UXFileInfoStub | UXFileInfo, oldPath: FilePath | FilePathWithPrefix): Promise<boolean> {
        return await renameFileInDB(this.context, info, oldPath);
    }

    /**
     * Delete a selected revision under its document lock.
     * @param info - The supplied file observation or path.
     * @param rev - The exact selected database revision.
     * @returns The database deletion result; matching provenance is cleared only after success.
     * @remarks Acquire the document lock and delete the selected revision. Matching provenance clearing is attempted best-effort only after successful deletion.
     */
    async deleteRevisionFromDB(
        info: UXFileInfoStub | FilePath | FilePathWithPrefix,
        rev: string
    ): Promise<boolean | undefined> {
        return await deleteRevisionFromDB(this.context, info, rev);
    }

    /**
     * Run the legacy delete-and-reflect resolution under one document lock.
     * @param info - The supplied file observation or path.
     * @param rev - The exact selected database revision.
     * @returns False on refusal; the existing undefined result on successful legacy completion.
     * @remarks Acquire the document lock for the existing metadata-capture, deletion, reflection, and best-effort-provenance-clear sequence. Operation errors retain precedence over post-lock hook errors.
     */
    async resolveConflictedByDeletingRevision(
        info: UXFileInfoStub | FilePath,
        rev: string
    ): Promise<boolean | undefined> {
        return await resolveConflictedByDeletingRevision(this.context, info, rev);
    }

    /**
     * Reflect one selected live revision under the storage document lock.
     * @param info - The supplied file observation or path.
     * @param rev - The exact selected database revision.
     * @param force - Whether the existing force policy bypasses ordinary unchanged-content checks.
     * @returns The selected live leaf reflection result, or false if the selected revision is no longer live.
     * @remarks Acquire the document lock and validate that the selected revision remains live before protected reflection. Refusals return false; operation errors reject.
     */
    async dbToStorageWithSpecificRev(
        info: UXFileInfoStub | UXFileInfo | FilePath | FilePathWithPrefix | null,
        rev: string,
        force?: boolean
    ): Promise<boolean> {
        return await dbToStorageWithSpecificRev(this.context, info, rev, force);
    }

    /**
     * Fetch and reflect the current database revision under its document lock.
     * @param entryInfo - Current metadata or a path from which metadata is loaded.
     * @param info - The supplied file observation or path.
     * @param force - Whether the existing force policy bypasses ordinary unchanged-content checks.
     * @returns True after reflection or a safe conflict/absence skip; false on unreadable or unsafe observations.
     * @remarks Acquire the document lock before fetching current metadata and protected reflection. Safe skips may return true without writing a file; operation errors reject.
     */
    async dbToStorage(
        entryInfo: MetaEntry | FilePathWithPrefix,
        info: UXFileInfoStub | UXFileInfo | FilePath | null,
        force?: boolean
    ): Promise<boolean> {
        return await dbToStorage(this.context, entryInfo, info, force);
    }

    /**
     * Select and reflect a replicated document while retaining host override dispatch.
     * @param entry - The database metadata being processed.
     * @returns Whether replication reflection completed; excluded or unsafe documents retain a false result.
     * @remarks Acquire the related document lock before selection and reflection. Constructor registration captures the current subclass override with bind; internal public seams remain live at use time.
     */
    async _anyProcessReplicatedDoc(entry: MetaEntry): Promise<boolean> {
        return await processReplicatedDocument(this.context, entry);
    }

    /**
     * Repair missing chunks with at most ten acquired file operations at a time.
     * @param showingNotice - Whether progress uses notice-level messages instead of informational messages.
     * @returns Completion after all selected tasks settle. Per-file save errors are logged and swallowed; listing, selection, acquisition, progress, or logger failures can still reject.
     * @remarks Each file uses the dynamic public save seam and its document lock. Up to ten permits are acquired; progress remains before the original guarded body, preserving its existing cleanup semantics.
     */
    async createAllChunks(showingNotice?: boolean): Promise<void> {
        return await createAllChunks(this.context, showingNotice);
    }
}
