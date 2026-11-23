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

function createSplitGate(capacity: number) {
    const waiters = new Set<ReturnType<typeof promiseWithResolvers<void>>>();
    let active = 0;
    let closed: RpcError | undefined;

    function release(): void {
        const next = waiters.values().next().value;
        if (next === undefined) {
            active--;
            return;
        }
        waiters.delete(next);
        next.resolve();
    }

    async function acquire(signal: AbortSignal): Promise<() => void> {
        if (closed !== undefined) {
            throw closed;
        }
        if (signal.aborted) {
            throw signal.reason;
        }
        if (active < capacity) {
            active++;
            return release;
        }

        const waiter = promiseWithResolvers<void>();
        const onAbort = () => {
            if (waiters.delete(waiter)) {
                waiter.reject(signal.reason);
            }
        };
        waiters.add(waiter);
        signal.addEventListener("abort", onAbort, { once: true });
        try {
            await waiter.promise;
            return release;
        } finally {
            signal.removeEventListener("abort", onAbort);
        }
    }

    function close(error: RpcError): void {
        closed = error;
        for (const waiter of waiters) {
            waiter.reject(error);
        }
        waiters.clear();
    }

    return { acquire, close };
}

function createBackgroundWorkerPool() {
    const size = Math.max(1, Math.floor((compatGlobal.navigator.hardwareConcurrency || 8) / 2));
    const splitGate = createSplitGate(size);
    type PoolConnection = ReturnType<typeof connectWorkerRpc<typeof backgroundWorkerContract>>;
    type PoolClient = Awaited<PoolConnection["ready"]>;
    const readySlots = new Map<PoolConnection, PoolClient>();
    const activeSplitCounts = new Map<PoolConnection, number>();
    let closed = false;

    const workerPool = createWorkerPool({
        size,
        createConnection: () => {
            const connection = connectWorkerRpc({
                contract: backgroundWorkerContract,
                createWorker: () => createInlineWorker() as Worker,
            });
            const removeSlot = () => {
                readySlots.delete(connection);
                activeSplitCounts.delete(connection);
            };
            connection.signal.addEventListener("abort", removeSlot, { once: true });
            void connection.ready.then(
                (client) => {
                    if (!closed && !connection.signal.aborted) {
                        readySlots.set(connection, client);
                    }
                },
                (): void => undefined
            );
            return connection;
        },
    });

    function reserveSplitConnection(
        connection: PoolConnection,
        client: PoolClient,
        releaseCandidate?: () => void
    ) {
        activeSplitCounts.set(connection, (activeSplitCounts.get(connection) ?? 0) + 1);
        let released = false;
        return {
            connection,
            client,
            release() {
                if (released) {
                    return;
                }
                released = true;
                const remaining = (activeSplitCounts.get(connection) ?? 0) - 1;
                if (remaining > 0) {
                    activeSplitCounts.set(connection, remaining);
                } else {
                    activeSplitCounts.delete(connection);
                }
                releaseCandidate?.();
            },
        };
    }

    async function acquireForSplit() {
        const candidate = await workerPool.acquire();
        if ((activeSplitCounts.get(candidate.connection) ?? 0) === 0) {
            return reserveSplitConnection(candidate.connection, candidate.client, candidate.release);
        }

        // Another ready Worker has no active split even if encryption leases make it look busier.
        for (const [connection, client] of readySlots) {
            if (!connection.signal.aborted && (activeSplitCounts.get(connection) ?? 0) === 0) {
                candidate.release();
                return reserveSplitConnection(connection, client);
            }
        }

        // Fallback when another slot is restarting and no unreserved ready Worker exists yet.
        return reserveSplitConnection(candidate.connection, candidate.client, candidate.release);
    }

    return {
        ...workerPool,
        acquireSplitSlot: splitGate.acquire,
        acquireForSplit,
        close(reason: RpcError) {
            closed = true;
            splitGate.close(reason);
            readySlots.clear();
            activeSplitCounts.clear();
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
