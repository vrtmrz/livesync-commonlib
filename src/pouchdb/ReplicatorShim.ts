import { serialized } from "octagonal-wheels/concurrency/lock";
import { Logger } from "@lib/common/logger";
import { LOG_LEVEL_VERBOSE } from "@lib/common/types";

/** A stored document carrying the change-feed metadata used by the shim. */
export type SomeDocument<T extends object> = PouchDB.Core.ExistingDocument<T> & PouchDB.Core.ChangesMeta;

/**
 * Structural database boundary required by {@link replicateShim}.
 *
 * Listing only the operations used by the algorithm lets a local
 * `PouchDB.Database` and an RPC-backed proxy participate without presenting
 * the proxy as a complete PouchDB implementation.
 */
export type PouchDBShim<T extends object> = {
    info: () => Promise<PouchDB.Core.DatabaseInfo>;
    changes: (options: PouchDB.Core.ChangesOptions) => PromiseLike<PouchDB.Core.ChangesResponse<T>>;
    revsDiff: (diff: PouchDB.Core.RevisionDiffOptions) => Promise<PouchDB.Core.RevisionDiffResponse>;
    bulkDocs: (
        docs: PouchDB.Core.PutDocument<T>[],
        options?: PouchDB.Core.BulkDocsOptions
    ) => Promise<(PouchDB.Core.Response | PouchDB.Core.Error)[]>;
    bulkGet: (options: PouchDB.Core.BulkGetOptions) => Promise<PouchDB.Core.BulkGetResponse<T>>;
    put: (doc: PouchDB.Core.PutDocument<T>, options?: PouchDB.Core.PutOptions) => Promise<PouchDB.Core.Response>;
    get: (id: string, options?: PouchDB.Core.GetOptions) => Promise<T & PouchDB.Core.IdMeta & PouchDB.Core.GetMeta>;
};

/** A local PouchDB database or a structural shim with the same required operations. */
type CompatibleDatabase<T extends object> = PouchDB.Database<SomeDocument<T>> | PouchDBShim<SomeDocument<T>>;

type ErrorLike = { name?: string; message?: string; reason?: string; error?: unknown };

/** Upserts a document by `id`, calling `func` to produce the updated version. */
export async function upsert<
    V extends object,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- We want to operate on arbitrary document shapes here.
    TDB extends CompatibleDatabase<object> = CompatibleDatabase<any>,
    T extends SomeDocument<V> = SomeDocument<V>,
>(db: TDB, id: string, func: (doc: T) => T): Promise<T> {
    try {
        const doc = (await db.get(id)) as T;
        const updated = func(doc);
        const result = await db.put(updated, {});
        if (result && result.ok) {
            return updated;
        }
        throw new Error("Failed to update");
    } catch (ex: unknown) {
        // RPC-forwarded PouchDB not-found errors may arrive without `name`
        // and only carry `message`/`reason` as "missing".
        const isNotFound =
            (ex as ErrorLike)?.name === "not_found" ||
            (ex as ErrorLike)?.reason === "missing" ||
            (ex as ErrorLike)?.message === "missing" ||
            (ex as ErrorLike)?.message === "not_found";
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

/** Batch and cancellation policy shared by finite and continuous shim replication. */
export type ShimReplicationOptionBase = {
    rewind?: boolean;
    batch_size?: number;
    /** Abort before a new batch starts, or after the current batch settles. */
    signal?: AbortSignal;
};

/** Options for a finite replication which settles after catching up or cancellation. */
export type ShimReplicationOneShot = {
    live?: false;
    /** Legacy cancellation option retained for existing callers. */
    controller?: AbortController;
} & ShimReplicationOptionBase;

/** Options for replication which continues watching until its controller cancels it. */
export type ShimReplicationOptionContinuous = {
    live: true;
    controller: AbortController;
} & ShimReplicationOptionBase;

/** Selects finite or continuous shim replication. */
export type ShimReplicationOption = ShimReplicationOneShot | ShimReplicationOptionContinuous;

/** Explicit terminal state returned by {@link replicateShim}. */
export type ShimReplicationOutcome = ShimReplicationCompleted | ShimReplicationCancelled;
export type ShimReplicationCompleted = { readonly status: "completed" };
export type ShimReplicationCancelled = { readonly status: "cancelled" };

/** Details of a document whose requested bulk write did not succeed. */
export type ShimReplicationWriteFailure = {
    readonly index: number;
    readonly id: string;
    readonly revision: string | undefined;
    readonly result: PouchDB.Core.Response | PouchDB.Core.Error | undefined;
};

/**
 * Raised when a batch cannot be committed safely.
 *
 * PouchDB resolves `bulkDocs` even when an individual document fails.  The
 * replication shim exposes that failure as an error so that callers cannot
 * mistake a partially written batch for a committed checkpoint.
 */
export class ShimReplicationError extends Error {
    constructor(
        message: string,
        readonly failures: readonly ShimReplicationWriteFailure[]
    ) {
        super(message);
        this.name = "ShimReplicationError";
    }
}

/** Sequence boundary committed by one successfully written batch. */
export type ProgressInfo = {
    lastSeq: number;
    maxSeqInBatch: number;
};

/** Receives the documents and committed sequence boundary for each completed batch. */
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

function isSuccessfulBulkDocResult(result: unknown): result is PouchDB.Core.Response {
    return typeof result === "object" && result !== null && "ok" in result && result.ok === true;
}

function isCancellationError(error: unknown): boolean {
    if (typeof error !== "object" || error === null) return false;
    return ("code" in error && error.code === "CANCELLED") || ("name" in error && error.name === "AbortError");
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
): Promise<ShimReplicationOutcome> {
    const signal = option.signal ?? option.controller?.signal;

    if (signal?.aborted) {
        Logger(`Replication cancelled`, LOG_LEVEL_VERBOSE);
        return { status: "cancelled" };
    }

    try {
        const [targetDBInfo, sourceDBInfo] = await Promise.all([targetDB.info(), sourceDB.info()]);
        const maxNumSeq = parseSeq(sourceDBInfo.update_seq);

        const outcome = await serialized(`replication-${targetDBInfo.db_name}-${sourceDBInfo.db_name}`, async () => {
            if (signal?.aborted) return { status: "cancelled" } as const;

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
                // Cancellation only prevents a new batch.  Once a batch has
                // passed this boundary, its writes and checkpoint are allowed
                // to settle so that `since` never advances ambiguously.
                if (signal?.aborted) return { status: "cancelled" } as const;

                const changes = await sourceDB.changes({ since, style: "all_docs", limit: batchSize });

                if (changes.results.length === 0) {
                    return signal?.aborted ? ({ status: "cancelled" } as const) : ({ status: "completed" } as const);
                }
                if (signal?.aborted) return { status: "cancelled" } as const;

                const changesResults = changes.results;
                const revsDiffParam = buildRevsDiffParam(changesResults);
                const diff = await targetDB.revsDiff(revsDiffParam);

                // No target mutation has started yet, so an abort received
                // while calculating the diff may safely leave this batch for a
                // later invocation.
                if (signal?.aborted) return { status: "cancelled" } as const;

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

                    // The source read has settled, but the target write has
                    // not begun.  Honour a cancellation received during the
                    // read without creating a partial target batch.
                    if (signal?.aborted) return { status: "cancelled" } as const;

                    // A missing source revision is not a successful batch.  Do
                    // not issue a partial target write or advance the
                    // checkpoint when the source could not provide all
                    // requested revisions.
                    const fetchedRevisionKeys = new Set(
                        fetchedDocs.map((doc) => `${doc._id}\u0000${String(doc._rev)}`)
                    );
                    const unavailableRequests = missingRequests.filter(
                        ({ id, rev }) => !fetchedRevisionKeys.has(`${id}\u0000${rev}`)
                    );
                    if (unavailableRequests.length > 0) {
                        const unavailableFailures = unavailableRequests.map<ShimReplicationWriteFailure>(
                            (request, index) => ({
                                index,
                                id: request.id,
                                revision: request.rev,
                                result: undefined,
                            })
                        );
                        throw new ShimReplicationError(
                            `Could not fetch ${unavailableRequests.length} required revision(s)`,
                            unavailableFailures
                        );
                    }

                    // There is deliberately no cancellation check after this
                    // call starts.  PouchDB does not provide an atomic abort
                    // for bulkDocs; let it settle and inspect every result.
                    const writeResults = await targetDB.bulkDocs(fetchedDocs, { new_edits: false });
                    const failedWrites = writeResults.flatMap<ShimReplicationWriteFailure>((result, index) => {
                        // Local PouchDB filters successful responses when
                        // `new_edits` is false, so an empty result array is the
                        // normal all-success response.  Conversely, any
                        // returned error is a failed required write.
                        if (isSuccessfulBulkDocResult(result)) return [];
                        const resultId =
                            typeof result === "object" && result !== null && "id" in result ? result.id : undefined;
                        const owningIndex =
                            typeof resultId === "string" ? fetchedDocs.findIndex((doc) => doc._id === resultId) : -1;
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
                    if (failedWrites.length > 0) {
                        throw new ShimReplicationError(
                            `Target rejected ${failedWrites.length} document write(s)`,
                            failedWrites
                        );
                    }

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

                if (signal?.aborted) return { status: "cancelled" } as const;
            }
        });
        Logger(outcome.status === "cancelled" ? `Replication cancelled` : `Replication completed`, LOG_LEVEL_VERBOSE);
        return outcome;
    } catch (ex) {
        if (signal?.aborted && isCancellationError(ex)) {
            Logger(`Replication cancelled`, LOG_LEVEL_VERBOSE);
            return { status: "cancelled" };
        }
        Logger(`Replication failed`, LOG_LEVEL_VERBOSE);
        Logger(ex, LOG_LEVEL_VERBOSE);
        throw ex;
    }
}
