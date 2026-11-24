import type { WorkerPool, WorkerRpcConnection } from "@vrtmrz/rpc/worker";
import { RpcError } from "@vrtmrz/rpc";
import { promiseWithResolvers } from "octagonal-wheels/promises";
import {
    splitStreamItems,
    type backgroundWorkerContract,
    type WorkerSplitRequest,
} from "./backgroundWorkerRpcContract.ts";
import { toBackgroundWorkerError } from "./bgWorker.errors.ts";
import { readWorkerPushStream } from "./WorkerPushStreamReader.ts";
import { cancelWorkerPushStream, stopGeneratorOnReturn } from "./workerPushStreamProtocol.ts";

type Connection = WorkerRpcConnection<typeof backgroundWorkerContract>;
type SplitPool = Pick<WorkerPool<Connection, Awaited<Connection["ready"]>>, "acquire"> & {
    acquireSplitSlot(signal: AbortSignal): Promise<() => void>;
    acquireForSplit?: () => ReturnType<WorkerPool<Connection, Awaited<Connection["ready"]>>["acquire"]>;
};
type SplitEnd = "complete" | "return" | { error: unknown };

interface SplitOperationState {
    getPool: () => SplitPool;
    request: WorkerSplitRequest;
    onFinish: (workerFinished: boolean) => void;
    stopped: ReturnType<typeof promiseWithResolvers<void>>;
    slotWait: AbortController;
    end?: SplitEnd;
    reader?: AsyncGenerator<readonly string[], void, unknown>;
    releaseLease?: () => void;
    releaseSplitSlot?: () => void;
    removeDisconnectListener?: () => void;
}

/** Release the connection lease and split permit as soon as transport ends. */
function releaseSplitTransport(state: SplitOperationState): void {
    const { removeDisconnectListener } = state;
    removeDisconnectListener?.();
    state.removeDisconnectListener = undefined;
    const { releaseLease } = state;
    releaseLease?.();
    state.releaseLease = undefined;
    const { releaseSplitSlot } = state;
    releaseSplitSlot?.();
    state.releaseSplitSlot = undefined;
}

/** Stop pending acquisition or reads and report the first terminal outcome. */
function finishSplitOperation(state: SplitOperationState, outcome: SplitEnd): void {
    if (state.end !== undefined) {
        return;
    }
    state.end = outcome;
    state.slotWait.abort();
    state.stopped.resolve();
    void state.reader?.return();
    state.reader = undefined;
    releaseSplitTransport(state);
    const { onFinish } = state;
    onFinish(outcome !== "return");
}

/** Acquire the transport and cancel any port that arrives after the operation stops. */
async function openSplitStream(state: SplitOperationState): Promise<void> {
    const { getPool, request } = state;
    const pool = getPool();
    state.releaseSplitSlot = await pool.acquireSplitSlot(state.slotWait.signal);
    let portAdopted = false;
    try {
        if (state.end !== undefined) {
            return;
        }
        const lease = await (pool.acquireForSplit ? pool.acquireForSplit() : pool.acquire());
        state.releaseLease = lease.release;
        if (state.end !== undefined) {
            return;
        }
        const { signal } = lease.connection;
        const onDisconnect = () => {
            finishSplitOperation(state, {
                error: signal.reason ?? new RpcError("disconnected", "Background Worker connection ended."),
            });
        };
        state.removeDisconnectListener = () => signal.removeEventListener("abort", onDisconnect);
        signal.addEventListener("abort", onDisconnect, { once: true });
        if (signal.aborted) {
            onDisconnect();
            return;
        }

        const port = await lease.client.call.split([request]);
        if (state.end !== undefined) {
            cancelWorkerPushStream(port);
            return;
        }
        try {
            const stream = readWorkerPushStream({
                port,
                ...splitStreamItems(request.dataSrc),
                onRemoteEnd: () => releaseSplitTransport(state),
                onError: (error) => finishSplitOperation(state, { error }),
            });
            portAdopted = true;
            if (state.end === undefined) {
                state.reader = stream;
            }
        } catch (error) {
            cancelWorkerPushStream(port);
            throw error;
        }
    } finally {
        if (!portAdopted) {
            releaseSplitTransport(state);
        }
    }
}

/** Drain buffered batches after the remote end and translate terminal errors. */
async function* readSplitChunks(state: SplitOperationState): AsyncGenerator<string, void, unknown> {
    try {
        const opening = openSplitStream(state).catch((error: unknown) => {
            if (state.end === undefined) {
                throw error;
            }
        });
        await Promise.race([opening, state.stopped.promise]);
        if (state.reader !== undefined) {
            batches: for await (const batch of state.reader) {
                for (const chunk of batch) {
                    if (state.end !== undefined) {
                        break batches;
                    }
                    yield chunk;
                }
            }
        }
        if (typeof state.end === "object") {
            throw state.end.error;
        }
        finishSplitOperation(state, "complete");
    } catch (error) {
        finishSplitOperation(state, { error });
        throw toBackgroundWorkerError(error);
    }
}

export function createSplitOperation(
    getPool: () => SplitPool,
    request: WorkerSplitRequest,
    onFinish: (workerFinished: boolean) => void
) {
    const state: SplitOperationState = {
        getPool,
        request,
        onFinish,
        stopped: promiseWithResolvers<void>(),
        slotWait: new AbortController(),
    };
    return {
        iterator: stopGeneratorOnReturn(readSplitChunks(state), () => finishSplitOperation(state, "return")),
        cancel: (error: unknown) => finishSplitOperation(state, { error }),
    };
}
