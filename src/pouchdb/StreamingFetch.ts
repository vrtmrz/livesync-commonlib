import { _fetch } from "@lib/common/coreEnvFunctions";
import { LOG_LEVEL_VERBOSE, Logger } from "octagonal-wheels/common/logger";
import type { EntryDoc } from "@lib/common/models/db.definition";
import type { AnyEntry, EntryLeaf } from "@lib/common/models/db.type";
import { VERSIONING_DOCID } from "@lib/common/types";
import { assessRemoteFeatureDocument, describeRemoteFeatureRejection } from "./remoteFeatureCompatibility";
import { assertMatchingPathIdentityFeature } from "./pathIdentityCompatibility";

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

interface RevisionRef {
    id: string;
    rev: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function revisionRefKey(ref: RevisionRef): string {
    return `${ref.id}\u0000${ref.rev}`;
}

function parseRevisionIdentifier(rev: string): { generation: number; hash: string } | undefined {
    const separator = rev.indexOf("-");
    if (separator <= 0) return undefined;
    const generationText = rev.slice(0, separator);
    const hash = rev.slice(separator + 1);
    if (!/^[1-9]\d*$/.test(generationText) || hash.length === 0 || hash.trim() !== hash) return undefined;
    const generation = Number(generationText);
    if (!Number.isSafeInteger(generation)) return undefined;
    return { generation, hash };
}

function ensureRevisionIdentity(value: unknown, ref: RevisionRef): Record<string, unknown> {
    if (!isObject(value) || value._id !== ref.id || value._rev !== ref.rev) {
        throw new StreamingFetchFailure(
            "protocol",
            `Fast Fetch received an invalid body for revision ${ref.id}@${ref.rev}.`,
            false
        );
    }
    if (value._deleted !== undefined && value._deleted !== true) {
        throw new StreamingFetchFailure(
            "protocol",
            `Fast Fetch received an invalid deletion marker for revision ${ref.id}@${ref.rev}.`,
            false
        );
    }
    return value;
}

function hasValidRevisionAncestry(value: Record<string, unknown>, revision: { generation: number; hash: string }): boolean {
    const revisions = value._revisions;
    return (
        isObject(revisions) &&
        Number.isSafeInteger(revisions.start) &&
        revisions.start === revision.generation &&
        Array.isArray(revisions.ids) &&
        revisions.ids.length > 0 &&
        revisions.ids.length <= revision.generation &&
        revisions.ids[0] === revision.hash &&
        revisions.ids.every((id) => typeof id === "string" && id.length > 0)
    );
}

function ensureRevisionDocument(value: unknown, ref: RevisionRef): EntryDoc {
    const document = ensureRevisionIdentity(value, ref);
    const revision = parseRevisionIdentifier(ref.rev);
    if (
        revision === undefined ||
        !hasValidRevisionAncestry(document, revision)
    ) {
        throw new StreamingFetchFailure(
            "protocol",
            `Fast Fetch received revision ${ref.id}@${ref.rev} without valid revision ancestry.`,
            false
        );
    }
    return document as unknown as EntryDoc;
}

class BulkGetResponseTooLargeError extends Error {
    override readonly name = "BulkGetResponseTooLargeError";
}

// This bounds one HTTP response without changing the smaller PouchDB write
// batches. Each completed page returns an opaque `last_seq` marker, which is
// the only page boundary Fast Fetch needs to persist and replay.
const FAST_FETCH_CHANGES_PAGE_LIMIT = 10_000;

// Keep revision lookup requests and their response bodies small while allowing
// conflicts from several changes rows to share one _bulk_get request.
const FAST_FETCH_REVISION_GROUP_LIMIT = 100;
const FAST_FETCH_REVISION_GROUP_BYTE_LIMIT = 512 * 1024;

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

async function readResponseTextBounded(
    response: Response,
    operation: string,
    maxBytes: number
): Promise<{ text: string; byteLength: number }> {
    if (!response.body) {
        const text = await readResponseText(response, operation);
        const byteLength = new TextEncoder().encode(text).byteLength;
        if (byteLength > maxBytes) throw new BulkGetResponseTooLargeError();
        return { text, byteLength };
    }

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let byteLength = 0;
    try {
        while (true) {
            let result: ReadableStreamReadResult<Uint8Array>;
            try {
                result = await reader.read();
            } catch (error) {
                throw transportFailure(operation, error);
            }
            if (result.done) break;
            byteLength += result.value.byteLength;
            if (byteLength > maxBytes) {
                try {
                    await reader.cancel();
                } catch {
                    // The response may already have ended while the size was checked.
                }
                throw new BulkGetResponseTooLargeError();
            }
            chunks.push(result.value);
        }
    } finally {
        reader.releaseLock();
    }

    const bytes = new Uint8Array(byteLength);
    let offset = 0;
    for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return { text: new TextDecoder().decode(bytes), byteLength };
}

/** Check remote feature requirements before Fast Fetch opens or resets the local database. */
export async function checkRemoteFeaturesForInitialSync(
    remoteDbUrl: string,
    authHeader: string,
    customHeaders?: Record<string, string>,
    settings: { pathNormalizationVersion?: number } = {}
): Promise<void> {
    const headers = new Headers(customHeaders);
    headers.set("Accept", "application/json");
    headers.set("Authorization", authHeader);
    const url = new URL(`${remoteDbUrl}/_all_docs`);
    url.searchParams.set("keys", JSON.stringify([VERSIONING_DOCID]));
    url.searchParams.set("include_docs", "true");
    const operation = "check remote feature requirements";
    const response = await fetchResponse(url.toString(), { headers }, operation);
    const text = await readResponseText(response, operation);
    let result: { total_rows?: number; rows?: Array<{ key?: string; error?: string; doc?: unknown }> };
    try {
        result = JSON.parse(text);
    } catch (cause) {
        throw new StreamingFetchFailure("protocol", "The remote feature response is invalid.", false, { cause });
    }
    if (!Array.isArray(result?.rows) || result.rows.length !== 1 || result.rows[0]?.key !== VERSIONING_DOCID) {
        throw new StreamingFetchFailure("protocol", "The remote feature response is invalid.", false);
    }
    const row = result.rows[0];
    // An empty remote is initialised by the existing completion path. A missing
    // version document in a populated remote must not erase the local database.
    if (result.total_rows === 0 && row.error === "not_found") return;
    const assessment = assessRemoteFeatureDocument(row.doc);
    assertMatchingPathIdentityFeature(row.doc, settings);
    // Keep legacy migration in the existing Replicator completion path.
    if (assessment.status === "supported" || assessment.status === "older-generation") return;
    throw new StreamingFetchFailure("protocol", describeRemoteFeatureRejection(assessment), false);
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
    onCheckpoint?: (sequence: DBSequence) => void | Promise<void>,
    onStoredRevisions?: (revisions: readonly { id: string; rev: string }[]) => void | Promise<void>
) {
    // The buffered documents and checkpoint candidate form one persistence unit.
    // A checkpoint may describe it only after every document has been accepted by
    // PouchDB, preserving a contiguous durable prefix of the feed.
    let batchBuffer: AnyDecryptedDoc[] = [];
    let batchStoredRevisions: Array<{ id: string; rev: string }> = [];
    let batchRevisionKeys = new Set<string>();
    let currentBatchSizeBytes = 0;
    let batchCheckpointSequence: DBSequence | undefined;

    const BATCH_ITEM_LIMIT = 100;
    const BATCH_SIZE_LIMIT = 2 * 1024 * 1024;

    const flush = async () => {
        const documents = batchBuffer;
        const storedRevisions = batchStoredRevisions;
        const checkpoint = batchCheckpointSequence;
        if (documents.length > 0) {
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

            try {
                await onStoredRevisions?.(storedRevisions);
            } catch (error) {
                throw new StreamingFetchFailure(
                    "storage",
                    `Fast Fetch could not record stored revision identities: ${errorMessage(error)}`,
                    false,
                    { cause: error }
                );
            }
        }

        if (checkpoint !== undefined) {
            await saveCheckpoint(onCheckpoint, checkpoint);
        }
        // Clear the unit only after both persistence operations succeed. If saving
        // the checkpoint fails, a later invocation safely replays the already-written
        // revisions because new_edits:false is idempotent for those revisions.
        batchBuffer = [];
        batchStoredRevisions = [];
        batchRevisionKeys = new Set();
        currentBatchSizeBytes = 0;
        batchCheckpointSequence = undefined;
    };

    const prepare = async (doc: EntryDoc): Promise<{ document: AnyEntry | EntryLeaf; serialisedSize: number }> => {
        let decryptedDoc: AnyEntry | EntryLeaf;
        if (doc._deleted) {
            // A deletion tombstone carries no encrypted payload to decrypt.
            // Pass it through unchanged so the local database records the
            // deletion. Some decryption implementations require a path on
            // obfuscated entries (f: ids) and throw for tombstones, which
            // would otherwise abort the whole fetch at the first deleted
            // document in the feed.
            decryptedDoc = doc as unknown as AnyEntry;
        } else {
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
        return { document: decryptedDoc, serialisedSize: serialisedDoc.length };
    };

    const writePrepared = async (
        prepared: { document: AnyEntry | EntryLeaf; serialisedSize: number },
        revision: RevisionRef
    ) => {
        const key = revisionRefKey(revision);
        if (batchRevisionKeys.has(key)) return;
        batchBuffer.push(prepared.document);
        batchStoredRevisions.push({ id: revision.id, rev: revision.rev });
        batchRevisionKeys.add(key);
        currentBatchSizeBytes += prepared.serialisedSize;

        if (batchBuffer.length >= BATCH_ITEM_LIMIT || currentBatchSizeBytes >= BATCH_SIZE_LIMIT) {
            await flush();
        }
    };

    const write = async (doc: EntryDoc, revision: RevisionRef) => {
        await writePrepared(await prepare(doc), revision);
    };

    return {
        prepare,
        writePrepared,
        write,
        async advanceCheckpoint(sequence: DBSequence) {
            // Revision bodies for one changes row may be fetched in several bounded
            // groups. The caller advances this candidate only after every leaf in
            // that row is known to be present locally. A threshold-triggered flush
            // during a later, incomplete row therefore cannot checkpoint past it.
            batchCheckpointSequence = sequence;
            if (batchBuffer.length === 0) await flush();
        },
        hasPendingRevision(revision: RevisionRef) {
            return batchRevisionKeys.has(revisionRefKey(revision));
        },
        flush,
        abort() {
            batchBuffer = [];
            batchStoredRevisions = [];
            batchRevisionKeys = new Set();
            currentBatchSizeBytes = 0;
            batchCheckpointSequence = undefined;
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
 * @param onStoredRevisions Observes revision identities after their complete local batch is persisted.
 */
export async function fetchChangesForInitialSync(
    downloadToDB: PouchDB.Database,
    remoteDbUrl: string,
    authHeader: string,
    decryptFunction: (doc: EntryDoc) => Promise<AnyEntry | EntryLeaf>,
    since: number | string = "0",
    onProgress?: (progress: FetchChangesForInitialSyncProgress) => void,
    onCheckpoint?: (sequence: DBSequence) => void | Promise<void>,
    customHeaders?: Record<string, string>,
    onStoredRevisions?: (revisions: readonly { id: string; rev: string }[]) => void | Promise<void>
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
    const bulkGetHeaders = new Headers(fetchHeaders);
    bulkGetHeaders.set("Content-Type", "application/json");

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

    const batchWriter = generatePouchDBBatchWriter(downloadToDB, decryptFunction, onCheckpoint, onStoredRevisions);
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

    interface ChangeRowProgress {
        sequence: DBSequence;
        pendingRevisions: number;
        complete: boolean;
    }

    interface PendingRevision {
        ref: RevisionRef;
        rows: Set<ChangeRowProgress>;
        includedDocument?: { document: AnyEntry | EntryLeaf; serialisedSize: number };
    }

    const rowProgress: ChangeRowProgress[] = [];
    let nextCheckpointRow = 0;
    const pendingRevisions = new Map<string, PendingRevision>();
    let pendingRevisionBytes = 0;
    const pendingRemoteRevisions = new Map<string, PendingRevision>();
    let pendingRemoteRevisionBytes = 0;

    const releaseCompletedRows = async () => {
        while (nextCheckpointRow < rowProgress.length && rowProgress[nextCheckpointRow].complete) {
            await batchWriter.advanceCheckpoint(rowProgress[nextCheckpointRow].sequence);
            nextCheckpointRow++;
        }
    };

    const settleRevision = (revision: PendingRevision) => {
        for (const row of revision.rows) {
            row.pendingRevisions--;
            if (row.pendingRevisions === 0) row.complete = true;
        }
    };

    const markRevisionDurable = async (revision: PendingRevision, doc: EntryDoc) => {
        await batchWriter.write(doc, revision.ref);
        settleRevision(revision);
    };

    const markPreparedRevisionDurable = async (
        revision: PendingRevision,
        prepared: { document: AnyEntry | EntryLeaf; serialisedSize: number }
    ) => {
        await batchWriter.writePrepared(prepared, revision.ref);
        settleRevision(revision);
    };

    const makeBulkGetURL = () => {
        const url = new URL(`${remoteDbUrl}/_bulk_get`);
        url.searchParams.set("revs", "true");
        return url;
    };

    const parseBulkGetDocuments = (source: string, refs: PendingRevision[]): Map<string, EntryDoc> => {
        let parsed: unknown;
        try {
            parsed = JSON.parse(source);
        } catch (cause) {
            throw new StreamingFetchFailure("protocol", "Fast Fetch received an invalid _bulk_get response.", false, {
                cause,
            });
        }
        if (!isObject(parsed) || !Array.isArray(parsed.results)) {
            throw new StreamingFetchFailure("protocol", "Fast Fetch received an invalid _bulk_get response.", false);
        }

        const expected = new Map(refs.map((revision) => [revisionRefKey(revision.ref), revision.ref]));
        const documents = new Map<string, EntryDoc>();
        for (const result of parsed.results) {
            if (!isObject(result) || typeof result.id !== "string" || !Array.isArray(result.docs)) {
                throw new StreamingFetchFailure(
                    "protocol",
                    "Fast Fetch received a malformed _bulk_get result.",
                    false
                );
            }
            for (const item of result.docs) {
                if (!isObject(item)) {
                    throw new StreamingFetchFailure(
                        "protocol",
                        "Fast Fetch received a malformed _bulk_get document result.",
                        false
                    );
                }
                if ("ok" in item) {
                    const body = item.ok;
                    if (!isObject(body) || typeof body._rev !== "string") {
                        throw new StreamingFetchFailure(
                            "protocol",
                            "Fast Fetch received a malformed _bulk_get document.",
                            false
                        );
                    }
                    const ref = { id: result.id, rev: body._rev };
                    const key = revisionRefKey(ref);
                    if (!expected.has(key) || documents.has(key)) {
                        throw new StreamingFetchFailure(
                            "protocol",
                            "Fast Fetch received an unexpected or duplicate _bulk_get document.",
                            false
                        );
                    }
                    documents.set(key, ensureRevisionDocument(body, ref));
                    continue;
                }

                if (typeof item.error === "string") {
                    if (item.error === "forbidden" || item.error === "unauthorized") {
                        throw new StreamingFetchFailure(
                            "authentication",
                            `Fast Fetch could not read revision ${result.id}: CouchDB denied access.`,
                            false
                        );
                    }
                    throw new StreamingFetchFailure(
                        "protocol",
                        `Fast Fetch could not read a required revision for ${result.id}: ${String(item.reason ?? item.error)}.`,
                        false
                    );
                }
                throw new StreamingFetchFailure(
                    "protocol",
                    "Fast Fetch received a malformed _bulk_get document result.",
                    false
                );
            }
        }

        for (const revision of refs) {
            if (!documents.has(revisionRefKey(revision.ref))) {
                throw new StreamingFetchFailure(
                    "protocol",
                    `Fast Fetch did not receive required revision ${revision.ref.id}@${revision.ref.rev}.`,
                    false
                );
            }
        }
        return documents;
    };

    const fetchAndWriteBulkGetGroup = async (revisions: PendingRevision[]): Promise<void> => {
        const refs = revisions.map(({ ref }) => ref);
        const requestBody = JSON.stringify({ docs: refs });
        const response = await fetchResponse(
            makeBulkGetURL().toString(),
            { method: "POST", headers: bulkGetHeaders, body: requestBody },
            "read missing revisions"
        );

        let responseText: string;
        try {
            const responseBody = await readResponseTextBounded(
                response,
                "read missing revisions",
                revisions.length === 1 ? Number.MAX_SAFE_INTEGER : FAST_FETCH_REVISION_GROUP_BYTE_LIMIT
            );
            responseText = responseBody.text;
            totalBytes += responseBody.byteLength;
        } catch (error) {
            if (error instanceof BulkGetResponseTooLargeError && revisions.length > 1) {
                const midpoint = Math.ceil(revisions.length / 2);
                await fetchAndWriteBulkGetGroup(revisions.slice(0, midpoint));
                await fetchAndWriteBulkGetGroup(revisions.slice(midpoint));
                return;
            }
            throw error;
        }

        const documents = parseBulkGetDocuments(responseText, revisions);
        for (const revision of revisions) {
            const document = documents.get(revisionRefKey(revision.ref));
            if (!document) {
                throw new StreamingFetchFailure(
                    "protocol",
                    `Fast Fetch did not receive required revision ${revision.ref.id}@${revision.ref.rev}.`,
                    false
                );
            }
            await markRevisionDurable(revision, document);
        }
    };

    const flushPendingRemoteRevisions = async () => {
        if (pendingRemoteRevisions.size === 0) return;
        const revisions = [...pendingRemoteRevisions.values()];
        pendingRemoteRevisions.clear();
        pendingRemoteRevisionBytes = 0;
        for (let index = 0; index < revisions.length; index += FAST_FETCH_REVISION_GROUP_LIMIT) {
            await fetchAndWriteBulkGetGroup(revisions.slice(index, index + FAST_FETCH_REVISION_GROUP_LIMIT));
        }
    };

    const enqueueRemoteRevision = async (revision: PendingRevision) => {
        const key = revisionRefKey(revision.ref);
        const existing = pendingRemoteRevisions.get(key);
        if (existing) {
            for (const row of revision.rows) existing.rows.add(row);
            return;
        }

        const estimatedBytes = new TextEncoder().encode(JSON.stringify({ docs: [revision.ref] })).byteLength;
        if (
            pendingRemoteRevisions.size > 0 &&
            (pendingRemoteRevisions.size >= FAST_FETCH_REVISION_GROUP_LIMIT ||
                pendingRemoteRevisionBytes + estimatedBytes > FAST_FETCH_REVISION_GROUP_BYTE_LIMIT)
        ) {
            await flushPendingRemoteRevisions();
        }

        pendingRemoteRevisions.set(key, revision);
        pendingRemoteRevisionBytes += estimatedBytes;
        if (
            pendingRemoteRevisions.size >= FAST_FETCH_REVISION_GROUP_LIMIT ||
            pendingRemoteRevisionBytes >= FAST_FETCH_REVISION_GROUP_BYTE_LIMIT
        ) {
            await flushPendingRemoteRevisions();
        }
    };

    const flushPendingRevisions = async (flushRemoteRemainder = false) => {
        if (pendingRevisions.size > 0) {
            const revisions = [...pendingRevisions.values()];
            pendingRevisions.clear();
            pendingRevisionBytes = 0;

            const revisionsToCheck: PendingRevision[] = [];
            for (const revision of revisions) {
                if (batchWriter.hasPendingRevision(revision.ref)) {
                    settleRevision(revision);
                } else {
                    revisionsToCheck.push(revision);
                }
            }

            if (revisionsToCheck.length > 0) {
                const revisionDiff = Object.create(null) as PouchDB.Core.RevisionDiffOptions;
                for (const { ref } of revisionsToCheck) {
                    const existing = revisionDiff[ref.id] ?? [];
                    existing.push(ref.rev);
                    revisionDiff[ref.id] = existing;
                }

                let difference: PouchDB.Core.RevisionDiffResponse;
                try {
                    difference = await downloadToDB.revsDiff(revisionDiff);
                } catch (error) {
                    throw new StreamingFetchFailure(
                        "storage",
                        `Fast Fetch could not check local revision history: ${errorMessage(error)}`,
                        false,
                        { cause: error }
                    );
                }
                if (!isObject(difference)) {
                    throw new StreamingFetchFailure(
                        "protocol",
                        "Fast Fetch received an invalid local revision check.",
                        false
                    );
                }

                for (const revision of revisionsToCheck) {
                    const item = Object.prototype.hasOwnProperty.call(difference, revision.ref.id)
                        ? difference[revision.ref.id]
                        : undefined;
                    if (item !== undefined && (!isObject(item) || !Array.isArray(item.missing))) {
                        throw new StreamingFetchFailure(
                            "protocol",
                            "Fast Fetch received an invalid local revision check.",
                            false
                        );
                    }
                    const isMissing = item !== undefined && item.missing.includes(revision.ref.rev);
                    if (!isMissing) {
                        settleRevision(revision);
                    } else if (revision.includedDocument) {
                        await markPreparedRevisionDurable(revision, revision.includedDocument);
                    } else {
                        await enqueueRemoteRevision(revision);
                    }
                }
            }
        }

        if (
            flushRemoteRemainder ||
            pendingRemoteRevisions.size >= FAST_FETCH_REVISION_GROUP_LIMIT ||
            pendingRemoteRevisionBytes >= FAST_FETCH_REVISION_GROUP_BYTE_LIMIT
        ) {
            await flushPendingRemoteRevisions();
        }
        await releaseCompletedRows();
    };

    const enqueueRevision = async (
        ref: RevisionRef,
        row: ChangeRowProgress,
        includedDocument?: { document: AnyEntry | EntryLeaf; serialisedSize: number }
    ) => {
        const key = revisionRefKey(ref);
        const remoteExisting = pendingRemoteRevisions.get(key);
        if (remoteExisting) {
            remoteExisting.rows.add(row);
            if (includedDocument !== undefined) {
                pendingRemoteRevisions.delete(key);
                pendingRemoteRevisionBytes -= new TextEncoder().encode(JSON.stringify({ docs: [ref] })).byteLength;
                await markPreparedRevisionDurable(remoteExisting, includedDocument);
            }
            return;
        }
        const existing = pendingRevisions.get(key);
        if (existing) {
            existing.rows.add(row);
            if (existing.includedDocument === undefined && includedDocument !== undefined) {
                existing.includedDocument = includedDocument;
            }
            return;
        }

        const estimatedBytes = new TextEncoder().encode(JSON.stringify({ ref, includedDocument })).byteLength;
        if (
            pendingRevisions.size > 0 &&
            (pendingRevisions.size >= FAST_FETCH_REVISION_GROUP_LIMIT ||
                pendingRevisionBytes + estimatedBytes > FAST_FETCH_REVISION_GROUP_BYTE_LIMIT)
        ) {
            await flushPendingRevisions();
        }

        pendingRevisions.set(key, {
            ref,
            rows: new Set([row]),
            ...(includedDocument === undefined ? {} : { includedDocument }),
        });
        pendingRevisionBytes += estimatedBytes;
        if (
            pendingRevisions.size >= FAST_FETCH_REVISION_GROUP_LIMIT ||
            pendingRevisionBytes >= FAST_FETCH_REVISION_GROUP_BYTE_LIMIT
        ) {
            await flushPendingRevisions();
        }
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
        if (pendingRevisions.size > 0 || pendingRemoteRevisions.size > 0) {
            throw new StreamingFetchFailure("protocol", "Fast Fetch began a page with unresolved revisions.", false);
        }
        rowProgress.length = 0;
        nextCheckpointRow = 0;
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
                await flushPendingRevisions(true);
                await releaseCompletedRows();
                if (nextCheckpointRow !== rowProgress.length) {
                    throw new StreamingFetchFailure(
                        "protocol",
                        "Fast Fetch reached a page terminator with unresolved leaf revisions.",
                        false
                    );
                }
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

            if (
                typeof change.id !== "string" ||
                change.id.length === 0 ||
                !Array.isArray(change.changes) ||
                change.changes.length === 0 ||
                change.changes.some((entry) => !isObject(entry) || typeof entry.rev !== "string" || entry.rev.length === 0)
            ) {
                throw new StreamingFetchFailure(
                    "protocol",
                    "Fast Fetch received a changes row without valid leaf revisions.",
                    false
                );
            }
            const leafRevisions = [...new Set(change.changes.map(({ rev }) => rev))];
            let includedDocument: { document: AnyEntry | EntryLeaf; serialisedSize: number } | undefined;
            if (change.doc !== undefined) {
                if (!isObject(change.doc) || typeof change.doc._rev !== "string" || !leafRevisions.includes(change.doc._rev)) {
                    throw new StreamingFetchFailure(
                        "protocol",
                        "Fast Fetch received a changes row with an invalid included document.",
                        false
                    );
                }
                const includedRef = { id: change.id, rev: change.doc._rev };
                const includedBody = ensureRevisionIdentity(change.doc, includedRef);
                const revision = parseRevisionIdentifier(includedRef.rev);
                if (revision === undefined) {
                    throw new StreamingFetchFailure(
                        "protocol",
                        `Fast Fetch received an invalid revision identifier for ${includedRef.id}.`,
                        false
                    );
                }
                if (revision.generation === 1) {
                    // A generation-one revision has no parents. Build its complete
                    // ancestry from the exact validated revision returned by CouchDB.
                    const revisionDocument = ensureRevisionDocument(
                        { ...includedBody, _revisions: { start: 1, ids: [revision.hash] } },
                        includedRef
                    );
                    includedDocument = await batchWriter.prepare(revisionDocument);
                } else if (hasValidRevisionAncestry(includedBody, revision)) {
                    const revisionDocument = ensureRevisionDocument(includedBody, includedRef);
                    includedDocument = await batchWriter.prepare(revisionDocument);
                }
            }

            totalValidFetched++;
            const row = { sequence: change.seq, pendingRevisions: leafRevisions.length, complete: false };
            rowProgress.push(row);
            for (const rev of leafRevisions) {
                await enqueueRevision(
                    { id: change.id, rev },
                    row,
                    change.doc?._rev === rev ? includedDocument : undefined
                );
            }
            await releaseCompletedRows();
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
                await flushPendingRevisions(true);
                await releaseCompletedRows();
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
