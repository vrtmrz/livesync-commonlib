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
};

function isTargetSequence(sequence: DBSequence | undefined, targetSequence: DBSequence | undefined): boolean {
    if (sequence === undefined || targetSequence === undefined) return false;
    return sequence.toString() === targetSequence.toString();
}

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

function parseChangeLine(line: string): CouchChangeLine {
    let parsed: unknown;
    try {
        parsed = JSON.parse(line);
    } catch (error) {
        throw new StreamingFetchFailure("protocol", "Fast Fetch received a malformed changes-feed row.", false, {
            cause: error,
        });
    }
    if (!parsed || typeof parsed !== "object" || !("seq" in parsed)) {
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
    return change as CouchChangeLine;
}

/**
 * Fetches initial data from CouchDB as a stream and writes it into PouchDB.
 * @param downloadToDB PouchDB instance.
 * @param remoteDbUrl CouchDB database URL (for example: 'https://xxx.com/mydb').
 * @param decryptFunction Function to decrypt each document.
 * @param since Sequence ID to start fetching changes from (default is '0').
 */
export async function fetchChangesForInitialSync(
    downloadToDB: PouchDB.Database,
    remoteDbUrl: string,
    authHeader: string,
    decryptFunction: (doc: EntryDoc) => Promise<AnyEntry | EntryLeaf>,
    since: number | string = "0",
    onProgress?: (progress: FetchChangesForInitialSyncProgress) => void,
    onCheckpoint?: (sequence: DBSequence) => void | Promise<void>
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
        heartbeat: "30000",
    } as const;
    const fetchHeaders = {
        Accept: "application/json",
        Authorization: authHeader,
    };

    // Capture the completion boundary from _changes itself. CouchDB treats sequence
    // tokens as opaque, and a clustered database may encode update_seq from database
    // information differently from a row at the same logical changes position.
    const targetURL = setParamsToURL(new URL(`${remoteDbUrl}/_changes`), {
        ...changesBaseParams,
        feed: "normal",
        since: "now",
        limit: "0",
    });
    const targetResponse = await fetchResponse(
        targetURL.toString(),
        { headers: fetchHeaders },
        "capture the changes target"
    );
    const targetStatus = parseStatusSource(await readResponseText(targetResponse, "read the changes target"));
    const finalTargetSeq = targetStatus.last_seq;
    if (finalTargetSeq === undefined) {
        throw new StreamingFetchFailure(
            "protocol",
            "Fast Fetch could not obtain an authoritative changes target from CouchDB.",
            false
        );
    }
    if (isTargetSequence(since, finalTargetSeq)) {
        Logger("Already at the target sequence. Initial data synchronisation is complete.");
        return;
    }

    const fetchURL = setParamsToURL(new URL(`${remoteDbUrl}/_changes`), {
        ...changesBaseParams,
        feed: "normal",
        limit: "0",
    });
    const infoResponse = await fetchResponse(fetchURL.toString(), { headers: fetchHeaders }, "read changes status");
    const info = parseStatusSource(await readResponseText(infoResponse, "read changes status"));
    if (typeof info.pending !== "number" || info.pending < 0) {
        throw new StreamingFetchFailure(
            "protocol",
            "Fast Fetch received changes status without a valid pending count.",
            false
        );
    }
    // `pending` is useful for progress, but it is not a completion boundary. A
    // filtered or clustered feed can make document counts diverge from sequence
    // movement, so only the captured target token can complete a non-empty fetch.
    const pendingDocs = info.pending;
    const docsToFetch = pendingDocs;
    if (pendingDocs === 0) {
        // This status request is made after the target was captured. No changes after
        // the durable `since` position therefore proves that the captured target also
        // represents durable empty work, including for a newly created database.
        await saveCheckpoint(onCheckpoint, finalTargetSeq);
        Logger("No changes remain before the captured Fast Fetch target.");
        return;
    }

    Logger(
        `Starting initial synchronisation. Current sequence: ${since}, Target sequence: ${finalTargetSeq}, Estimated documents to fetch: ${docsToFetch}.`
    );

    const controller = new AbortController();
    const changesURL = setParamsToURL(new URL(`${remoteDbUrl}/_changes`), changesBaseParams);
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
        throw new StreamingFetchFailure("protocol", "Fast Fetch could not read the CouchDB response stream.", false);
    }

    const sizeCaptureStream = new TransformStream({
        transform(chunk, streamController) {
            totalBytes += chunk.byteLength;
            streamController.enqueue(chunk);
        },
    });
    const reader = response.body.pipeThrough(sizeCaptureStream).pipeThrough(new TextDecoderStream()).getReader();
    const batchWriter = generatePouchDBBatchWriter(downloadToDB, decryptFunction, onCheckpoint);
    let buffer = "";
    let lastProgress = 0;
    let lastReportTime = Date.now();

    const reportProgress = () => {
        if (totalFetched - lastProgress < 25 && Date.now() - lastReportTime < 2000) return;
        lastProgress = totalFetched;
        lastReportTime = Date.now();
        onProgress?.({
            totalFetched,
            totalValidFetched,
            targetSeq: finalTargetSeq,
            docsToFetch,
            totalBytes,
        });
    };

    const processLine = async (line: string): Promise<boolean> => {
        const parsed = parseChangeLine(line);
        totalFetched++;
        if (parsed.doc) {
            await batchWriter.write(parsed.doc, parsed.seq);
            totalValidFetched++;
        } else {
            await batchWriter.flushThrough(parsed.seq);
        }
        reportProgress();
        if (!isTargetSequence(parsed.seq, finalTargetSeq)) return false;

        // `write` may still hold the target row in memory. Completion is reported only
        // after the target and every preceding row have crossed the persistence and
        // checkpoint boundary.
        await batchWriter.flush();
        Logger("The captured Fast Fetch target is durable in the local database.");
        controller.abort();
        reportProgress();
        return true;
    };

    try {
        while (true) {
            reportProgress();
            let readResult: ReadableStreamReadResult<string>;
            try {
                readResult = await reader.read();
            } catch (error) {
                throw transportFailure("read the changes feed", error);
            }

            if (readResult.done) {
                if (buffer.trim() && (await processLine(buffer))) return;
                await batchWriter.flush();
                throw new StreamingFetchFailure(
                    "transport",
                    "The CouchDB changes feed ended before Fast Fetch reached its captured target.",
                    true
                );
            }

            buffer += readResult.value;
            const lines = buffer.split("\n");
            buffer = lines.pop() || "";
            for (const line of lines) {
                if (!line.trim()) continue;
                if (await processLine(line)) return;
            }
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
    } finally {
        // Releasing a reader lock does not cancel its underlying continuous HTTP
        // response. Abort the transport on every exit, then cancel the decoded
        // stream as a fallback for stream implementations which do not observe the
        // request signal directly.
        controller.abort();
        try {
            await reader.cancel();
        } catch {
            // The stream may already be closed or errored at this point.
        }
        reader.releaseLock();
    }
}
