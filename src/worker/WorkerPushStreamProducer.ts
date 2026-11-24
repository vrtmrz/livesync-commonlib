import { RpcError, withTransfer } from "@vrtmrz/rpc";
import {
    VERSION,
    DEFAULT_BATCH_TARGET_BYTES,
    DEFAULT_CLAIM_TIMEOUT_MS,
    DEFAULT_MAX_BATCH_ITEMS,
    canSend,
    checkLimits,
    deserialiseError,
    disconnected,
    isPositiveSafeInteger,
    isRecord,
    isWireError,
    measureItem,
    protocolError,
    serialiseError,
    type Failure,
    type ProducerMessage,
    type ServeOptions,
} from "./workerPushStreamProtocol.ts";

export class WorkerPushStreamProducer<T> {
    readonly readerPort: MessagePort;
    private readonly producerPort: MessagePort;
    private readonly controller = new AbortController();
    private readonly batchTargetBytes: number;
    private readonly maxBatchItems: number;
    private readonly signal: ServeOptions<T>["signal"];
    private source: AsyncIterator<T> | undefined;
    private finished = false;
    private pumping = false;
    private initialGrant = 0;
    private inFlightBytes = 0;
    private oversizedInFlight = false;
    private batch: T[] = [];
    private batchCharge = 0;
    private stagedItem: { item: T; charge: number } | undefined;
    private flushTimer: ReturnType<typeof setTimeout> | undefined;
    private yieldChannel: MessageChannel | undefined;
    private yieldAfterBatch: Promise<void> | undefined;
    private resolveYield: (() => void) | undefined;
    private readonly claimTimer: ReturnType<typeof setTimeout>;

    constructor(private readonly options: ServeOptions<T>) {
        const {
            batchTargetBytes = DEFAULT_BATCH_TARGET_BYTES,
            maxBatchItems = DEFAULT_MAX_BATCH_ITEMS,
            claimTimeoutMs = DEFAULT_CLAIM_TIMEOUT_MS,
            signal,
        } = options;
        this.batchTargetBytes = batchTargetBytes;
        this.maxBatchItems = maxBatchItems;
        this.signal = signal;
        checkLimits(options.maxItemBytes, this.batchTargetBytes, this.maxBatchItems, claimTimeoutMs);
        const { port1, port2 } = new MessageChannel();
        this.producerPort = port1;
        this.readerPort = port2;
        this.claimTimer = setTimeout(
            () => this.finish({ error: new RpcError("timeout", "Worker stream port was not claimed.") }),
            claimTimeoutMs
        );
        this.producerPort.addEventListener("message", this.onMessage);
        this.producerPort.addEventListener("messageerror", this.onMessageError);
        this.producerPort.addEventListener("close", this.onClose);
        signal?.addEventListener("abort", this.onAbort, { once: true });
        this.producerPort.start();
        if (signal?.aborted) {
            this.onAbort();
        }
    }

    private post(message: ProducerMessage<T>): void {
        this.producerPort.postMessage(message);
    }

    /** Unblock the pump and close both ends of its scheduling channel. */
    private clearYield(): void {
        const resolve = this.resolveYield;
        this.resolveYield = undefined;
        this.yieldAfterBatch = undefined;
        resolve?.();
        if (this.yieldChannel !== undefined) {
            this.yieldChannel.port1.onmessage = null;
            this.yieldChannel.port1.close();
            this.yieldChannel.port2.close();
            this.yieldChannel = undefined;
        }
    }

    /** Let pending port events run between batches without relying on a timer. */
    private scheduleYield(): void {
        if (this.yieldAfterBatch !== undefined) {
            return;
        }
        if (this.yieldChannel === undefined) {
            this.yieldChannel = new MessageChannel();
        }
        const channel = this.yieldChannel;
        this.yieldAfterBatch = new Promise<void>((resolve) => {
            this.resolveYield = resolve;
            channel.port1.onmessage = () => {
                if (this.resolveYield === resolve) {
                    this.resolveYield = undefined;
                    this.yieldAfterBatch = undefined;
                    resolve();
                }
            };
            channel.port2.postMessage(undefined);
        });
    }

    private finish(failure?: Failure, notifyPeer = true): void {
        if (this.finished) {
            return;
        }
        this.finished = true;
        clearTimeout(this.claimTimer);
        clearTimeout(this.flushTimer);
        this.clearYield();
        this.batch = [];
        this.stagedItem = undefined;
        this.producerPort.removeEventListener("message", this.onMessage);
        this.producerPort.removeEventListener("messageerror", this.onMessageError);
        this.producerPort.removeEventListener("close", this.onClose);
        this.signal?.removeEventListener("abort", this.onAbort);
        try {
            if (failure && notifyPeer) {
                this.post({ version: VERSION, type: "error", error: serialiseError(failure.error) });
            }
        } catch {
            // Cleanup still owns the source if the peer cannot receive the error.
        } finally {
            this.producerPort.close();
            if (failure || this.source) {
                this.controller.abort(failure?.error);
            }
            if (this.source) {
                try {
                    void Promise.resolve(this.source.return?.()).catch((): void => undefined);
                } catch {
                    // A source may throw while closing after cancellation.
                }
                this.source = undefined;
            }
        }
    }

    private postBatch(shouldYield: boolean): void {
        this.post({ version: VERSION, type: "batch", items: this.batch, chargeBytes: this.batchCharge });
        this.inFlightBytes += this.batchCharge;
        this.oversizedInFlight = this.batchCharge > this.initialGrant;
        this.batch = [];
        this.batchCharge = 0;
        if (shouldYield) {
            this.scheduleYield();
        }
    }

    private flushWhileReading = (): void => {
        if (!this.finished && this.batch.length > 0) {
            try {
                this.postBatch(true);
            } catch (error) {
                this.finish({ error });
            }
        }
    };

    /** Flush a full batch before admitting the staged item against the remaining credit. */
    private admitStagedItem(limit: number): "continue" | "wait" {
        const next = this.stagedItem!;
        if (this.batch.length > 0 && next.charge > limit - this.batchCharge) {
            this.postBatch(true);
            return "continue";
        }
        if (!canSend(next.charge, this.inFlightBytes, this.initialGrant)) {
            return "wait";
        }
        this.batch.push(next.item);
        this.batchCharge += next.charge;
        this.stagedItem = undefined;
        if (this.batchCharge >= limit || this.batch.length === this.maxBatchItems) {
            this.postBatch(true);
        }
        return "continue";
    }

    /** Flush an accumulated batch if the source takes another task to produce an item. */
    private async readNextItem(iterator: AsyncIterator<T>): Promise<IteratorResult<T>> {
        if (this.batch.length > 0) {
            this.flushTimer = setTimeout(this.flushWhileReading, 0);
        }
        try {
            return await iterator.next();
        } finally {
            clearTimeout(this.flushTimer);
        }
    }

    private async pump(iterator: AsyncIterator<T>): Promise<void> {
        if (this.pumping) {
            return;
        }
        this.pumping = true;
        try {
            while (!this.finished) {
                if (this.yieldAfterBatch !== undefined) {
                    await this.yieldAfterBatch;
                    if (this.finished) {
                        return;
                    }
                }
                if (this.oversizedInFlight) {
                    return;
                }
                const available = this.initialGrant - this.inFlightBytes;
                const limit = Math.min(this.batchTargetBytes, available);
                if (this.stagedItem !== undefined) {
                    if (this.admitStagedItem(limit) === "wait") {
                        return;
                    }
                    continue;
                }
                if (available <= 0) {
                    return;
                }
                const result = await this.readNextItem(iterator);
                if (this.finished) {
                    return;
                }
                if (result.done) {
                    if (this.batch.length > 0) {
                        this.postBatch(false);
                    }
                    this.post({ version: VERSION, type: "end" });
                    this.source = undefined;
                    this.finish();
                    return;
                }
                this.stagedItem = { item: result.value, charge: measureItem(this.options, result.value) };
            }
        } catch (error) {
            this.finish({ error });
        } finally {
            this.pumping = false;
        }
    }

    private applyCancel(rawError: unknown): void {
        // Cancellation also closes an unclaimed port without starting the source.
        if (rawError === undefined) {
            this.finish({ error: new RpcError("aborted", "Worker stream reader cancelled.") }, false);
        } else if (isWireError(rawError)) {
            this.finish({ error: deserialiseError(rawError) }, false);
        } else {
            this.finish({ error: protocolError("Invalid Worker stream cancellation error.") });
        }
    }

    private applyCredit(bytes: number): void {
        if (this.initialGrant === 0) {
            this.initialGrant = bytes;
            clearTimeout(this.claimTimer);
            try {
                this.source = this.options.createSource(this.controller.signal)[Symbol.asyncIterator]();
            } catch (error) {
                this.finish({ error });
                return;
            }
        } else {
            if (bytes > this.inFlightBytes) {
                this.finish({ error: protocolError("Worker stream refunded more than the outstanding charge.") });
                return;
            }
            this.inFlightBytes -= bytes;
            if (this.inFlightBytes === 0) {
                this.oversizedInFlight = false;
            }
        }
        if (this.source) {
            void this.pump(this.source);
        }
    }

    private onMessage = ({ data }: MessageEvent<unknown>): void => {
        if (!isRecord(data) || data.version !== VERSION) {
            this.finish({ error: protocolError("Invalid Worker stream reader message.") });
            return;
        }
        if (data.type === "cancel") {
            this.applyCancel(data.error);
            return;
        }
        if (data.type !== "credit" || !isPositiveSafeInteger(data.bytes)) {
            this.finish({ error: protocolError("Invalid Worker stream credit.") });
            return;
        }
        this.applyCredit(data.bytes);
    };

    private onMessageError = (): void => {
        this.finish({ error: protocolError("Could not decode Worker stream reader message.") });
    };

    private onClose = (): void => {
        this.finish({ error: new RpcError("disconnected", "Worker stream port closed unexpectedly.") }, false);
    };

    private onAbort = (): void => {
        this.finish({ error: disconnected(this.signal!) });
    };
}

export function serveWorkerPushStream<T>(options: ServeOptions<T>) {
    const { readerPort } = new WorkerPushStreamProducer(options);
    return withTransfer(readerPort, [readerPort]);
}
