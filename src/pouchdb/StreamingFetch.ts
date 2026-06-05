import { _fetch } from "../common/coreEnvFunctions";
import { LOG_LEVEL_VERBOSE, Logger } from "octagonal-wheels/common/logger";
import type { EntryDoc } from "../common/models/db.definition";
import type { AnyEntry, EntryLeaf } from "../common/models/db.type";

// Type definition for each line from the CouchDB _changes API (feed=continuous).
interface CouchChangeLine {
    seq: number | string;
    id: string;
    changes: Array<{ rev: string }>;
    doc?: any; // include_docs=true includes the full document body.
    deleted?: boolean;
}

interface AnyDoc {
    _id: string;
}
interface AnyDecryptedDoc {
    _id: string;
}

function generatePouchDBWriteStream(downloadToDB: PouchDB.Database, decryptFunction: (doc: any) => Promise<any>) {
    let batchBuffer: AnyDecryptedDoc[] = [];
    let currentBatchSizeBytes = 0;

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
        } catch (error) {
            Logger("Error bulk writing to PouchDB:", LOG_LEVEL_VERBOSE);
            Logger(error, LOG_LEVEL_VERBOSE);
            throw error; // Propagate the error to be handled by the caller.
        } finally {
            // Clear the batch buffer and reset the size counter regardless of success or failure to avoid blocking the stream.
            batchBuffer = [];
            currentBatchSizeBytes = 0;
            flushPromise = null;
        }
    };
    return new WritableStream<AnyDoc>({
        async write(chunk) {
            try {
                // 1. Decrypt the document
                const decryptedDoc = await decryptFunction(chunk);

                // 2. Buffer the decrypted document
                batchBuffer.push(decryptedDoc);
                currentBatchSizeBytes += JSON.stringify(decryptedDoc).length;

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
    onProgress?: (progress: FetchChangesForInitialSyncProgress) => void
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
    } as const;
    const fetchHeaders = {
        Accept: "application/json",
        Authorization: authHeader,
    };

    const fetchURL = setParamsToURL(new URL(`${remoteDbUrl}/_changes`), {
        ...changesBaseParams,
        limit: "1",
    });

    const infoRes = await _fetch(fetchURL.toString(), {
        headers: fetchHeaders,
    });
    const infoSource = await infoRes.text();
    const infoLines = infoSource
        .trim()
        .split("\n")
        .filter((line) => line.trim() !== "");
    const lastLine = infoLines[infoLines.length - 1];
    if (!lastLine) {
        throw new Error("Failed to fetch changes from CouchDB. No data received.");
    }
    const info = JSON.parse(lastLine) as { update_seq: number | string; pending?: number };
    const pendingDocs = info.pending || 0;
    const docsToFetch = pendingDocs + 1; // +1 to include the change we just fetched for getting the target sequence.

    const targetSeq = info.update_seq;
    Logger(
        `Starting initial synchronization. Current sequence: ${since}, Target sequence: ${targetSeq}, Total documents to fetch: ${docsToFetch}.`
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
    const writeDocStream = generatePouchDBWriteStream(downloadToDB, decryptFunction);
    const writer = writeDocStream.getWriter();
    let buffer = "";
    let lastProgress = 0;
    let lastReportTime = Date.now();
    let totalBytes = 0;
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
            targetSeq,
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
                            await writer.write(parsed.doc);
                            totalValidFetched++;
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
                        await writer.write(parsed.doc);
                        totalValidFetched++;
                    }
                    reportProgress();
                    if (totalFetched >= docsToFetch) {
                        Logger(
                            `All documents fetched. Stopping the stream and writing remaining documents to PouchDB...`
                        );

                        // Write any remaining documents to PouchDB before exiting.
                        await writer.close(); // Close the writer to ensure all documents are flushed to PouchDB.
                        // Abort the fetch request to stop receiving more data.
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
        if (error instanceof DOMException && error.name === "AbortError") {
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
