import { _fetch } from "@lib/common/coreEnvFunctions";
import { LOG_LEVEL_VERBOSE, Logger } from "octagonal-wheels/common/logger";
import type { EntryDoc } from "@lib/common/models/db.definition";
import type { AnyEntry, EntryLeaf } from "@lib/common/models/db.type";

// Type definition for each line from the CouchDB _changes API (feed=continuous).
interface CouchChangeLine {
    seq: number | string;
    id: string;
    changes: Array<{ rev: string }>;
    doc?: EntryDoc; // include_docs=true includes the full document body.
    deleted?: boolean;
}

// interface AnyDoc {
//     _id: string;
// }
interface AnyDecryptedDoc {
    _id: string;
}

type DBSequence = number | string;

function generatePouchDBWriteStream(
    downloadToDB: PouchDB.Database,
    decryptFunction: (doc: EntryDoc) => Promise<AnyEntry | EntryLeaf>,
    onCheckpoint?: (sequence: DBSequence) => void | Promise<void>
) {
    let batchBuffer: AnyDecryptedDoc[] = [];
    let currentBatchSizeBytes = 0;
    let batchLastSequence: DBSequence | undefined;

    const BATCH_ITEM_LIMIT = 100;
    const BATCH_SIZE_LIMIT = 2 * 1024 * 1024; // 2MB

    // Flush the current batch to PouchDB and clear the buffer.
    let flushPromise: Promise<unknown> | null = null; // To track ongoing flush operations and prevent concurrent flushes.
    const flushToDB = async () => {
        if (batchBuffer.length === 0) return;
        if (flushPromise) {
            // If a flush is already in progress, wait for it to complete before starting a new one.
            await flushPromise;
        }
        try {
            flushPromise = downloadToDB.bulkDocs(batchBuffer, { new_edits: false });
            await flushPromise;
            if (batchLastSequence !== undefined) {
                await onCheckpoint?.(batchLastSequence);
            }
        } catch (error) {
            Logger("Error bulk writing to PouchDB:", LOG_LEVEL_VERBOSE);
            Logger(error, LOG_LEVEL_VERBOSE);
            throw error; // Propagate the error to be handled by the caller.
        } finally {
            // Clear the batch buffer and reset the size counter regardless of success or failure to avoid blocking the stream.
            batchBuffer = [];
            currentBatchSizeBytes = 0;
            batchLastSequence = undefined;
            flushPromise = null;
        }
    };
    return new WritableStream<{ doc: EntryDoc; seq: DBSequence }>({
        async write(chunk) {
            try {
                // 1. Decrypt the document
                const decryptedDoc = await decryptFunction(chunk.doc);

                // 2. Buffer the decrypted document
                batchBuffer.push(decryptedDoc);
                currentBatchSizeBytes += JSON.stringify(decryptedDoc).length;
                batchLastSequence = chunk.seq;

                // 3. Flush the batch if limits are exceeded
                if (batchBuffer.length >= BATCH_ITEM_LIMIT || currentBatchSizeBytes >= BATCH_SIZE_LIMIT) {
                    await flushToDB();
                }
            } catch (error) {
                Logger("Error processing document stream:", LOG_LEVEL_VERBOSE);
                throw error;
            }
        },
        async close() {
            // Flush any remaining documents when the stream is closed
            await flushToDB();
        },
        abort(reason) {
            // Cleanup when the stream is forcibly terminated due to an error or other reasons
            Logger(`Stream aborted: ${reason}`, LOG_LEVEL_VERBOSE);
            batchBuffer = [];
            currentBatchSizeBytes = 0;
        },
    });
}

function setParamsToURL(url: URL, params: Record<string, string>) {
    for (const [key, value] of Object.entries(params)) {
        url.searchParams.set(key, value);
    }
    return url;
}

export type FetchChangesForInitialSyncProgress = {
    totalFetched: number; // Total number of changes fetched from CouchDB (including those without doc bodies).
    totalValidFetched: number; // Total number of changes with valid doc bodies fetched and processed.
    targetSeq: number | string; // The target sequence ID that we aim to reach for initial sync completion.
    docsToFetch: number; // Total number of documents that need to be fetched based on the pending count from CouchDB.
    totalBytes: number; // Total bytes fetched so far.
};

type DatabaseSyncStatus = {
    update_seq?: DBSequence;
    last_seq?: DBSequence;
    pending?: number;
};

function reachedTargetSequence(seq: DBSequence | undefined, targetSeq: DBSequence | undefined): boolean {
    if (seq === undefined || targetSeq === undefined) return false;
    const seqStr = seq.toString();
    const targetSeqStr = targetSeq.toString();
    if (seqStr === targetSeqStr) return true;

    // CouchDB sequence IDs are typically formatted as "seq_num-opaque_hash" (e.g. "5-g1AAA...") or just integers (e.g. 5).
    const seqNum = parseInt(seqStr.split("-")[0], 10);
    const targetSeqNum = parseInt(targetSeqStr.split("-")[0], 10);
    if (!isNaN(seqNum) && !isNaN(targetSeqNum)) {
        return seqNum >= targetSeqNum;
    }
    return false;
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

    // 1. Fetch database info to get the actual final sequence ID (targetSeq)
    let targetSeq: DBSequence | undefined = undefined;
    try {
        const dbInfoRes = await _fetch(remoteDbUrl, {
            headers: fetchHeaders,
        });
        if (dbInfoRes.ok) {
            const dbInfo = await dbInfoRes.json();
            targetSeq = dbInfo.update_seq;
        }
    } catch (e) {
        Logger("Failed to fetch database info for target sequence:", LOG_LEVEL_VERBOSE);
        Logger(e, LOG_LEVEL_VERBOSE);
    }

    // 2. Fetch changes status with limit=1 and feed=normal to get the pending count without blocking
    const fetchURL = setParamsToURL(new URL(`${remoteDbUrl}/_changes`), {
        ...changesBaseParams,
        feed: "normal",
        limit: "1",
    });

    const infoRes = await _fetch(fetchURL.toString(), {
        headers: fetchHeaders,
    });
    const infoSource = await infoRes.text();
    const infoSourceTrimmed = infoSource.trim();
    if (!infoSourceTrimmed) {
        throw new Error("Failed to fetch changes from CouchDB. No data received.");
    }

    let info: DatabaseSyncStatus;
    if (infoSourceTrimmed.startsWith("{") && infoSourceTrimmed.endsWith("}")) {
        try {
            info = JSON.parse(infoSourceTrimmed) as DatabaseSyncStatus;
        } catch {
            const infoLines = infoSourceTrimmed.split("\n").filter((line) => line.trim() !== "");
            const lastLine = infoLines[infoLines.length - 1];
            info = JSON.parse(lastLine) as DatabaseSyncStatus;
        }
    } else {
        const infoLines = infoSourceTrimmed.split("\n").filter((line) => line.trim() !== "");
        const lastLine = infoLines[infoLines.length - 1];
        info = JSON.parse(lastLine) as DatabaseSyncStatus;
    }
    const pendingDocs = info.pending || 0;
    const docsToFetch = pendingDocs + 1; // +1 to include the change we just fetched for getting the target sequence.

    // If targetSeq was not fetched successfully from the database info, fallback to the info response
    if (targetSeq === undefined) {
        targetSeq = info.last_seq || info.update_seq || (info as { seq?: string | number }).seq;
    }

    const finalTargetSeq = targetSeq ?? "";

    if (reachedTargetSequence(since, finalTargetSeq)) {
        Logger("Already at the target sequence. Initial data synchronisation is complete.");
        return;
    }

    Logger(
        `Starting initial synchronisation. Current sequence: ${since}, Target sequence: ${finalTargetSeq}, Total documents to fetch: ${docsToFetch}.`
    );
    const controller = new AbortController();
    const url = setParamsToURL(new URL(`${remoteDbUrl}/_changes`), {
        ...changesBaseParams,
    });
    const response = await _fetch(url.toString(), {
        method: "GET",
        headers: fetchHeaders,
        signal: controller.signal,
    });

    if (!response.body) {
        throw new Error("ReadableStream is not supported by this browser.");
    }

    const sizeCaptureStream = new TransformStream({
        transform(chunk, controller) {
            const chunkSize = chunk.length || chunk.byteLength || 0;
            totalBytes += chunkSize;
            controller.enqueue(chunk);
        },
    });
    // Convert the byte stream into a text stream.
    const reader = response.body.pipeThrough(sizeCaptureStream).pipeThrough(new TextDecoderStream()).getReader();
    const writeDocStream = generatePouchDBWriteStream(downloadToDB, decryptFunction, onCheckpoint);
    const writer = writeDocStream.getWriter();
    let buffer = "";
    let lastProgress = 0;
    let lastReportTime = Date.now();
    let totalBytes = 0;
    let abortedAfterTargetReached = false;
    const reportProgress = () => {
        if (totalFetched - lastProgress < 25) {
            // Report progress for every 25 changes fetched to avoid excessive updates.
            // However, if it's been more than 2 seconds since the last report, we should report progress regardless to keep the UI responsive.
            if (Date.now() - lastReportTime < 2000) {
                return;
            }
        }
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
    try {
        while (true) {
            // Read a chunk from the network.
            reportProgress();
            const { value, done } = await reader.read();
            if (value) {
                totalBytes += value.length;
            }
            if (done) {
                // When the stream ends, process the final line left in the buffer.
                if (buffer.trim()) {
                    try {
                        totalFetched++;
                        const parsed = JSON.parse(buffer) as CouchChangeLine;
                        if (parsed.doc) {
                            await writer.write({ doc: parsed.doc, seq: parsed.seq });
                            totalValidFetched++;
                        } else {
                            await onCheckpoint?.(parsed.seq);
                        }
                        reportProgress();
                    } catch (e) {
                        Logger(`Failed to parse the final line: ${buffer}. Skipping it.`);
                        Logger(e, LOG_LEVEL_VERBOSE);
                    }
                }
                await writer.close();
                break; // Exit the loop.
            }

            buffer += value;
            const lines = buffer.split("\n");

            // The final line is often incomplete, so carry it over to the next buffer.
            buffer = lines.pop() || "";

            for (const line of lines) {
                if (!line.trim()) continue; // Skip empty lines (for example, CouchDB heartbeats).

                try {
                    const parsed = JSON.parse(line) as CouchChangeLine;
                    // Add to the batch only when a document body exists.
                    totalFetched++;
                    if (parsed.doc) {
                        await writer.write({ doc: parsed.doc, seq: parsed.seq });
                        totalValidFetched++;
                    } else {
                        await onCheckpoint?.(parsed.seq);
                    }
                    reportProgress();
                    if (totalFetched >= docsToFetch || reachedTargetSequence(parsed.seq, finalTargetSeq)) {
                        Logger(
                            `All documents fetched. Stopping the stream and writing remaining documents to PouchDB...`
                        );

                        // Write any remaining documents to PouchDB before exiting.
                        await writer.close(); // Close the writer to ensure all documents are flushed to PouchDB.
                        // Abort the fetch request to stop receiving more data.
                        abortedAfterTargetReached = true;
                        controller.abort();
                        reportProgress();
                        return; // Exit the function gracefully.
                    }
                } catch (e) {
                    Logger(`JSON parsing failed. Skipping line: ${line}`, LOG_LEVEL_VERBOSE);
                    Logger(e, LOG_LEVEL_VERBOSE);
                }
            }
            // backpressure is automatically handled by awaiting the writer.write() calls, which will pause reading from the network until the current document is processed and written to PouchDB.
            // This ensures that we do not read too much data into memory at once, and we can handle large datasets without running into memory issues.
        }
        Logger("Initial data synchronisation via stream has completed.");
        reportProgress();
    } catch (error) {
        if (abortedAfterTargetReached && error instanceof DOMException && error.name === "AbortError") {
            Logger(
                "Stream has been aborted as the target sequence has been reached. Finalising the synchronising process..."
            );
            return; // Exit gracefully without treating this as an error.
        }
        Logger("An error occurred during synchronisation:", LOG_LEVEL_VERBOSE);
        Logger(error, LOG_LEVEL_VERBOSE);
        throw error;
    } finally {
        // Always release the lock.
        reader.releaseLock();
    }
}
