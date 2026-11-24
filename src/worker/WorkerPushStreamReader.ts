import { RpcError } from "@vrtmrz/rpc";
import { promiseWithResolvers } from "octagonal-wheels/promises";
import {
    VERSION,
    DEFAULT_INITIAL_CREDIT_BYTES,
    DEFAULT_MAX_BATCH_ITEMS,
    cancelWorkerPushStream,
    checkLimits,
    deserialiseError,
    disconnected,
    isRecord,
    isWireError,
    protocolError,
    stopGeneratorOnReturn,
    validateBatch,
    type Batch,
    type Failure,
    type ReaderMessage,
    type ReadOptions,
} from "./workerPushStreamProtocol.ts";

export class WorkerPushStreamReader<T> {
    private readonly port: MessagePort;
    private readonly initialCreditBytes: number;
    private readonly maxBatchItems: number;
    private readonly signal: ReadOptions<T>["signal"];
    private readonly onRemoteEnd: ReadOptions<T>["onRemoteEnd"];
    private readonly onError: ReadOptions<T>["onError"];
    private readonly queue: Batch<T>[] = [];
    private inFlightBytes = 0;
    private remoteEnded = false;
    private outcome: "return" | Failure | undefined;
    private waiting: ReturnType<typeof promiseWithResolvers<void>> | undefined;

    constructor(private readonly options: ReadOptions<T>) {
        const {
            port,
            signal,
            onRemoteEnd,
            onError,
            initialCreditBytes = DEFAULT_INITIAL_CREDIT_BYTES,
            maxBatchItems = DEFAULT_MAX_BATCH_ITEMS,
        } = options;
        this.port = port;
        this.initialCreditBytes = initialCreditBytes;
        this.maxBatchItems = maxBatchItems;
        this.signal = signal;
        this.onRemoteEnd = onRemoteEnd;
        this.onError = onError;
        checkLimits(options.maxItemBytes, this.initialCreditBytes, this.maxBatchItems);
    }

    start(): void {
        this.port.addEventListener("message", this.onMessage);
        this.port.addEventListener("messageerror", this.onMessageError);
        this.port.addEventListener("close", this.onClose);
        this.signal?.addEventListener("abort", this.onAbort, { once: true });
        this.port.start();
        if (this.signal?.aborted) {
            this.onAbort();
        } else {
            this.sendCredit(this.initialCreditBytes);
        }
    }

    cancel(): void {
        this.finish("return");
    }

    private detach(): void {
        this.port.removeEventListener("message", this.onMessage);
        this.port.removeEventListener("messageerror", this.onMessageError);
        this.port.removeEventListener("close", this.onClose);
        this.signal?.removeEventListener("abort", this.onAbort);
    }

    private finish(result: "return" | Failure, notifyPeer = true): void {
        if (this.outcome !== undefined) {
            return;
        }
        this.outcome = result;
        this.queue.length = 0;
        this.waiting?.resolve();
        if (!this.remoteEnded) {
            this.detach();
            if (notifyPeer) {
                cancelWorkerPushStream(this.port, result === "return" ? undefined : result);
            } else {
                this.port.close();
            }
        }
        if (result !== "return") {
            const { onError } = this;
            onError?.(result.error);
        }
    }

    private acceptBatch(data: Record<string, unknown>): void {
        const batch = validateBatch(
            this.options,
            data,
            this.maxBatchItems,
            this.inFlightBytes,
            this.initialCreditBytes
        );
        this.inFlightBytes += batch.chargeBytes;
        this.queue.push(batch);
        this.waiting?.resolve();
    }

    private onMessage = ({ data }: MessageEvent<unknown>): void => {
        try {
            if (!isRecord(data) || data.version !== VERSION) {
                throw protocolError("Invalid Worker stream producer message.");
            }
            switch (data.type) {
                case "batch":
                    this.acceptBatch(data);
                    return;
                case "end": {
                    this.remoteEnded = true;
                    this.detach();
                    this.port.close();
                    this.waiting?.resolve();
                    const { onRemoteEnd } = this;
                    onRemoteEnd?.();
                    return;
                }
                case "error":
                    if (isWireError(data.error)) {
                        this.finish({ error: deserialiseError(data.error) }, false);
                        return;
                    }
            }
            throw protocolError("Invalid Worker stream producer message type or error.");
        } catch (error) {
            this.finish({ error });
        }
    };

    private onMessageError = (): void => {
        this.finish({ error: protocolError("Could not decode Worker stream producer message.") });
    };

    private onClose = (): void => {
        if (!this.remoteEnded) {
            this.finish({ error: new RpcError("disconnected", "Worker stream port closed unexpectedly.") }, false);
        }
    };

    private onAbort = (): void => {
        this.finish({ error: disconnected(this.signal!) });
    };

    private sendCredit(bytes: number): void {
        try {
            const message: ReaderMessage = { version: VERSION, type: "credit", bytes };
            this.port.postMessage(message);
        } catch (error) {
            this.finish({ error });
        }
    }

    async *read(): AsyncGenerator<readonly T[], void, unknown> {
        while (this.outcome === undefined) {
            const batch = this.queue.shift();
            if (batch !== undefined) {
                yield batch.items;
                // The next call after the whole batch was yielded returns its credit.
                if (this.outcome === undefined && !this.remoteEnded) {
                    this.inFlightBytes -= batch.chargeBytes;
                    this.sendCredit(batch.chargeBytes);
                }
            } else if (this.remoteEnded) {
                return;
            } else {
                this.waiting = promiseWithResolvers<void>();
                await this.waiting.promise;
                this.waiting = undefined;
            }
        }
        if (this.outcome !== "return") {
            throw this.outcome.error;
        }
    }
}

export function readWorkerPushStream<T>(options: ReadOptions<T>): AsyncGenerator<readonly T[], void, unknown> {
    const reader = new WorkerPushStreamReader(options);
    reader.start();
    return stopGeneratorOnReturn(reader.read(), () => reader.cancel());
}
