import { _fetch } from "@lib/common/coreEnvFunctions";
import { LOG_LEVEL_VERBOSE, Logger } from "octagonal-wheels/common/logger";
import type { EntryDoc } from "@lib/common/models/db.definition";
import type { AnyEntry, EntryLeaf } from "@lib/common/models/db.type";

interface CouchChangeLine {
    seq: number | string;
    id: string;
    changes: Array<{ rev: string }>;
    doc?: EntryDoc;
    deleted?: boolean;
}

interface AnyDecryptedDoc {
    _id: string;
}

type DBSequence = number | string;

// This bounds one HTTP response without changing the smaller PouchDB write
// batches. Each completed page returns an opaque `last_seq` marker, which is
// the only page boundary Fast Fetch needs to persist and replay.
const FAST_FETCH_CHANGES_PAGE_LIMIT = 10_000;

// A heartbeat keeps a continuous feed open after its finite limit on CouchDB
// 3.2. Without a heartbeat, this timeout closes the feed after CouchDB has
// exhausted the currently available changes and lets it emit `last_seq`.
// Fast Fetch then reconnects from that cursor, so the short wait does not bound
// the duration of an active page transfer.
const FAST_FETCH_CHANGES_PAGE_TIMEOUT_MS = 1_000;

/**
 * Identifies the boundary at which Fast Fetch stopped.
 *
 * - `transport`: the request or response stream was interrupted. Only failures
 *   explicitly created at this boundary may be retried.
 * - `authentication`: CouchDB rejected the supplied credentials.
 * - `protocol`: CouchDB returned an unsuccessful or structurally invalid
 *   response, or an unexpected exception escaped the processing pipeline.
 * - `decryption`: a remote document could not be decrypted or did not produce a
 *   serialisable PouchDB document.
 * - `storage`: a local batch or its durable checkpoint could not be written.
 *
 * This remains a string-literal union because the values are discriminants, not
 * data to enumerate, persist, or map to user-interface labels. The constructor
 * and consumers therefore receive typo checking without a runtime constants
 * object becoming part of the package API.
 */
export type StreamingFetchFailureStage = "transport" | "authentication" | "protocol" | "decryption" | "storage";

/**
 * A classified Fast Fetch failure. Retryability is explicit rather than inferred
 * from the stage so that future exceptions can be narrowed without broadening all
 * failures at that boundary.
 */
export class StreamingFetchFailure extends Error {
    override readonly name = "StreamingFetchFailure";

    constructor(
        readonly stage: StreamingFetchFailureStage,
        message: string,
        readonly retryable: boolean,
        options?: { status?: number; cause?: unknown }
    ) {
        super(message, options?.cause === undefined ? undefined : { cause: options.cause });
        this.status = options?.status;
    }

    readonly status?: number;
}

export function isRetryableStreamingFetchFailure(error: unknown): error is StreamingFetchFailure {
    // Do not accept arbitrary errors which happen to contain `retryable: true`.
    // Only the streaming boundary is allowed to opt a failure into automatic retry.
    return error instanceof StreamingFetchFailure && error.retryable;
}

function errorMessage(error: unknown): string {
    if (error instanceof Error && error.message) return error.message;
    return String(error);
}

function asStreamingFetchFailure(error: unknown): StreamingFetchFailure {
    if (error instanceof StreamingFetchFailure) return error;
    // An unclassified processing exception has no proven recovery behaviour.
    // Fail closed instead of turning programmer defects into a retry loop.
    return new StreamingFetchFailure(
        "protocol",
        `Fast Fetch encountered an unexpected processing failure: ${errorMessage(error)}`,
        false,
        { cause: error }
    );
}

function transportFailure(operation: string, error: unknown): StreamingFetchFailure {
    return new StreamingFetchFailure("transport", `Fast Fetch could not ${operation}: ${errorMessage(error)}`, true, {
        cause: error,
    });
}

function responseFailure(response: Response, operation: string): StreamingFetchFailure {
    const status = response.status;
    if (status === 401 || status === 403) {
        return new StreamingFetchFailure(
            "authentication",
            `Fast Fetch could not ${operation}: CouchDB returned HTTP ${status}.`,
            false,
            { status }
        );
    }
    const retryable = status === 408 || status === 429 || status >= 500;
    return new StreamingFetchFailure(
        retryable ? "transport" : "protocol",
        `Fast Fetch could not ${operation}: CouchDB returned HTTP ${status}.`,
        retryable,
        { status }
    );
}

function ensureResponseOK(response: Response, operation: string): void {
    if (!response.ok) throw responseFailure(response, operation);
}

async function fetchResponse(url: string, init: RequestInit, operation: string): Promise<Response> {
    let response: Response;
    try {
        response = await _fetch(url, init);
    } catch (error) {
        throw transportFailure(operation, error);
    }
    ensureResponseOK(response, operation);
    return response;
}

async function readResponseText(response: Response, operation: string): Promise<string> {
    try {
        return await response.text();
    } catch (error) {
        throw transportFailure(operation, error);
    }
}

async function saveCheckpoint(
    onCheckpoint: ((sequence: DBSequence) => void | Promise<void>) | undefined,
    sequence: DBSequence
): Promise<void> {
    try {
        await onCheckpoint?.(sequence);
    } catch (error) {
        throw new StreamingFetchFailure(
            "storage",
            `Fast Fetch could not save its checkpoint: ${errorMessage(error)}`,
            false,
            { cause: error }
        );
    }
}

function generatePouchDBBatchWriter(
    downloadToDB: PouchDB.Database,
    decryptFunction: (doc: EntryDoc) => Promise<AnyEntry | EntryLeaf>,
    onCheckpoint?: (sequence: DBSequence) => void | Promise<void>
) {
    // The buffered documents and batchLastSequence form one persistence unit.
    // A checkpoint may describe this unit only after every document has been
    // accepted by PouchDB, preserving a contiguous durable prefix of the feed.
    let batchBuffer: AnyDecryptedDoc[] = [];
    let currentBatchSizeBytes = 0;
    let batchLastSequence: DBSequence | undefined;

    const BATCH_ITEM_LIMIT = 100;
    const BATCH_SIZE_LIMIT = 2 * 1024 * 1024;

    const flush = async () => {
        if (batchBuffer.length === 0) return;

        const documents = batchBuffer;
        const checkpoint = batchLastSequence;
        let results: Array<PouchDB.Core.Response | PouchDB.Core.Error>;
        try {
            results = await downloadToDB.bulkDocs(documents, { new_edits: false });
        } catch (error) {
            throw new StreamingFetchFailure(
                "storage",
                `Fast Fetch could not write a batch to the local database: ${errorMessage(error)}`,
                false,
                { cause: error }
            );
        }

        // With new_edits:false, PouchDB may omit successful results and return an
        // empty array. Inspect every returned item for an error instead of expecting
        // one success result per input document.
        const failedResult = results.find(
            (result): result is PouchDB.Core.Error => "error" in result && Boolean(result.error)
        );
        if (failedResult) {
            const detail = failedResult.message || failedResult.name || "the local database rejected a document";
            throw new StreamingFetchFailure(
                "storage",
                `Fast Fetch could not write a batch to the local database: ${detail}`,
                false,
                { cause: failedResult }
            );
        }

        if (checkpoint !== undefined) {
            await saveCheckpoint(onCheckpoint, checkpoint);
        }
        // Clear the unit only after both persistence operations succeed. If saving
        // the checkpoint fails, a later invocation safely replays the already-written
        // revisions because new_edits:false is idempotent for those revisions.
        batchBuffer = [];
        currentBatchSizeBytes = 0;
        batchLastSequence = undefined;
    };

    return {
        async write(doc: EntryDoc, sequence: DBSequence) {
            let decryptedDoc: AnyEntry | EntryLeaf;
            try {
                decryptedDoc = await decryptFunction(doc);
            } catch (error) {
                throw new StreamingFetchFailure(
                    "decryption",
                    `Fast Fetch could not decrypt a document: ${errorMessage(error)}`,
                    false,
                    { cause: error }
                );
            }

            let serialisedDoc: string;
            try {
                const serialised = JSON.stringify(decryptedDoc);
                if (serialised === undefined) throw new Error("the decrypted value is not a document");
                serialisedDoc = serialised;
            } catch (error) {
                throw new StreamingFetchFailure(
                    "decryption",
                    `Fast Fetch produced an invalid decrypted document: ${errorMessage(error)}`,
                    false,
                    { cause: error }
                );
            }
            batchBuffer.push(decryptedDoc);
            currentBatchSizeBytes += serialisedDoc.length;
            batchLastSequence = sequence;

            if (batchBuffer.length >= BATCH_ITEM_LIMIT || currentBatchSizeBytes >= BATCH_SIZE_LIMIT) {
                await flush();
            }
        },
        async flushThrough(sequence: DBSequence) {
            // A changes row may legitimately have no included document. Earlier
            // buffered rows must still become durable before its sequence can be
            // recorded, otherwise the checkpoint would jump over unwritten content.
            await flush();
            await saveCheckpoint(onCheckpoint, sequence);
        },
        flush,
        abort() {
            batchBuffer = [];
            currentBatchSizeBytes = 0;
            batchLastSequence = undefined;
        },
    };
}

function setParamsToURL(url: URL, params: Record<string, string>) {
    for (const [key, value] of Object.entries(params)) {
        url.searchParams.set(key, value);
    }
    return url;
}

export type FetchChangesForInitialSyncProgress = {
    totalFetched: number;
    totalValidFetched: number;
    targetSeq: number | string;
    docsToFetch: number;
    totalBytes: number;
};

type DatabaseSyncStatus = {
    last_seq?: DBSequence;
    pending?: number;
    results?: unknown[];
};

type ParsedChangesFeedLine =
    | { type: "change"; change: CouchChangeLine }
    | { type: "terminator"; lastSequence: DBSequence };

function parseStatusSource(source: string): DatabaseSyncStatus {
    const trimmed = source.trim();
    if (!trimmed) {
        throw new StreamingFetchFailure("protocol", "Fast Fetch received no changes status from CouchDB.", false);
    }

    const candidates = [trimmed, ...trimmed.split("\n").reverse().filter(Boolean)];
    for (const candidate of candidates) {
        try {
            const parsed = JSON.parse(candidate) as unknown;
            if (parsed && typeof parsed === "object") return parsed as DatabaseSyncStatus;
        } catch {
            // Try the final non-blank line when a proxy has returned an NDJSON response.
        }
    }
    throw new StreamingFetchFailure("protocol", "Fast Fetch received an invalid changes status from CouchDB.", false);
}

function parseChangesFeedLine(line: string): ParsedChangesFeedLine {
    let parsed: unknown;
    try {
        parsed = JSON.parse(line);
    } catch (error) {
        throw new StreamingFetchFailure("protocol", "Fast Fetch received a malformed changes-feed row.", false, {
            cause: error,
        });
    }
    if (!parsed || typeof parsed !== "object") {
        throw new StreamingFetchFailure("protocol", "Fast Fetch received an invalid changes-feed line.", false);
    }
    if (!("seq" in parsed) && "last_seq" in parsed) {
        const lastSequence = (parsed as DatabaseSyncStatus).last_seq;
        if (lastSequence === undefined) {
            throw new StreamingFetchFailure(
                "protocol",
                "Fast Fetch received a changes-feed terminator without a sequence.",
                false
            );
        }
        return { type: "terminator", lastSequence };
    }
    if (!("seq" in parsed)) {
        throw new StreamingFetchFailure(
            "protocol",
            "Fast Fetch received a changes-feed row without a sequence.",
            false
        );
    }
    const change = parsed as Partial<CouchChangeLine>;
    if (change.seq === undefined || (change.doc !== undefined && (!change.doc || typeof change.doc !== "object"))) {
        throw new StreamingFetchFailure("protocol", "Fast Fetch received an invalid changes-feed row.", false);
    }
    return { type: "change", change: change as CouchChangeLine };
}

/**
 * Fetches initial data from CouchDB as a stream and writes it into PouchDB.
 * @param downloadToDB PouchDB instance.
 * @param remoteDbUrl CouchDB database URL (for example: 'https://xxx.com/mydb').
 * @param authHeader Value of the `Authorization` header for CouchDB.
 * @param decryptFunction Function to decrypt each document.
 * @param since Sequence ID to start fetching changes from (default is '0').
 * @param customHeaders Additional request headers required by the CouchDB endpoint or its reverse proxy.
 */
export async function fetchChangesForInitialSync(
    downloadToDB: PouchDB.Database,
    remoteDbUrl: string,
    authHeader: string,
    decryptFunction: (doc: EntryDoc) => Promise<AnyEntry | EntryLeaf>,
    since: number | string = "0",
    onProgress?: (progress: FetchChangesForInitialSyncProgress) => void,
    onCheckpoint?: (sequence: DBSequence) => void | Promise<void>,
    customHeaders?: Record<string, string>
): Promise<void> {
    let totalFetched = 0;
    let totalValidFetched = 0;
    let totalBytes = 0;
    const changesBaseParams = {
        feed: "continuous",
        include_docs: "true",
        style: "all_docs",
        conflicts: "true",
        revs: "true",
        since: since.toString(),
    } as const;
    const fetchHeaders = new Headers(customHeaders);
    fetchHeaders.set("Accept", "application/json");
    // Credentials belong to the selected CouchDB configuration. Normalising the
    // names through Headers prevents a differently-cased custom key from
    // overriding them.
    fetchHeaders.set("Authorization", authHeader);

    // Capture a progress target from _changes itself. This is deliberately only a
    // progress hint: a clustered row `seq` and a feed-level `last_seq` can represent
    // related positions using different opaque values. Completion is established
    // by per-page probes and finite page terminators below, never by comparing this
    // target with another token.
    const targetURL = setParamsToURL(new URL(`${remoteDbUrl}/_changes`), {
        ...changesBaseParams,
        feed: "normal",
        since: "now",
        limit: "1",
        include_docs: "false",
    });
    const targetResponse = await fetchResponse(
        targetURL.toString(),
        { headers: fetchHeaders },
        "capture the changes target"
    );
    const targetStatus = parseStatusSource(await readResponseText(targetResponse, "read the changes target"));
    const progressTargetSeq = targetStatus.last_seq;
    if (progressTargetSeq === undefined) {
        throw new StreamingFetchFailure(
            "protocol",
            "Fast Fetch could not obtain a changes progress target from CouchDB.",
            false
        );
    }

    const batchWriter = generatePouchDBBatchWriter(downloadToDB, decryptFunction, onCheckpoint);
    let docsToFetch = 0;
    let lastProgress = 0;
    let lastReportTime = Date.now();

    const reportProgress = (force = false) => {
        if (!force && totalFetched - lastProgress < 25 && Date.now() - lastReportTime < 2000) return;
        lastProgress = totalFetched;
        lastReportTime = Date.now();
        onProgress?.({
            totalFetched,
            totalValidFetched,
            targetSeq: progressTargetSeq,
            docsToFetch,
            totalBytes,
        });
    };

    const readAvailableChanges = async (pageSince: DBSequence): Promise<number> => {
        // The normal probe and continuous page intentionally start from the same
        // opaque cursor and use the same style and filter selection. A GET does not
        // consume changes on the server; include_docs=false only removes the bodies.
        //
        // Use limit=1 rather than limit=0. CouchDB's API documentation describes
        // zero as equivalent to one, but supported CouchDB releases have also been
        // observed to return zero rows and keep the full count in `pending`. One
        // explicit result makes `results.length + pending` portable across both
        // behaviours and ensures that a final returned row is not mistaken for no
        // work when `pending` itself is zero.
        const statusURL = setParamsToURL(new URL(`${remoteDbUrl}/_changes`), {
            ...changesBaseParams,
            feed: "normal",
            since: pageSince.toString(),
            limit: "1",
            include_docs: "false",
        });
        const response = await fetchResponse(
            statusURL.toString(),
            { method: "GET", headers: fetchHeaders },
            "read changes status"
        );
        const status = parseStatusSource(await readResponseText(response, "read changes status"));
        if (!Array.isArray(status.results)) {
            throw new StreamingFetchFailure(
                "protocol",
                "Fast Fetch received changes status without a valid results list.",
                false
            );
        }
        const pending = status.pending;
        if (typeof pending !== "number" || !Number.isSafeInteger(pending) || pending < 0) {
            throw new StreamingFetchFailure(
                "protocol",
                "Fast Fetch received changes status without a valid pending count.",
                false
            );
        }
        const available = status.results.length + pending;
        if (!Number.isSafeInteger(available)) {
            throw new StreamingFetchFailure(
                "protocol",
                "Fast Fetch received a changes count outside the supported range.",
                false
            );
        }
        return available;
    };

    const fetchPage = async (pageSince: DBSequence, pageLimit: number): Promise<DBSequence> => {
        const controller = new AbortController();
        let reader: ReadableStreamDefaultReader<string> | undefined;
        let buffer = "";
        let fetchedRows = 0;

        const processLine = async (line: string): Promise<DBSequence | undefined> => {
            const parsed = parseChangesFeedLine(line);
            if (parsed.type === "terminator") {
                if (fetchedRows === 0) {
                    throw new StreamingFetchFailure(
                        "transport",
                        "Fast Fetch received no rows after its status probe reported available changes.",
                        true
                    );
                }
                // The status probe and this stream are separate requests, not a locked
                // snapshot. A valid page may therefore be shorter than the estimate.
                // Make its documents durable, persist its opaque terminator verbatim,
                // and let the next normal probe establish whether more work remains.
                await batchWriter.flush();
                await saveCheckpoint(onCheckpoint, parsed.lastSequence);
                reportProgress(true);
                return parsed.lastSequence;
            }

            if (fetchedRows >= pageLimit) {
                throw new StreamingFetchFailure(
                    "protocol",
                    `Fast Fetch received more than its ${pageLimit}-row page limit.`,
                    false
                );
            }
            const change = parsed.change;
            // CouchDB's limit counts outer result rows. Tombstones and rows without
            // an included document each consume one slot; multiple leaf revisions in
            // the inner `changes` array do not. Count the row before deciding whether
            // it requires a local document write.
            fetchedRows++;
            totalFetched++;
            if (change.doc) {
                await batchWriter.write(change.doc, change.seq);
                totalValidFetched++;
            } else {
                await batchWriter.flushThrough(change.seq);
            }
            reportProgress();
            return undefined;
        };

        try {
            const changesURL = setParamsToURL(new URL(`${remoteDbUrl}/_changes`), {
                ...changesBaseParams,
                since: pageSince.toString(),
                limit: pageLimit.toString(),
                timeout: FAST_FETCH_CHANGES_PAGE_TIMEOUT_MS.toString(),
            });
            const response = await fetchResponse(
                changesURL.toString(),
                {
                    method: "GET",
                    headers: fetchHeaders,
                    signal: controller.signal,
                },
                "open the changes feed"
            );
            if (!response.body) {
                throw new StreamingFetchFailure(
                    "protocol",
                    "Fast Fetch could not read the CouchDB response stream.",
                    false
                );
            }

            const decoder = new TextDecoder();
            const byteCountingDecoderStream = new TransformStream<Uint8Array, string>({
                transform(chunk, streamController) {
                    totalBytes += chunk.byteLength;
                    const decoded = decoder.decode(chunk, { stream: true });
                    if (decoded) streamController.enqueue(decoded);
                },
                flush(streamController) {
                    const decoded = decoder.decode();
                    if (decoded) streamController.enqueue(decoded);
                },
            });
            reader = response.body.pipeThrough(byteCountingDecoderStream).getReader();

            while (true) {
                reportProgress();
                let readResult: ReadableStreamReadResult<string>;
                try {
                    readResult = await reader.read();
                } catch (error) {
                    throw transportFailure("read the changes feed", error);
                }

                if (readResult.done) {
                    if (buffer.trim()) {
                        const lastSequence = await processLine(buffer);
                        if (lastSequence !== undefined) return lastSequence;
                    }
                    await batchWriter.flush();
                    throw new StreamingFetchFailure(
                        "transport",
                        "The bounded CouchDB changes feed ended without a last_seq terminator.",
                        true
                    );
                }

                buffer += readResult.value;
                const lines = buffer.split("\n");
                buffer = lines.pop() || "";
                for (const line of lines) {
                    if (!line.trim()) continue;
                    const lastSequence = await processLine(line);
                    if (lastSequence !== undefined) return lastSequence;
                }
            }
        } finally {
            controller.abort();
            if (reader) {
                try {
                    await reader.cancel();
                } catch {
                    // The stream may already be closed or errored at this point.
                }
                reader.releaseLock();
            }
        }
    };

    try {
        let pageSince: DBSequence = since;
        let started = false;
        while (true) {
            const available = await readAvailableChanges(pageSince);
            // A later probe may observe writes which arrived after the initial
            // progress target. Keep the denominator useful without treating it as a
            // completion contract.
            docsToFetch = Math.max(docsToFetch, totalFetched + available);
            if (available === 0) break;

            if (!started) {
                started = true;
                Logger(
                    `Starting initial synchronisation. Current sequence: ${since}, Target sequence: ${progressTargetSeq}, Documents to fetch: ${docsToFetch}.`
                );
            }
            const pageLimit = Math.min(FAST_FETCH_CHANGES_PAGE_LIMIT, available);
            const pageTerminator = await fetchPage(pageSince, pageLimit);
            // Treat last_seq as an opaque cursor: store and replay the exact value.
            // Do not compare it with a row token, target token, or later probe token.
            pageSince = pageTerminator;
        }
        if (started) {
            Logger("Fast Fetch is caught up and durable in the local database.");
            reportProgress(true);
        } else {
            Logger("No changes remain for Fast Fetch.");
        }
    } catch (error) {
        const failure = asStreamingFetchFailure(error);
        if (failure.stage !== "storage") {
            // Preserve useful work before a later protocol, transport, or decryption
            // failure. A storage failure is not flushed again here because the failed
            // batch may already be partly applied; the retained older checkpoint makes
            // replay explicit and idempotent on the next invocation.
            try {
                await batchWriter.flush();
            } catch (flushError) {
                batchWriter.abort();
                throw asStreamingFetchFailure(flushError);
            }
        }
        batchWriter.abort();
        Logger(`Fast Fetch failed during ${failure.stage}.`, LOG_LEVEL_VERBOSE);
        Logger(failure, LOG_LEVEL_VERBOSE);
        throw failure;
    }
}
