// Foreground part of Content-Splitter

import { LOG_LEVEL_VERBOSE, Logger } from "@lib/common/logger.ts";
import { startWorker, removeTask } from "./bgWorker.ts";
import { type ResultPayloadWithSeq, type SplitProcessItem } from "./universalTypes";

const SYMBOL_USED = Symbol("used");
const SYMBOL_END_OF_DATA = Symbol("endOfData");
type SYMBOL_USED = typeof SYMBOL_USED;
type SYMBOL_END_OF_DATA = typeof SYMBOL_END_OF_DATA;

const writers = new Map<number, WritableStreamDefaultWriter<string | null>>();

const responseBuf = new Map<number, Map<number, string | SYMBOL_USED | SYMBOL_END_OF_DATA>>();

let writerPromise = Promise.resolve(); // Just process serialiser

/**
 * Splits data into pieces using a worker.
 * @param dataSrc The source data to be split.
 * @param pieceSize The size of each piece.
 * @param plainSplit Whether to use plain splitting.
 * @param minimumChunkSize The minimum size of each chunk.
 * @param filename The name of the file being processed.
 * @param splitVersion The version of the splitting algorithm to use.
 * @param useSegmenter Whether to use a segmenter (only works on splitVersion:2)
 * @returns A generator that yields the split pieces.
 */
export function _splitPieces2Worker(
    dataSrc: Blob,
    pieceSize: number,
    plainSplit: boolean,
    minimumChunkSize: number,
    filename: string | undefined,
    splitVersion: 1 | 2 | 3,
    useSegmenter: boolean
) {
    // Prepare the worker, since here, handleTaskSplit can be called.
    // Do not use asynchronous call until setting the writers.
    const process = startWorker({
        type: "split",
        dataSrc,
        pieceSize,
        plainSplit,
        minimumChunkSize,
        filename,
        useSegmenter,
        splitVersion,
    });
    const _key = process.key;
    const stream = new TransformStream<string | null, string>({
        transform: (chunk, controller) => {
            // If chunk is null, it means the end of data, so we should terminate the stream
            if (chunk === null) {
                controller.terminate();
                return;
            }
            // While chunk has arrived, we can process it on the reader
            controller.enqueue(chunk);
        },
        flush: () => {},
    });

    const readable = stream.readable;
    const reader = readable.getReader();
    const writer = stream.writable.getWriter();
    // Lock the writer for this stream
    writers.set(_key, writer);
    // Okay, we are ready to respond, create the generator function.
    return async function* () {
        try {
            let done = false;
            do {
                // Reading from the stream (I am so happy on iOS 14.5+).
                const results = await reader.read();
                done = results.done;
                if (done) {
                    break;
                }
                yield results.value!; // results.value is never null here
            } while (!done);
        } catch (ex) {
            Logger(`Error in worker stream for key ${_key}`);
            Logger(ex, LOG_LEVEL_VERBOSE);
            throw ex;
        } finally {
            // Tearing down.
            process.finalize();
            writers.delete(_key);
        }
    };
}

/**
 * Aborts all in-flight split tasks identified by the given keys.
 * Called when a split fails or its background worker crashes.
 * @param keys The task keys to abort.
 * @param error The error to report to each stream.
 */
export function abortSplitTasks(keys: number[], error: unknown): void {
    for (const key of keys) {
        removeTask(key);
        responseBuf.delete(key);
        const writer = writers.get(key);
        writers.delete(key);
        // Abort immediately so backpressure from an unread chunk cannot delay the failure.
        void writer?.abort(error).catch((abortError) => Logger(abortError, LOG_LEVEL_VERBOSE));
    }
}

/**
 * Handles the splitting callback from the worker.
 * @param process the splitting process item
 * @param data the data received from the worker
 */
export function handleTaskSplit(process: SplitProcessItem, data: ResultPayloadWithSeq) {
    // Data key means the unique identifier for the splitting task
    const key = data.key;

    if (!("result" in data)) {
        const { name, message, stack } = data.error;
        const error = new Error(message);
        error.name = name;
        error.stack = stack ?? error.stack;
        abortSplitTasks([key], error);
        return;
    }
    let thisBuf = responseBuf.get(key);
    if (!thisBuf) {
        thisBuf = new Map<number, string | SYMBOL_USED | SYMBOL_END_OF_DATA>();
        responseBuf.set(key, thisBuf);
    }

    const seq = data.seq;
    thisBuf.set(seq, data.result === null ? SYMBOL_END_OF_DATA : data.result);
    responseBuf.set(key, thisBuf);

    const keys = Array.from(thisBuf.keys()).sort((a, b) => a - b);
    const max = keys[keys.length - 1];
    for (let i = 0; i <= max; i++) {
        const result = thisBuf.get(i);
        if (result === undefined) {
            // Some intermediate results have not arrived yet
            break;
        }
        if (result === SYMBOL_USED) {
            // If marked as used, we can proceed to the next item
            continue;
        }

        // -- Results until `i` are fulfilled
        // Mark as used
        thisBuf.set(i, SYMBOL_USED);
        responseBuf.set(key, thisBuf);
        writerPromise = writerPromise.then(async () => {
            // Sending NULL for end of data causes the stream to close, no need to call close()
            const writer = writers.get(key);
            try {
                await writer?.write(result === SYMBOL_END_OF_DATA ? null : result);
            } catch (error) {
                abortSplitTasks([key], error);
                return;
            }
            if (result === SYMBOL_END_OF_DATA) {
                // Task is complete; clean up the task map and the worker's key tracking.
                removeTask(key);
                responseBuf.delete(key);
            }
        });
    }
}
