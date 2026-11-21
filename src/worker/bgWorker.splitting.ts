import { readWorkerStream, type WorkerPool, type WorkerRpcConnection, type WorkerStreamPort } from "@vrtmrz/rpc/worker";
import { RpcError } from "@vrtmrz/rpc";
import { promiseWithResolvers } from "octagonal-wheels/promises";
import type { backgroundWorkerContract, WorkerSplitRequest } from "./backgroundWorkerRpcContract.ts";
import { toBackgroundWorkerError } from "./bgWorker.errors.ts";

type Connection = WorkerRpcConnection<typeof backgroundWorkerContract>;
type SplitPool = Pick<WorkerPool<Connection, Awaited<Connection["ready"]>>, "acquire">;
type SplitEnd = "complete" | "return" | { error: unknown };

export interface SplitDelivery<Result> {
    readonly frameCapacity: (input: Blob) => number;
    readonly connect: (client: Awaited<Connection["ready"]>, request: WorkerSplitRequest) => Promise<WorkerStreamPort>;
    readonly decode: (frame: string) => Result;
}

export function createSplitOperation<Result>(
    getPool: () => SplitPool,
    request: WorkerSplitRequest,
    onFinish: (workerFinished: boolean) => void,
    delivery: SplitDelivery<Result>
) {
    const stopped = promiseWithResolvers<void>();
    const maxChunkBytes = delivery.frameCapacity(request.dataSrc);
    let end: SplitEnd | undefined;
    let reader: ReturnType<typeof readWorkerStream> | undefined;
    let releaseLease: (() => void) | undefined;
    let removeDisconnectListener: (() => void) | undefined;

    function finish(outcome: SplitEnd): void {
        if (end !== undefined) {
            return;
        }
        end = outcome;
        stopped.resolve();
        removeDisconnectListener?.();
        removeDisconnectListener = undefined;
        void reader?.return?.();
        reader = undefined;
        releaseLease?.();
        releaseLease = undefined;
        onFinish(outcome !== "return");
    }

    async function open(): Promise<void> {
        const lease = await getPool().acquire();
        try {
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
            const port = await delivery.connect(lease.client, request);
            const stream = readWorkerStream({ port, maxChunkBytes, signal });
            if (end !== undefined) {
                // A port transferred during cancellation must still be claimed and closed.
                await stream.return?.();
                return;
            }
            reader = stream;
            releaseLease = lease.release;
        } finally {
            if (releaseLease === undefined) {
                lease.release();
            }
        }
    }

    async function* read(): AsyncGenerator<Result, void, unknown> {
        try {
            await Promise.race([open(), stopped.promise]);
            if (reader !== undefined) {
                for await (const chunk of reader) {
                    if (end !== undefined) {
                        break;
                    }
                    if (typeof chunk !== "string") {
                        throw new TypeError("A split result must be a string.");
                    }
                    yield delivery.decode(chunk);
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

    const iterator = read();
    const originalReturn = iterator.return.bind(iterator);
    const originalThrow = iterator.throw.bind(iterator);
    // Async generators queue return and throw behind a pending next. Close the reader first.
    iterator.return = (value) => {
        finish("return");
        return originalReturn(value);
    };
    iterator.throw = (error) => {
        finish("return");
        return originalThrow(error);
    };

    return { iterator, cancel: (error: unknown) => finish({ error }) };
}
