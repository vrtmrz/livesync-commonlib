import type { DocumentID } from "@lib/common/types.ts";

export type UnencryptedContentKind = "chunk" | "inline-note" | "eden";

const UNENCRYPTED_CONTENT_REJECTED_CODE = "UNENCRYPTED_CONTENT_REJECTED";
const UNENCRYPTED_CONTENT_REJECTED_NAME = "UnencryptedContentRejectedError";

export class UnencryptedContentRejectedError extends Error {
    override readonly name = UNENCRYPTED_CONTENT_REJECTED_NAME;
    readonly code = UNENCRYPTED_CONTENT_REJECTED_CODE;

    constructor(
        readonly documentId: DocumentID,
        readonly contentKind: UnencryptedContentKind
    ) {
        super(`Unencrypted ${contentKind} content in remote document ${documentId} was rejected while E2EE is enabled.`);
    }
}

type RejectionInspection = {
    rejected: boolean;
    details?: { documentId: string; contentKind: string };
};

function inspectUnencryptedContentRejection(error: unknown): RejectionInspection {
    const seen = new Set<unknown>();
    const pending: unknown[] = [error];
    let details: RejectionInspection["details"];
    let rejected = false;

    while (pending.length > 0) {
        const current = pending.pop();
        if (typeof current !== "object" || current === null || seen.has(current)) continue;
        seen.add(current);
        const candidate = current as Record<string, unknown>;
        if (candidate.code === UNENCRYPTED_CONTENT_REJECTED_CODE || candidate.name === UNENCRYPTED_CONTENT_REJECTED_NAME) {
            rejected = true;
            if (typeof candidate.documentId === "string" && typeof candidate.contentKind === "string") {
                details ??= { documentId: candidate.documentId, contentKind: candidate.contentKind };
            }
        }
        if ("cause" in candidate) pending.push(candidate.cause);
    }

    return { rejected, details };
}

/** Recognise the rejection through PouchDB-shaped errors and ordinary cause wrappers. */
export function isUnencryptedContentRejectedError(error: unknown): boolean {
    return inspectUnencryptedContentRejection(error).rejected;
}

/** Return only safe document diagnostics; never expose the rejected body or encryption key. */
export function getUnencryptedContentRejection(
    error: unknown
): { documentId: string; contentKind: string } | undefined {
    return inspectUnencryptedContentRejection(error).details;
}
