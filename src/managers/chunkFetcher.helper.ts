import type { DocumentID } from "@lib/common/types.ts";
import type { FetchedChunkPayload } from "@lib/common/models/document.type";

const REMOTE_MISSING_RETRY_STEP_MS = 2_000;
const REMOTE_MISSING_RETRY_MAX_DELAY_MS = 10_000;

type MissingChunkAction = { kind: "missing" } | { kind: "retry"; missingResponses: number; delayMs: number };

export function decideMissingChunkAction({
    missingResponses,
    finiteReplicationActive,
    completedDuringRequest,
}: {
    missingResponses: number;
    finiteReplicationActive: boolean;
    completedDuringRequest: boolean;
}): MissingChunkAction {
    if (missingResponses > 0 && !finiteReplicationActive && !completedDuringRequest) {
        return { kind: "missing" };
    }
    const nextMissingResponses = missingResponses + 1;
    return {
        kind: "retry",
        missingResponses: nextMissingResponses,
        delayMs: completedDuringRequest
            ? 0
            : Math.min(nextMissingResponses * REMOTE_MISSING_RETRY_STEP_MS, REMOTE_MISSING_RETRY_MAX_DELAY_MS),
    };
}

export type FetchedChunkClassification = {
    chunks: FetchedChunkPayload[];
    invalidChunks: unknown[];
    missingIds: DocumentID[];
    invalidIds: DocumentID[];
};

function isValidChunk(chunk: unknown): chunk is FetchedChunkPayload {
    const candidate = chunk as Partial<FetchedChunkPayload> | null | undefined;
    return !!candidate && typeof candidate._id === "string" && typeof candidate.data === "string";
}

export function classifyFetchedChunks(
    requestedIds: readonly DocumentID[],
    fetched: readonly unknown[]
): FetchedChunkClassification {
    const chunks: FetchedChunkPayload[] = [];
    const invalidChunks: unknown[] = [];
    const observedIds = new Set<string>();
    for (const chunk of fetched) {
        const candidate = chunk as Partial<FetchedChunkPayload> | null | undefined;
        if (typeof candidate?._id === "string") observedIds.add(candidate._id);
        if (isValidChunk(chunk)) chunks.push(chunk);
        else invalidChunks.push(chunk);
    }
    const validIds = new Set(chunks.map((chunk) => chunk._id));
    return {
        chunks,
        invalidChunks,
        missingIds: requestedIds.filter((id) => !observedIds.has(id)),
        invalidIds: requestedIds.filter((id) => observedIds.has(id) && !validIds.has(id)),
    };
}
