import type { ShimReplicationWriteFailure } from "./ReplicatorShim";

export type MissingRevisionRequest = { id: string; rev: string };

/** Parse the numeric part of a PouchDB sequence value ("42-xyz" → 42). */
export function parseSeq(seq: string | number): number {
    return parseInt(String(seq).split("-")[0], 10);
}

/**
 * Build the `{docId: [rev, ...]}` map required by `revsDiff` from a changes
 * feed result set, merging revisions when the same document appears multiple
 * times in a batch.
 */
export function buildRevsDiffParam(
    changesResults: PouchDB.Core.ChangesResponseChange<object>[]
): Record<string, string[]> {
    const param: Record<string, string[]> = {};
    for (const { id, changes } of changesResults) {
        param[id] = [...(param[id] ?? []), ...changes.map((c) => c.rev)];
    }
    return param;
}

/**
 * Sort fetched documents in ascending sequence order so that consumers receive
 * them in the same order they were written to the source.
 */
export function sortBySeq<T extends { _id: string }>(
    docs: T[],
    changesResults: PouchDB.Core.ChangesResponseChange<object>[]
): T[] {
    const maxSeqById = new Map<string, number>();
    for (const { id, seq } of changesResults) {
        maxSeqById.set(id, Math.max(maxSeqById.get(id) ?? 0, parseSeq(seq)));
    }
    return docs.slice().sort((a, b) => (maxSeqById.get(a._id) ?? 0) - (maxSeqById.get(b._id) ?? 0));
}

function isSuccessfulBulkDocResult(result: unknown): result is PouchDB.Core.Response {
    return typeof result === "object" && result !== null && "ok" in result && result.ok === true;
}

export function buildMissingRevisionRequests(diff: PouchDB.Core.RevisionDiffResponse): MissingRevisionRequest[] {
    return Object.entries(diff)
        .filter(([, entry]) => entry.missing !== undefined)
        .flatMap(([id, entry]) => entry.missing!.map((rev) => ({ id, rev })));
}

export function findUnavailableRevisionRequests(
    requests: readonly MissingRevisionRequest[],
    fetchedDocs: readonly { _id: string; _rev?: string }[]
): MissingRevisionRequest[] {
    const fetchedRevisionKeys = new Set(fetchedDocs.map((doc) => doc._id + "\u0000" + String(doc._rev)));
    return requests.filter(({ id, rev }) => !fetchedRevisionKeys.has(id + "\u0000" + rev));
}

export function buildUnavailableRevisionFailures(
    requests: readonly MissingRevisionRequest[]
): ShimReplicationWriteFailure[] {
    return requests.map<ShimReplicationWriteFailure>((request, index) => ({
        index,
        id: request.id,
        revision: request.rev,
        result: undefined,
    }));
}

export function mapBulkDocResultsToFailures<T extends { _id: string; _rev?: string }>(
    writeResults: (PouchDB.Core.Response | PouchDB.Core.Error)[],
    fetchedDocs: T[]
): ShimReplicationWriteFailure[] {
    return writeResults.flatMap<ShimReplicationWriteFailure>((result, index) => {
        // Local PouchDB filters successful responses when `new_edits` is false,
        // so an empty array is normal. Every returned error is a failed required write.
        if (isSuccessfulBulkDocResult(result)) {
            return [];
        }
        const resultId = typeof result === "object" && result !== null && "id" in result ? result.id : undefined;
        const owningIndex = typeof resultId === "string" ? fetchedDocs.findIndex((doc) => doc._id === resultId) : -1;
        const owningDocument = fetchedDocs[owningIndex >= 0 ? owningIndex : index];
        return [
            {
                index: owningIndex >= 0 ? owningIndex : index,
                id: typeof resultId === "string" ? resultId : (owningDocument?._id ?? ""),
                revision: owningDocument?._rev,
                result,
            },
        ];
    });
}
