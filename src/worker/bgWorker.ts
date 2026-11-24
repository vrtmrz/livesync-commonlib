import { RpcError } from "@vrtmrz/rpc";
import { connectWorkerRpc, createWorkerPool } from "@vrtmrz/rpc/worker";
import { promiseWithResolvers } from "octagonal-wheels/promises.js";
import { compatGlobal } from "@lib/common/coreEnvFunctions.ts";
import { LOG_LEVEL_VERBOSE, Logger } from "@lib/common/logger.ts";
import { EVENT_PLATFORM_UNLOADED } from "@lib/events/coreEvents";
import type { LiveSyncEventHub } from "@lib/hub/hub.ts";
// @ts-expect-error The browser package build supplies the inline Worker factory.
import createInlineWorker from "./bg.worker.ts?worker&inline";
import { backgroundWorkerContract, type WorkerSplitRequest } from "./backgroundWorkerRpcContract.ts";
import { toBackgroundWorkerError } from "./bgWorker.errors.ts";
import { createSplitOperation } from "./bgWorker.splitting.ts";
import {
    acquireTrackedSplitConnection,
    closeSplitConnectionTracker,
    createSplitConnectionTrackerState,
    trackConnection,
} from "./splitConnectionTracker.ts";
import { createSplitGate } from "./splitGate.ts";
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
    taskKeys: Set<number>;
    cancelledSplitKeys: Set<number>;
};

type PoolConnection = ReturnType<typeof connectWorkerRpc<typeof backgroundWorkerContract>>;
type PoolClient = Awaited<PoolConnection["ready"]>;

function createBackgroundWorkerConnection(): PoolConnection {
    return connectWorkerRpc({
        contract: backgroundWorkerContract,
        createWorker: () => createInlineWorker() as Worker,
    });
}

function createBackgroundWorkerPool() {
    const size = Math.max(1, Math.floor((compatGlobal.navigator.hardwareConcurrency || 8) / 2));
    const splitGate = createSplitGate(size);
    const splitConnections = createSplitConnectionTrackerState<PoolConnection, PoolClient>();
    const workerPool = createWorkerPool({
        size,
        createConnection: () => {
            const connection = createBackgroundWorkerConnection();
            trackConnection(splitConnections, connection, connection.ready);
            return connection;
        },
    });

    const acquireCandidate = workerPool.acquire.bind(workerPool);
    return {
        ...workerPool,
        acquireSplitSlot: splitGate.acquire,
        acquireForSplit: () => acquireTrackedSplitConnection(splitConnections, acquireCandidate),
        close(reason: RpcError) {
            splitGate.close(reason);
            closeSplitConnectionTracker(splitConnections);
            workerPool.close(reason);
        },
    };
}

type BackgroundWorkerPool = ReturnType<typeof createBackgroundWorkerPool>;
type EncryptionRequest = Omit<EncryptArguments, "key"> | Omit<EncryptHKDFArguments, "key">;

let pool: BackgroundWorkerPool | undefined;
let offPlatformUnloaded: (() => void) | undefined;
let nextKey = 0;

export const tasks = new Map<number, ProcessItem>();
const cancelSplits = new Map<number, (error: unknown) => void>();

export function initialiseWorkerModule(events: LiveSyncEventHub): void {
    terminateWorker();
    const current = createBackgroundWorkerPool();
    pool = current;
    offPlatformUnloaded = events.onEvent(EVENT_PLATFORM_UNLOADED, terminateWorker);
    void current.start().catch((error: unknown) => {
        if (pool === current) {
            Logger(error, LOG_LEVEL_VERBOSE);
        }
    });
}

export function terminateWorker(): void {
    const current = pool;
    pool = undefined;
    offPlatformUnloaded?.();
    offPlatformUnloaded = undefined;
    current?.close(new RpcError("disconnected", "The background Worker pool has shut down."));
    cancelSplits.clear();
    tasks.clear();
}

function getPool(): BackgroundWorkerPool {
    if (!pool) {
        throw new Error("No available workers");
    }
    return pool;
}

export function removeTask(key: number): void {
    tasks.delete(key);
}

export function cancelSplitTask(key: number): void {
    cancelSplits.get(key)?.(new RpcError("aborted", "Background split was cancelled."));
}

function createTrackedSplit(request: WorkerSplitRequest) {
    const process: SplitProcessItem = { key: nextKey++, type: "split", finalize() {} };
    const operation = createSplitOperation(
        () => {
            const current = getPool();
            tasks.set(process.key, process);
            cancelSplits.set(process.key, operation.cancel);
            return current;
        },
        request,
        (workerFinished) => {
            process.workerFinished = workerFinished;
            cancelSplits.delete(process.key);
            removeTask(process.key);
        }
    );
    return { process, iterator: operation.iterator };
}

async function consumeSplit(iterator: AsyncGenerator<string, void, unknown>): Promise<void> {
    for await (const _chunk of iterator) {
        // The low-level split task exposes completion through its handle.
    }
}

async function runEncryption(current: BackgroundWorkerPool, request: EncryptionRequest): Promise<string> {
    const lease = await current.acquire();
    const { input, passphrase } = request;
    try {
        if ("pbkdf2Salt" in request) {
            return await lease.client.call[request.type]([input, passphrase, request.pbkdf2Salt]);
        }
        return await lease.client.call[request.type]([input, passphrase, request.autoCalculateIterations]);
    } finally {
        lease.release();
    }
}

export function startWorker(data: Omit<EncryptHKDFArguments, "key">): EncryptHKDFProcessItem;
export function startWorker(data: Omit<EncryptArguments, "key">): EncryptProcessItem;
export function startWorker(data: Omit<SplitArguments, "key">): SplitProcessItem;
export function startWorker(data: EncryptionRequest | Omit<SplitArguments, "key">): ProcessItem {
    const current = getPool();
    if (data.type === "split") {
        const { type: _type, ...request } = data;
        const { process, iterator } = createTrackedSplit(request);
        void consumeSplit(iterator).catch((error: unknown) => Logger(error, LOG_LEVEL_VERBOSE));
        return process;
    }

    // Take the same snapshot as posting immediately, including a view's visible salt bytes.
    const request = "pbkdf2Salt" in data ? { ...data, pbkdf2Salt: data.pbkdf2Salt.slice() } : { ...data };
    const task = promiseWithResolvers<string>();
    const process: EncryptProcessItem | EncryptHKDFProcessItem = {
        key: nextKey++,
        type: data.type,
        task,
        finalize() {},
    };
    tasks.set(process.key, process);
    void runEncryption(current, request).then(
        (result) => {
            removeTask(process.key);
            task.resolve(result);
        },
        (error: unknown) => {
            removeTask(process.key);
            task.reject(toBackgroundWorkerError(error));
        }
    );
    return process;
}

function prepareSplit(
    splitVersion: WorkerSplitRequest["splitVersion"],
    dataSrc: Blob,
    pieceSize: number,
    plainSplit: boolean,
    minimumChunkSize: number,
    filename?: string,
    useSegmenter = false
) {
    return () =>
        createTrackedSplit({ dataSrc, pieceSize, plainSplit, minimumChunkSize, filename, useSegmenter, splitVersion })
            .iterator;
}

export function splitPieces2Worker(
    dataSrc: Blob,
    pieceSize: number,
    plainSplit: boolean,
    minimumChunkSize: number,
    filename?: string,
    useSegmenter?: boolean
) {
    return prepareSplit(1, dataSrc, pieceSize, plainSplit, minimumChunkSize, filename, useSegmenter);
}

export function splitPieces2WorkerV2(
    dataSrc: Blob,
    pieceSize: number,
    plainSplit: boolean,
    minimumChunkSize: number,
    filename?: string,
    useSegmenter?: boolean
) {
    return prepareSplit(2, dataSrc, pieceSize, plainSplit, minimumChunkSize, filename, useSegmenter);
}

export function splitPieces2WorkerRabinKarp(
    dataSrc: Blob,
    pieceSize: number,
    plainSplit: boolean,
    minimumChunkSize: number,
    filename?: string,
    useSegmenter?: boolean
) {
    return prepareSplit(3, dataSrc, pieceSize, plainSplit, minimumChunkSize, filename, useSegmenter);
}

export function encryptWorker(input: string, passphrase: string, autoCalculateIterations: boolean): Promise<string> {
    return startWorker({ type: "encrypt", input, passphrase, autoCalculateIterations }).task.promise;
}

export function decryptWorker(input: string, passphrase: string, autoCalculateIterations: boolean): Promise<string> {
    return startWorker({ type: "decrypt", input, passphrase, autoCalculateIterations }).task.promise;
}

export function encryptHKDFWorker(
    input: string,
    passphrase: string,
    pbkdf2Salt: Uint8Array<ArrayBuffer>
): Promise<string> {
    return startWorker({ type: "encryptHKDF", input, passphrase, pbkdf2Salt }).task.promise;
}

export function decryptHKDFWorker(
    input: string,
    passphrase: string,
    pbkdf2Salt: Uint8Array<ArrayBuffer>
): Promise<string> {
    return startWorker({ type: "decryptHKDF", input, passphrase, pbkdf2Salt }).task.promise;
}
