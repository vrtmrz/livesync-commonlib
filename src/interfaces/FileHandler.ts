import type { FilePath, FilePathWithPrefix, MetaEntry } from "@lib/common/models/db.type";
import type { UXFileInfo, UXFileInfoStub, UXInternalFileInfoStub } from "@lib/common/models/fileaccess.type";

export interface StoreFileOptions {
    /** Recheck storage and provenance, with bounded retries for recovery scans. */
    revalidateStorage?: boolean;
}

/** Diagnostic context shared by each observed deletion-recovery outcome. */
interface DeletionRecoveryDiagnostics {
    reason: string;
    phase?: string;
    warning?: string;
    error?: unknown;
}

/** No provenance was cleared; edits and unknown content remain protected. */
export interface DeletionRecoveryUnchangedResult extends DeletionRecoveryDiagnostics {
    status: "deferred" | "failed";
    file: "present" | "absent" | "unknown";
    provenance: "unchanged";
}

/** Absence was observed, but remaining bookkeeping must be rediscovered on a later scan. */
export interface DeletionRecoveryCleanupPendingResult extends DeletionRecoveryDiagnostics {
    status: "deferred" | "failed";
    file: "absent";
    provenance: "pending";
}

/** Removal was attempted, but its effect could not be read; retain evidence until the next observation. */
export interface DeletionRecoveryRemovalUnconfirmedResult extends DeletionRecoveryDiagnostics {
    status: "failed";
    file: "unknown";
    provenance: "pending";
}

/** Both effects were confirmed; a subsequent lock or permit failure can still fail the operation. */
export interface DeletionRecoveryClearedResult extends DeletionRecoveryDiagnostics {
    status: "applied" | "failed";
    file: "absent";
    provenance: "cleared";
}

/**
 * Coherent observed effects of one guarded deletion-recovery attempt.
 * @remarks The `applied` status requires observed absence and cleared provenance.
 * Unchanged refers to provenance operations, not proof that a file still exists.
 * Pending and unconfirmed effects retain retry evidence. A deferred protected
 * file may require user reconciliation; automatic convergence is not guaranteed.
 */
export type DeletionRecoveryResult =
    | DeletionRecoveryUnchangedResult
    | DeletionRecoveryCleanupPendingResult
    | DeletionRecoveryRemovalUnconfirmedResult
    | DeletionRecoveryClearedResult;

export interface IFileHandler {
    readFileFromStub(file: UXFileInfoStub | UXFileInfo): Promise<UXFileInfo>;

    /**
     * Record an untracked, unchanged file during an equal-time scan.
     * Return true only when the exact current revision was recorded. This
     * operation never stores a Metadata revision or writes to storage.
     */
    tryRecordUntrackedFileRevision(info: UXFileInfoStub | UXFileInfo, expectedRevision: string): Promise<boolean>;

    /** Metadata-only scan hint; never certifies content equality or changes provenance. */
    canSkipUnchangedFile?(info: UXFileInfoStub, expected: MetaEntry): Promise<boolean>;

    /**
     * Report whether complete provenance-key discovery is configured.
     * @returns A composition capability, rather than a store-readiness or health check.
     */
    supportsDeletionRecovery?(): boolean;

    /**
     * Enumerate existing provenance paths without loading record values or bodies.
     * @returns Complete namespaced keys; unsupported or unavailable stores may reject.
     */
    listDeletionRecoveryPaths?(): Promise<FilePathWithPrefix[]>;

    /**
     * Recover one exact retained deletion without adding revision history.
     * @param expected - The selected logical deletion whose identity and revision must remain current.
     * @param cleanupOnly - Permit bookkeeping for an absent file only; never remove a present file.
     * @returns Observed effects and completion status, including conservative deferral or failure.
     * @remarks A failed result can retain confirmed absence or completed cleanup.
     * Callers must use those effects when preserving retry evidence.
     */
    recoverDatabaseDeletion?(expected: MetaEntry, cleanupOnly?: boolean): Promise<DeletionRecoveryResult>;

    storeFileToDB(
        info: UXFileInfoStub | UXFileInfo | UXInternalFileInfoStub | FilePathWithPrefix,
        force?: boolean,
        onlyChunks?: boolean,
        options?: StoreFileOptions
    ): Promise<boolean>;

    /**
     * Store the current storage content as a child of an exact live database revision.
     *
     * This explicit branch-selection boundary is intended for user-directed
     * reconciliation. It rechecks that the selected revision is still live,
     * and records the resulting revision as the storage provenance. When
     * `createIfDifferent` is false, differing storage content is rejected
     * instead of creating a child revision.
     */
    storeFileToDBWithBaseRevision(
        info: UXFileInfoStub | UXFileInfo | FilePathWithPrefix,
        baseRevision: string,
        createIfDifferent?: boolean
    ): Promise<boolean>;

    deleteFileFromDB(info: UXFileInfoStub | UXInternalFileInfoStub | FilePath): Promise<boolean>;

    renameFileInDB(info: UXFileInfoStub | UXFileInfo, oldPath: FilePath | FilePathWithPrefix): Promise<boolean>;

    /**
     * Create a logical deletion on one exact database revision.
     *
     * When device-local storage provenance names the deleted revision, the
     * implementation clears that stale provenance without changing storage.
     */
    deleteRevisionFromDB(
        info: UXFileInfoStub | FilePath | FilePathWithPrefix,
        rev: string
    ): Promise<boolean | undefined>;

    resolveConflictedByDeletingRevision(info: UXFileInfoStub | FilePath, rev: string): Promise<boolean | undefined>;

    dbToStorageWithSpecificRev(
        info: UXFileInfoStub | UXFileInfo | FilePath | FilePathWithPrefix | null,
        rev: string,
        force?: boolean
    ): Promise<boolean>;

    dbToStorage(
        entryInfo: MetaEntry | FilePathWithPrefix,
        info: UXFileInfoStub | UXFileInfo | FilePath | null,
        force?: boolean
    ): Promise<boolean>;

    createAllChunks(showingNotice?: boolean): Promise<void>;
}
