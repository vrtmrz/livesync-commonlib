// Notice!! This module is for browsers
import { promiseWithResolver, type PromiseWithResolvers } from "octagonal-wheels/promises.js";
import { eventHub } from "../hub/hub.ts";
//@ts-ignore
import WorkerX from "./bg.worker.ts?worker";
import { EVENT_PLATFORM_UNLOADED } from "../PlatformAPIs/base/APIBase.ts";
import { info, LOG_KIND_ERROR } from "octagonal-wheels/common/logger.js";

export type SplitArguments = {
    key: number;
    type: "split";
    dataSrc: Blob;
    pieceSize: number;
    plainSplit: boolean;
    minimumChunkSize: number;
    filename?: string;
    useV2: boolean;
    useSegmenter: boolean;
};

export type EncryptArguments = {
    key: number;
    type: "encrypt" | "decrypt";
    input: string;
    passphrase: string;
    autoCalculateIterations: boolean;
};

type SplitProcessItem = {
    key: number;
    task: PromiseWithResolvers<string | null>;
    type: SplitArguments["type"];
    finalize: () => void;
};
type EncryptProcessItem = {
    key: number;
    task: PromiseWithResolvers<string>;
    type: EncryptArguments["type"];
    finalize: () => void;
};
type ProcessItem = SplitProcessItem | EncryptProcessItem;

const tasks = new Map<number, ProcessItem>();

const maxConcurrency = ~~((navigator.hardwareConcurrency || 8) / 2);
let roundRobinIdx = 0;
type WorkerInstance = {
    worker: Worker;
    processing: number;
};

const workers = Array.from(
    { length: maxConcurrency },
    () =>
        ({
            // @ts-ignore
            worker: WorkerX() as Worker,
            processing: 0,
        }) as WorkerInstance
);

function handleTaskSplit(process: SplitProcessItem, data: any) {
    const key = data.key as number;
    const task = process.task;
    if ("result" in data) {
        if (data.result === null) {
            task.resolve(null);
            tasks.delete(key);
        } else {
            task.resolve(data.result);
            process.task = promiseWithResolver<string | null>();
        }
    } else {
        if (data.error) {
            task.reject(data.error);
        } else {
            task.reject(new Error("Unknown error in background splitting"));
        }
        tasks.delete(key);
    }
}
function handleTaskEncrypt(process: EncryptProcessItem, data: any) {
    const key = data.key as number;
    const task = process.task;
    if ("result" in data) {
        task.resolve(data.result);
    } else {
        if (data.error) {
            task.reject(data.error);
        } else {
            task.reject(new Error("Unknown error in background encryption"));
        }
    }
    tasks.delete(key);
}
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
            handleTaskSplit(process, data);
        } else if (process.type === "encrypt" || process.type === "decrypt") {
            handleTaskEncrypt(process, data);
        } else {
            info("Invalid response type" + process);
        }
    };
    inst.worker.onerror = () => {
        inst.worker.terminate();
        workers.splice(workers.indexOf(inst), 1);
    };
}

export function terminateWorker() {
    for (const inst of workers) {
        inst.worker.terminate();
    }
    // isTerminated = true;
}

export function splitPieces2Worker(
    dataSrc: Blob,
    pieceSize: number,
    plainSplit: boolean,
    minimumChunkSize: number,
    filename?: string,
    useSegmenter?: boolean
) {
    return _splitPieces2Worker(
        dataSrc,
        pieceSize,
        plainSplit,
        minimumChunkSize,
        filename,
        false,
        useSegmenter ?? false
    );
}
export function splitPieces2WorkerV2(
    dataSrc: Blob,
    pieceSize: number,
    plainSplit: boolean,
    minimumChunkSize: number,
    filename?: string,
    useSegmenter?: boolean
) {
    return _splitPieces2Worker(dataSrc, pieceSize, plainSplit, minimumChunkSize, filename, true, useSegmenter ?? false);
}
export function encryptWorker(input: string, passphrase: string, autoCalculateIterations: boolean): Promise<string> {
    return encryptionOnWorker({ type: "encrypt", input, passphrase, autoCalculateIterations });
}

export function decryptWorker(input: string, passphrase: string, autoCalculateIterations: boolean) {
    return encryptionOnWorker({ type: "decrypt", input, passphrase, autoCalculateIterations });
}

function startWorker(data: Omit<EncryptArguments, "key">): EncryptProcessItem;
function startWorker(data: Omit<SplitArguments, "key">): SplitProcessItem;
function startWorker(data: Omit<EncryptArguments | SplitArguments, "key">): ProcessItem {
    const _key = key++;
    const inst = nextWorker();
    const promise = promiseWithResolver<any>();
    const item: ProcessItem = {
        key: _key,
        task: promise,
        type: data.type,
        finalize: () => {
            inst.processing--;
        },
    };
    tasks.set(_key, item);
    inst.processing++;
    inst.worker.postMessage({
        data: { ...data, key: _key },
    });
    return item;
}

export function encryptionOnWorker(data: Omit<EncryptArguments, "key">) {
    const process = startWorker(data);
    return (async () => {
        const ret = await process.task.promise;
        process.finalize();
        return ret;
    })();
}

function nextWorker() {
    const inst = workers[roundRobinIdx];
    roundRobinIdx = (roundRobinIdx + 1) % workers.length;
    return inst;
}

let key = 0;

function _splitPieces2Worker(
    dataSrc: Blob,
    pieceSize: number,
    plainSplit: boolean,
    minimumChunkSize: number,
    filename: string | undefined,
    useV2: boolean,
    useSegmenter: boolean
) {
    const process = startWorker({
        type: "split",
        dataSrc,
        pieceSize,
        plainSplit,
        minimumChunkSize,
        filename,
        useV2,
        useSegmenter,
    });
    const _key = process.key;
    return async function* () {
        while (tasks.has(_key)) {
            const { task } = tasks.get(_key)!;
            const result = await task.promise;
            if (result === null) {
                process.finalize();
                return;
            }
            yield result;
        }
    };
}

eventHub.on(EVENT_PLATFORM_UNLOADED, () => {
    terminateWorker();
});
