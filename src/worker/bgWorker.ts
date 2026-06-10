// Foreground part of Worker-off-loaded functions

import { promiseWithResolver } from "octagonal-wheels/promises.js";
import { eventHub } from "@lib/hub/hub.ts";
//@ts-ignore
import WorkerX from "./bg.worker.ts?worker&inline";
import { EVENT_PLATFORM_UNLOADED } from "@lib/events/coreEvents";
import { info, LOG_KIND_ERROR } from "octagonal-wheels/common/logger.js";
import { LOG_LEVEL_VERBOSE, Logger } from "@lib/common/logger.ts";
import type {
    EncryptArguments,
    EncryptHKDFArguments,
    EncryptHKDFProcessItem,
    EncryptProcessItem,
    ProcessItem,
    SplitArguments,
    SplitProcessItem,
} from "./universalTypes.ts";

export type WorkerInstance = {
    worker: Worker;
    processing: number;
    /** Keys of tasks currently dispatched to this worker instance. */
    taskKeys: Set<number>;
};

export function splitPieces2Worker(
    dataSrc: Blob,
    pieceSize: number,
    plainSplit: boolean,
    minimumChunkSize: number,
    filename?: string,
    useSegmenter?: boolean
) {
    return _splitPieces2Worker(dataSrc, pieceSize, plainSplit, minimumChunkSize, filename, 1, useSegmenter ?? false);
}
export function splitPieces2WorkerV2(
    dataSrc: Blob,
    pieceSize: number,
    plainSplit: boolean,
    minimumChunkSize: number,
    filename?: string,
    useSegmenter?: boolean
) {
    return _splitPieces2Worker(dataSrc, pieceSize, plainSplit, minimumChunkSize, filename, 2, useSegmenter ?? false);
}
export function splitPieces2WorkerRabinKarp(
    dataSrc: Blob,
    pieceSize: number,
    plainSplit: boolean,
    minimumChunkSize: number,
    filename?: string,
    useSegmenter?: boolean
) {
    return _splitPieces2Worker(dataSrc, pieceSize, plainSplit, minimumChunkSize, filename, 3, useSegmenter ?? false);
}

export function encryptWorker(input: string, passphrase: string, autoCalculateIterations: boolean): Promise<string> {
    return encryptionOnWorker({ type: "encrypt", input, passphrase, autoCalculateIterations });
}

export function decryptWorker(input: string, passphrase: string, autoCalculateIterations: boolean) {
    return encryptionOnWorker({ type: "decrypt", input, passphrase, autoCalculateIterations });
}

export function encryptHKDFWorker(
    input: string,
    passphrase: string,
    pbkdf2Salt: Uint8Array<ArrayBuffer>
): Promise<string> {
    return encryptionHKDFOnWorker({ type: "encryptHKDF", input, passphrase, pbkdf2Salt });
}

export function decryptHKDFWorker(
    input: string,
    passphrase: string,
    pbkdf2Salt: Uint8Array<ArrayBuffer>
): Promise<string> {
    return encryptionHKDFOnWorker({ type: "decryptHKDF", input, passphrase, pbkdf2Salt });
}

export const tasks = new Map<number, ProcessItem>();
/** Reverse map: task key → the worker instance it was dispatched to. */
const taskWorkerMap = new Map<number, WorkerInstance>();

/**
 * Remove a completed (or aborted) task from both the tasks map and its worker's taskKeys set.
 */
export function removeTask(key: number): void {
    tasks.delete(key);
    const inst = taskWorkerMap.get(key);
    if (inst) {
        inst.taskKeys.delete(key);
        taskWorkerMap.delete(key);
    }
}

function initialiseWorkers() {
    const maxConcurrency = ~~((navigator.hardwareConcurrency || 8) / 2);
    return Array.from(
        { length: maxConcurrency },
        () =>
            ({
                // WorkerX is an imported inline worker.
                // @ts-ignore
                // eslint-disable-next-line @typescript-eslint/no-unsafe-call
                worker: WorkerX() as Worker,
                processing: 0,
                taskKeys: new Set<number>(),
            }) satisfies WorkerInstance
    );
}

export const _internal = {
    abortSplitTasks,
    handleTaskSplit,
    handleTaskEncrypt,
};

let workers: WorkerInstance[] = [];
export function initialiseWorkerModule() {
    if (workers.length > 0) {
        terminateWorker();
        workers = [];
    }
    workers = initialiseWorkers();
    for (const inst of workers) {
        inst.worker.onmessage = ({ data }) => {
            const key = data.key as number;
            // debugger;
            const process = tasks.get(key);
            if (!process) {
                info(`Invalid key ${key} of background processing`, LOG_KIND_ERROR);
                return;
            }
            if (process.type === "split") {
                _internal.handleTaskSplit(process, data);
            } else if (process.type === "encrypt" || process.type === "decrypt") {
                _internal.handleTaskEncrypt(process, data);
            } else if (process.type === "encryptHKDF" || process.type === "decryptHKDF") {
                _internal.handleTaskEncrypt(process, data);
            } else {
                info(
                    "Invalid response type" +
                        (typeof process.type === "string" ? process.type : JSON.stringify(process))
                );
            }
        };
        inst.worker.onerror = (ev) => {
            inst.worker.terminate();
            workers.splice(workers.indexOf(inst), 1);
            // Clean up all tasks that were assigned to this worker.
            const crashError = new Error(`Background worker crashed: ${ev?.message ?? "unknown error"}`);
            const splitKeys: number[] = [];
            for (const key of inst.taskKeys) {
                const process = tasks.get(key);
                if (!process) continue;
                tasks.delete(key);
                if (process.type === "split") {
                    splitKeys.push(key);
                } else if ("task" in process) {
                    process.task.reject(crashError);
                }
            }
            inst.taskKeys.clear();
            if (splitKeys.length > 0) {
                _internal.abortSplitTasks(splitKeys, crashError);
            }
        };
    }

    eventHub.on(EVENT_PLATFORM_UNLOADED, () => {
        terminateWorker();
    });
}

let key = 0;
let roundRobinIdx = 0;

function nextWorker() {
    if (workers === undefined || workers.length === 0) {
        throw new Error("No available workers");
    }
    const inst = workers[roundRobinIdx];
    roundRobinIdx = (roundRobinIdx + 1) % workers.length;
    return inst;
}

export function startWorker(data: Omit<EncryptHKDFArguments, "key">): EncryptHKDFProcessItem;
export function startWorker(data: Omit<EncryptArguments, "key">): EncryptProcessItem;
export function startWorker(data: Omit<SplitArguments, "key">): SplitProcessItem;
export function startWorker(data: Omit<EncryptArguments | SplitArguments | EncryptHKDFArguments, "key">): ProcessItem {
    const _key = key++;
    const inst = nextWorker();
    const promise = promiseWithResolver<string>();
    const item: ProcessItem =
        data.type === "split"
            ? {
                  key: _key,
                  type: data.type,
                  finalize: () => {
                      inst.processing--;
                  },
              }
            : {
                  key: _key,
                  task: promise,
                  type: data.type,
                  finalize: () => {
                      inst.processing--;
                  },
              };
    tasks.set(_key, item);
    inst.taskKeys.add(_key);
    taskWorkerMap.set(_key, inst);
    inst.processing++;
    inst.worker.postMessage({
        data: { ...data, key: _key },
    });
    return item;
}

export function terminateWorker() {
    for (const inst of workers) {
        inst.worker.terminate();
    }
    // isTerminated = true;
}

// =========================================================================
// =========================================================================
// SECTION: Encryption (Merged from bgWorker.encryption.ts)
// =========================================================================
// =========================================================================

/**
 * Offloads encryption to a web worker.
 * @param data The data to be encrypted.
 * @returns A promise that resolves with the encryption result.
 */
export function encryptionOnWorker(data: Omit<EncryptArguments, "key">) {
    const process = startWorker(data);
    return (async () => {
        const ret = await process.task.promise;
        process.finalize();
        return ret;
    })();
}

/**
 * Offloads HKDF encryption to a web worker.
 * @param data The data to be encrypted.
 * @returns A promise that resolves with the encryption result.
 */
export function encryptionHKDFOnWorker(data: Omit<EncryptHKDFArguments, "key">) {
    const process = startWorker(data);
    return (async () => {
        const ret = await process.task.promise;
        process.finalize();
        return ret;
    })();
}

/**
 * Handles the encryption callbacks
 * @param process The process item associated with the task.
 * @param data The data to be processed.
 */
export function handleTaskEncrypt(
    process: EncryptProcessItem | EncryptHKDFProcessItem,
    data: { key: number; result?: string; error?: unknown }
) {
    const key = data.key;
    const task = process.task;
    if ("result" in data) {
        task.resolve(data.result!);
    } else {
        if (data.error) {
            task.reject(data.error);
        } else {
            task.reject(new Error("Unknown error in background encryption"));
        }
    }
    removeTask(key);
}

// =========================================================================
// =========================================================================
// SECTION: Splitting (Merged from bgWorker.splitting.ts)
// =========================================================================
// =========================================================================

const SYMBOL_USED = Symbol("used");
const SYMBOL_END_OF_DATA = Symbol("endOfData");
type SYMBOL_USED = typeof SYMBOL_USED;
type SYMBOL_END_OF_DATA = typeof SYMBOL_END_OF_DATA;

const workerStreams = new Map<number, TransformStream<string | null, string | null>>();
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

    // Register the stream and its reader/writer
    workerStreams.set(_key, stream);
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
            workerStreams.delete(_key);
            writers.delete(_key);
        }
    };
}

/**
 * Aborts all in-flight split tasks identified by the given keys.
 * Called when the background worker that owned these tasks has crashed, so the streams
 * will never receive any more data and must be torn down to unblock callers.
 * @param keys The task keys to abort.
 * @param error The error to report to each stream.
 */
export function abortSplitTasks(keys: number[], error: Error): void {
    for (const key of keys) {
        responseBuf.delete(key);
        writerPromise = writerPromise.then(async () => {
            const writer = writers.get(key);
            if (writer) {
                await writer.abort(error);
                writers.delete(key);
            }
            workerStreams.delete(key);
        });
    }
}

/**
 * Handles the splitting callback from the worker.
 * @param process the splitting process item
 * @param data the data received from the worker
 */
export function handleTaskSplit(
    process: SplitProcessItem,
    data: { key: number; seq?: number; result?: string | null; error?: unknown }
) {
    // Data key means the unique identifier for the splitting task
    const key = data.key;

    if (!("result" in data)) {
        responseBuf.delete(key);
        const reportError = data.error || new Error("Unknown error in background splitting");
        writerPromise = writerPromise.then(async () => {
            const writer = writers.get(key);
            if (writer) {
                await writer.abort(reportError);
            }
        });
        return;
    }
    let thisBuf = responseBuf.get(key);
    if (!thisBuf) {
        thisBuf = new Map<number, string | SYMBOL_USED | SYMBOL_END_OF_DATA>();
        responseBuf.set(key, thisBuf);
    }

    const seq = data.seq!;
    thisBuf.set(seq, data.result === null ? SYMBOL_END_OF_DATA : data.result!);
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
            if (!writer) {
                throw new Error(`Invalid writer for key ${key} in background splitting`);
            }
            await writer.write(result === SYMBOL_END_OF_DATA ? null : result);
            if (result === SYMBOL_END_OF_DATA) {
                // Task is complete; clean up the task map and the worker's key tracking.
                removeTask(key);
                responseBuf.delete(key);
            }
        });
    }
}
