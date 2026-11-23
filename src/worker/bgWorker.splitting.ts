import type { WorkerPool, WorkerRpcConnection } from "@vrtmrz/rpc/worker";
import { RpcError } from "@vrtmrz/rpc";
import { promiseWithResolvers } from "octagonal-wheels/promises";
import {
    splitStreamItems,
    type backgroundWorkerContract,
    type WorkerSplitRequest,
} from "./backgroundWorkerRpcContract.ts";
import { toBackgroundWorkerError } from "./bgWorker.errors.ts";
import { cancelWorkerPushStream, readWorkerPushStream, stopGeneratorOnReturn } from "./workerPushStream.ts";

type Connection = WorkerRpcConnection<typeof backgroundWorkerContract>;
type SplitPool = Pick<WorkerPool<Connection, Awaited<Connection["ready"]>>, "acquire"> & {
    acquireSplitSlot(signal: AbortSignal): Promise<() => void>;
    acquireForSplit?: () => ReturnType<WorkerPool<Connection, Awaited<Connection["ready"]>>["acquire"]>;
};
type SplitEnd = "complete" | "return" | { error: unknown };

export function createSplitOperation(
    getPool: () => SplitPool,
    request: WorkerSplitRequest,
    onFinish: (workerFinished: boolean) => void
) {
    const stopped = promiseWithResolvers<void>();
    const slotWait = new AbortController();
    let end: SplitEnd | undefined;
    let reader: AsyncGenerator<readonly string[], void, unknown> | undefined;
    let releaseLease: (() => void) | undefined;
    let releaseSplitSlot: (() => void) | undefined;
    let removeDisconnectListener: (() => void) | undefined;

    function releaseTransport(): void {
        removeDisconnectListener?.();
        removeDisconnectListener = undefined;
        releaseLease?.();
        releaseLease = undefined;
        releaseSplitSlot?.();
        releaseSplitSlot = undefined;
    }

    function finish(outcome: SplitEnd): void {
        if (end !== undefined) {
            return;
        }
        end = outcome;
        slotWait.abort();
        stopped.resolve();
        void reader?.return();
        reader = undefined;
        releaseTransport();
        onFinish(outcome !== "return");
    }

    async function open(): Promise<void> {
        const pool = getPool();
        releaseSplitSlot = await pool.acquireSplitSlot(slotWait.signal);
        let portAdopted = false;
        try {
            if (end !== undefined) {
                return;
            }
            const lease = await (pool.acquireForSplit ? pool.acquireForSplit() : pool.acquire());
            releaseLease = lease.release;
            if (end !== undefined) {
                return;
            }
            const { signal } = lease.connection;
            const onDisconnect = () => {
                finish({ error: signal.reason ?? new RpcError("disconnected", "Background Worker connection ended.") });
            };
            removeDisconnectListener = () => signal.removeEventListener("abort", onDisconnect);
            signal.addEventListener("abort", onDisconnect, { once: true });
            if (signal.aborted) {
                onDisconnect();
                return;
            }

            const port = await lease.client.call.split([request]);
            if (end !== undefined) {
                cancelWorkerPushStream(port);
                return;
            }
            try {
                const stream = readWorkerPushStream({
                    port,
                    ...splitStreamItems(request.dataSrc),
                    onRemoteEnd: releaseTransport,
                    onError: (error) => finish({ error }),
                });
                portAdopted = true;
                if (end === undefined) {
                    reader = stream;
                }
            } catch (error) {
                cancelWorkerPushStream(port);
                throw error;
            }
        } finally {
            if (!portAdopted) {
                releaseTransport();
            }
        }
    }

    async function* read(): AsyncGenerator<string, void, unknown> {
        try {
            const opening = open().catch((error: unknown) => {
                if (end === undefined) {
                    throw error;
                }
            });
            await Promise.race([opening, stopped.promise]);
            if (reader !== undefined) {
                batches: for await (const batch of reader) {
                    for (const chunk of batch) {
                        if (end !== undefined) {
                            break batches;
                        }
                        yield chunk;
                    }
                }
            }
            if (typeof end === "object") {
                throw end.error;
            }
            finish("complete");
        } catch (error) {
            finish({ error });
            throw toBackgroundWorkerError(error);
        }
    }

    return {
        iterator: stopGeneratorOnReturn(read(), () => finish("return")),
        cancel: (error: unknown) => finish({ error }),
    };
}
