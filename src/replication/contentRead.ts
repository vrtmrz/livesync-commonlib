import type { DocumentID } from "@lib/common/types.ts";
import type { LocalDatabaseUnavailableError, RemoteRequestError } from "@lib/common/LSError.ts";

export type ChunkReadFailureReason =
    | "offline"
    | "transport"
    | "missing"
    | "invalid"
    | "cancelled"
    | "unavailable"
    | "local-database"
    | "authentication"
    | "configuration";

export type ContentReadFailureCause = LocalDatabaseUnavailableError | RemoteRequestError;

export type ContentReadFailure = {
    documentId: DocumentID;
    revision?: string;
    reason: ChunkReadFailureReason;
    /** Runtime diagnostic context; callers must not persist this value. */
    cause?: ContentReadFailureCause;
};

export type ContentReadFailureHandler = (failure: ContentReadFailure) => void;

export function isTransientContentReadFailure(failure: ContentReadFailure): boolean {
    return failure.reason === "offline" || failure.reason === "transport" || failure.reason === "local-database";
}
