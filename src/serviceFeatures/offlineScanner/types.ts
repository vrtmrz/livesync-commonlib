import type { DocumentID, FilePathWithPrefix, MetaEntry, UXFileInfoStub } from "@lib/common/types";
import type { VaultScanOptions } from "@lib/services/base/VaultScanResult.ts";

/**
 * Outcome of processing one storage/database pair during an offline scan.
 *
 * A skipped pair is intentionally left unchanged by scanner policy. It is not
 * a scan failure, but it must not receive success side effects which would
 * claim that database content was reflected to storage.
 */
export const FilePairProcessResults = {
    COMPLETED: "completed",
    SKIPPED: "skipped",
    FAILED: "failed",
} as const;

export type FilePairProcessResult = (typeof FilePairProcessResults)[keyof typeof FilePairProcessResults];

export const MetadataDocumentNamespaces = {
    NORMAL: "normal",
    INTERNAL: "internal",
    CUSTOMISATION: "customisation",
    PLUGIN_STORAGE: "plugin-storage",
} as const;

export type MetadataDocumentNamespace = (typeof MetadataDocumentNamespaces)[keyof typeof MetadataDocumentNamespaces];

export const MetadataDocumentIdentityStatuses = {
    CONSISTENT: "consistent",
    EXCLUDED: "excluded",
    UNRESOLVED: "unresolved",
} as const;

export const OfflineScanUnresolvedReasons = {
    DOCUMENT_ID_MISMATCH: "document-id-mismatch",
    NAMESPACE_MISMATCH: "namespace-mismatch",
} as const;

export interface OfflineScanUnresolvedDiagnostic {
    reason: (typeof OfflineScanUnresolvedReasons)[keyof typeof OfflineScanUnresolvedReasons];
    actualDocumentId: DocumentID;
    declaredPath: FilePathWithPrefix;
    expectedDocumentId?: DocumentID;
    actualNamespace: MetadataDocumentNamespace;
    declaredPathNamespace: MetadataDocumentNamespace;
}

export type MetadataDocumentIdentityInspection =
    | {
          status: typeof MetadataDocumentIdentityStatuses.CONSISTENT;
          actualDocumentId: DocumentID;
          declaredPath: FilePathWithPrefix;
          expectedDocumentId: DocumentID;
      }
    | {
          status: typeof MetadataDocumentIdentityStatuses.EXCLUDED;
          actualDocumentId: DocumentID;
          declaredPath: FilePathWithPrefix;
          namespace: Exclude<MetadataDocumentNamespace, "normal">;
      }
    | {
          status: typeof MetadataDocumentIdentityStatuses.UNRESOLVED;
          diagnostic: OfflineScanUnresolvedDiagnostic;
      };

export interface MetadataDocumentIdentityIssue {
    inspection: Extract<
        MetadataDocumentIdentityInspection,
        { status: typeof MetadataDocumentIdentityStatuses.UNRESOLVED }
    >;
    sourceRevision: string | null;
    logicallyDeleted: boolean;
    conflictRevisions: string[];
    repairAvailable: boolean;
    targetAlreadyPresent: boolean;
    ordinaryPathAvailable: boolean;
}

export const MetadataDocumentRepairResults = {
    COMPLETED: "completed",
    STALE: "stale",
    BLOCKED: "blocked",
    FAILED: "failed",
} as const;

export interface MetadataDocumentRepairRequest {
    actualDocumentId: DocumentID;
    expectedDocumentId: DocumentID;
    sourceRevision: string;
}

export type MetadataDocumentRepairResult = {
    status: (typeof MetadataDocumentRepairResults)[keyof typeof MetadataDocumentRepairResults];
    actualDocumentId: DocumentID;
    expectedDocumentId: DocumentID;
    sourceRevision: string;
    targetCreated: boolean;
    message?: string;
};
export const FullScanModes = {
    // SAFE: "safe",
    DB_APPLY: "db-apply",
    NEWER_WINS: "newer-wins",
    // STORAGE_ONLY: "local-only",
} as const;

export const ExtraOnRemote = {
    /**
     * Delete database entries if they are missing on storage.
     */
    DELETE_LOCAL_MISSING: "delete-local-missing",
    /**
     * Apply changes from database to storage.
     */
    // APPEND_DB_ONLY: "append-db-only",
} as const;
export const ExtraOnLocal = {
    /**
     * Delete local files if they were deleted on database.
     */
    DELETE_DB_DELETED: "delete-db-deleted",
    /**
     * Delete local files if they are missing on database or were deleted on database.
     */
    DELETE_DB_MISSING: "delete-db-missing",
    /**
     * Merge local files to database
     */
    APPEND_STORAGE_ONLY: "append-storage-only",
} as const;

export interface FullScanOptions extends VaultScanOptions {
    mode: FullScanMode;
    extraOnLocal?: (typeof ExtraOnLocal)[keyof typeof ExtraOnLocal];
    extraOnRemote?: (typeof ExtraOnRemote)[keyof typeof ExtraOnRemote];
    omitEvents?: boolean;
    showingNotice?: boolean;
    ignoreSuspending?: boolean;
    /**
     * Allow a completed scan containing individual file-pair failures to
     * satisfy ordinary application readiness. Scan preconditions remain
     * strict, and failed pairs remain retryable.
     */
    continueOnFileFailure?: boolean;
}

export type FullScanMode = (typeof FullScanModes)[keyof typeof FullScanModes];
export type FilePair =
    | { file: UXFileInfoStub; doc: MetaEntry }
    | { file: undefined; doc: MetaEntry }
    | { file: UXFileInfoStub; doc: undefined };
export type FilePairState = "storage-only" | "db-only" | "db-only-deleted" | "both" | "both-db-deleted";

export type FilePairAction = "update-db" | "update-storage" | "sync-newer" | "delete-local" | "delete-db" | "skip";
