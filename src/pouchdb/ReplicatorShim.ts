import { serialized } from "octagonal-wheels/concurrency/lock";
import { Logger } from "../common/logger";
import { LOG_LEVEL_VERBOSE } from "../common/types";

export type SomeDocument<T extends object> = PouchDB.Core.ExistingDocument<T> & PouchDB.Core.ChangesMeta;

/**
 * Minimal subset of the PouchDB public API required by {@link replicateShim}.
 * Both a real `PouchDB.Database` and an {@link RpcPouchDBProxy} satisfy this
 * interface, allowing replication across an RPC transport.
 */
export type PouchDBShim<T extends object> = {
    info: () => Promise<PouchDB.Core.DatabaseInfo>;
    changes: (options: PouchDB.Core.ChangesOptions) => PromiseLike<PouchDB.Core.ChangesResponse<T>>;
    revsDiff: (diff: PouchDB.Core.RevisionDiffOptions) => Promise<PouchDB.Core.RevisionDiffResponse>;
    bulkDocs: (
        docs: PouchDB.Core.PostDocument<any>[],
        options?: PouchDB.Core.BulkDocsOptions
    ) => Promise<(PouchDB.Core.Response | PouchDB.Core.Error)[]>;
    bulkGet: (options: PouchDB.Core.BulkGetOptions) => Promise<PouchDB.Core.BulkGetResponse<T>>;
    put: (doc: PouchDB.Core.PutDocument<any>, options?: PouchDB.Core.PutOptions) => Promise<PouchDB.Core.Response>;
    get: (id: string, options?: PouchDB.Core.GetOptions) => Promise<T & PouchDB.Core.IdMeta & PouchDB.Core.GetMeta>;
};

type CompatibleDatabase<T extends object> = PouchDB.Database<SomeDocument<T>> | PouchDBShim<SomeDocument<T>>;

/** Upserts a document by `id`, calling `func` to produce the updated version. */
export async function upsert<V extends object, T extends SomeDocument<V> = SomeDocument<V>>(
    db: CompatibleDatabase<object>,
    id: string,
    func: (doc: T) => T
): Promise<T> {
    try {
        const doc = (await db.get(id)) as T;
        const updated = func(doc);
        const result = await db.put(updated, {});
        if (result && result.ok) {
            return updated;
        }
        throw new Error("Failed to update");
    } catch (ex: any) {
        // RPC-forwarded PouchDB not-found errors may arrive without `name`
        // and only carry `message`/`reason` as "missing".
        const isNotFound =
            ex?.name === "not_found" ||
            ex?.reason === "missing" ||
            ex?.message === "missing" ||
            ex?.message === "not_found";
        if (isNotFound) {
            const seed = func({ _id: id } as T);
            const result = await db.put(seed, {});
            if (result && result.ok) {
                return seed;
            }
            throw new Error("Failed to insert");
        }
        throw ex;
    }
}

export type ShimReplicationOptionBase = {
    rewind?: boolean;
    batch_size?: number;
};
export type ShimReplicationOneShot = {
    live?: false;
    controller?: AbortController;
} & ShimReplicationOptionBase;

export type ShimReplicationOptionContinuous = {
    live: true;
    controller: AbortController;
} & ShimReplicationOptionBase;

export type ShimReplicationOption = ShimReplicationOneShot | ShimReplicationOptionContinuous;
export type ProgressInfo = {
    lastSeq: number;
    maxSeqInBatch: number;
};
export type ShimReplicationProgressReportFunc<T extends object> = (
    progress: SomeDocument<T>[],
    progressInfo: ProgressInfo
) => Promise<void>;

/** Parse the numeric part of a PouchDB sequence value (`"42-xyz"` → `42`). */
function parseSeq(seq: string | number): number {
    return parseInt(String(seq).split("-")[0], 10);
}

/**
 * Build the `{docId: [rev, ...]}` map required by `revsDiff` from a changes
 * feed result set, merging revisions when the same document appears multiple
 * times in a batch.
 */
function buildRevsDiffParam(changesResults: PouchDB.Core.ChangesResponseChange<object>[]): Record<string, string[]> {
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
function sortBySeq<T extends { _id: string }>(
    docs: T[],
    changesResults: PouchDB.Core.ChangesResponseChange<object>[]
): T[] {
    const maxSeqById = new Map<string, number>();
    for (const { id, seq } of changesResults) {
        maxSeqById.set(id, Math.max(maxSeqById.get(id) ?? 0, parseSeq(seq)));
    }
    return docs.slice().sort((a, b) => (maxSeqById.get(a._id) ?? 0) - (maxSeqById.get(b._id) ?? 0));
}

/**
 * Replicate documents from `sourceDB` into `targetDB` using a CouchDB-style
 * checkpoint protocol.
 *
 * Both parameters accept either a real `PouchDB.Database` or any object
 * implementing {@link PouchDBShim} — including {@link RpcPouchDBProxy} — so
 * replication can span an RPC transport boundary.
 *
 * @param targetDB  Destination database (usually local).
 * @param sourceDB  Source database (may be remote / RPC-backed).
 * @param progress  Called after each batch with the written documents.
 * @param option    Replication options (live mode, batch size, abort signal).
 */
export async function replicateShim<T extends CompatibleDatabase<V>, U extends CompatibleDatabase<V>, V extends object>(
    targetDB: T,
    sourceDB: U,
    progress: ShimReplicationProgressReportFunc<V>,
    option: ShimReplicationOption = {}
) {
    try {
        const [targetDBInfo, sourceDBInfo] = await Promise.all([targetDB.info(), sourceDB.info()]);
        const maxNumSeq = parseSeq(sourceDBInfo.update_seq);

        await serialized(`replication-${targetDBInfo.db_name}-${sourceDBInfo.db_name}`, async () => {
            Logger(
                `Replication ${sourceDBInfo.db_name} (${sourceDBInfo.update_seq}) → ${targetDBInfo.db_name} (${targetDBInfo.update_seq})`,
                LOG_LEVEL_VERBOSE
            );

            // --- Checkpoint: source-side mark ---------------------------------
            // A `mark` stored on the source detects when it has been rebuilt.
            // If the mark changes, `since` is reset to the beginning.
            const { db_name: targetName } = targetDBInfo;
            const { db_name: sourceName } = sourceDBInfo;
            const sourceCheckpointID = `_local/replication-checkpoint-mark-${targetName}-${sourceName}`;
            const { mark } = await upsert<{ mark: string }>(sourceDB, sourceCheckpointID, (doc) => ({
                ...doc,
                mark: option.rewind ? String(Date.now()) : (doc.mark ?? String(Date.now())),
            }));
            Logger(`Replication mark: ${mark}`, LOG_LEVEL_VERBOSE);

            // --- Checkpoint: target-side since --------------------------------
            const targetCheckpointID = `_local/replication-checkpoint-${targetName}-${mark}`;
            const checkpoint = await upsert<{ since: string | number }>(targetDB, targetCheckpointID, (doc) => ({
                ...doc,
                since: doc.since ?? "",
            }));
            let since = checkpoint.since;
            Logger(`Starting from seq ${since}`, LOG_LEVEL_VERBOSE);

            const batchSize = option.batch_size ?? 33;

            // --- Batch replication loop ---------------------------------------
            while (true) {
                const changes = await sourceDB.changes({ since, style: "all_docs", limit: batchSize });

                if (changes.results.length === 0) break;
                if (option.controller?.signal?.aborted) break;

                const changesResults = changes.results;
                const revsDiffParam = buildRevsDiffParam(changesResults);
                const diff = await targetDB.revsDiff(revsDiffParam);

                // Collect {id, rev} pairs for revisions the target is missing.
                const missingRequests = Object.entries(diff)
                    .filter(([, entry]) => entry.missing !== undefined)
                    .flatMap(([id, entry]) => entry.missing!.map((rev) => ({ id, rev })));

                if (missingRequests.length > 0) {
                    const bulkGetResult = await sourceDB.bulkGet({ docs: missingRequests, revs: true });
                    const fetchedDocs = bulkGetResult.results
                        .flatMap((r) => r.docs)
                        .filter((d) => "ok" in d)
                        .map((d) => d.ok);

                    await targetDB.bulkDocs(fetchedDocs, { new_edits: false });

                    // Re-fetch the written docs from target to pass to the progress callback
                    // in the order they were sequenced in the source.
                    const uniqueIds = [...new Set(changesResults.map((c) => c.id))];
                    const refreshResult = await targetDB.bulkGet({ docs: uniqueIds.map((id) => ({ id })) });
                    const refreshedDocs = refreshResult.results
                        .flatMap((r) => r.docs)
                        .filter((d) => "ok" in d)
                        .map((d) => d.ok);

                    const orderedDocs = sortBySeq(refreshedDocs, changesResults);
                    const lastSeqNum = parseSeq(changes.last_seq);

                    try {
                        await progress(orderedDocs, { lastSeq: lastSeqNum, maxSeqInBatch: maxNumSeq });
                    } catch (ex) {
                        Logger(`Progress callback failed during shim-replication`, LOG_LEVEL_VERBOSE);
                        Logger(ex, LOG_LEVEL_VERBOSE);
                    }
                }

                since = changes.last_seq;
                await upsert<{ since: string | number }>(targetDB, targetCheckpointID, (doc) => ({
                    ...doc,
                    since,
                }));
            }
        });
    } catch (ex) {
        Logger(`Replication failed`, LOG_LEVEL_VERBOSE);
        Logger(ex, LOG_LEVEL_VERBOSE);
        throw ex;
    }
    Logger(`Replication completed`, LOG_LEVEL_VERBOSE);
}
