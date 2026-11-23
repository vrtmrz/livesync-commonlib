import {
    RpcError,
    serialiseRpcError,
    withTransfer,
    type CancelSignal,
    type RpcErrorCode,
    type RpcSerializedError,
} from "@vrtmrz/rpc";
import { promiseWithResolvers } from "octagonal-wheels/promises";
import { OUT_OF_BAND_CANCEL_ITERATOR } from "./outOfBandCancelIterator.ts";

const VERSION = 1;
const DEFAULT_BATCH_TARGET_BYTES = 128 * 1024;
const DEFAULT_MAX_BATCH_ITEMS = 256;
const DEFAULT_INITIAL_CREDIT_BYTES = 512 * 1024;
const DEFAULT_CLAIM_TIMEOUT_MS = 30_000;

export const ITEM_OVERHEAD_BYTES = 64;
export const measureStringItem = (item: string): number => ITEM_OVERHEAD_BYTES + 2 * item.length;
export const isStringItem = (item: unknown): item is string => typeof item === "string";

type Batch<T> = { items: readonly T[]; chargeBytes: number };
type ReaderMessage =
    | { version: 1; type: "credit"; bytes: number }
    | { version: 1; type: "cancel"; error?: RpcSerializedError };
type ProducerMessage<T> =
    | ({ version: 1; type: "batch" } & Batch<T>)
    | { version: 1; type: "end" }
    | { version: 1; type: "error"; error: RpcSerializedError };
type Failure = { error: unknown };

interface ItemOptions<T> {
    isItem: (item: unknown) => item is T;
    chargeItem: (item: T) => number;
    maxItemBytes: number;
    maxBatchItems?: number;
    signal?: CancelSignal;
}

interface ServeOptions<T> extends ItemOptions<T> {
    createSource: (signal: AbortSignal) => AsyncIterable<T>;
    batchTargetBytes?: number;
    claimTimeoutMs?: number;
}

interface ReadOptions<T> extends ItemOptions<T> {
    port: MessagePort;
    initialCreditBytes?: number;
    onRemoteEnd?: () => void;
    onError?: (error: unknown) => void;
}

const errorCodes = new Set<RpcErrorCode>([
    "timeout",
    "aborted",
    "disconnected",
    "encode-failed",
    "decode-failed",
    "transfer-failed",
    "unsupported-profile",
    "method-not-found",
    "invalid-contract",
    "invalid-envelope",
    "stream-protocol-error",
    "send-failed",
    "remote-error",
    "internal-error",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isWireError(value: unknown): value is RpcSerializedError {
    return (
        isRecord(value) &&
        typeof value.code === "string" &&
        errorCodes.has(value.code as RpcErrorCode) &&
        typeof value.message === "string" &&
        (value.remoteName === undefined || typeof value.remoteName === "string")
    );
}

function serialiseError(error: unknown): RpcSerializedError {
    try {
        const wire = serialiseRpcError(error);
        if (isWireError(wire)) {
            return wire;
        }
    } catch {
        // A thrown object's error fields may themselves throw on access.
    }
    return { code: "remote-error", message: "Worker stream failed." };
}

function deserialiseError(error: RpcSerializedError): RpcError {
    return new RpcError(error.code, error.message, { remoteName: error.remoteName });
}

function protocolError(message: string): RpcError {
    return new RpcError("stream-protocol-error", message);
}

function isPositiveSafeInteger(value: unknown): value is number {
    return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function measureItem<T>(options: ItemOptions<T>, item: unknown): number {
    try {
        if (options.isItem(item)) {
            const charge = options.chargeItem(item);
            if (isPositiveSafeInteger(charge) && charge <= options.maxItemBytes) {
                return charge;
            }
        }
    } catch (cause) {
        throw new RpcError("stream-protocol-error", "Could not measure Worker stream item.", { cause });
    }
    throw protocolError("Invalid Worker stream item or item charge.");
}

function canSend(chargeBytes: number, inFlightBytes: number, initialGrant: number): boolean {
    // A singleton can exceed the remaining credit only when no other charge is outstanding.
    return inFlightBytes === 0 || chargeBytes <= initialGrant - inFlightBytes;
}

function checkLimits(...limits: number[]): void {
    if (!limits.every(isPositiveSafeInteger)) {
        throw new RangeError("Worker stream limits must be positive safe integers.");
    }
}

function disconnected(signal: CancelSignal): unknown {
    return signal.reason ?? new RpcError("disconnected", "Worker stream connection ended.");
}

export function stopGeneratorOnReturn<T>(
    iterator: AsyncGenerator<T, void, unknown>,
    stop: () => void
): AsyncGenerator<T, void, unknown> {
    const originalReturn = iterator.return.bind(iterator);
    const originalThrow = iterator.throw.bind(iterator);
    // Interrupt pending reads before the generator queues return or throw.
    iterator.return = (value) => {
        stop();
        return originalReturn(value);
    };
    iterator.throw = (error) => {
        stop();
        return originalThrow(error);
    };
    Object.defineProperty(iterator, OUT_OF_BAND_CANCEL_ITERATOR, { value: true });
    return iterator;
}

export function cancelWorkerPushStream(port: MessagePort, failure?: Failure): void {
    try {
        const message: ReaderMessage = failure
            ? { version: VERSION, type: "cancel", error: serialiseError(failure.error) }
            : { version: VERSION, type: "cancel" };
        port.postMessage(message);
    } catch {
        // The remote endpoint may already have closed.
    } finally {
        port.close();
    }
}

export function serveWorkerPushStream<T>(options: ServeOptions<T>) {
    const {
        batchTargetBytes = DEFAULT_BATCH_TARGET_BYTES,
        maxBatchItems = DEFAULT_MAX_BATCH_ITEMS,
        claimTimeoutMs = DEFAULT_CLAIM_TIMEOUT_MS,
        signal,
    } = options;
    checkLimits(options.maxItemBytes, batchTargetBytes, maxBatchItems, claimTimeoutMs);
    const { port1: producerPort, port2: readerPort } = new MessageChannel();
    const controller = new AbortController();
    let source: AsyncIterator<T> | undefined;
    let finished = false;
    let pumping = false;
    let initialGrant = 0;
    let inFlightBytes = 0;
    let oversizedInFlight = false;
    let batch: T[] = [];
    let batchCharge = 0;
    let stagedItem: { item: T; charge: number } | undefined;
    let flushTimer: ReturnType<typeof setTimeout> | undefined;
    let yieldChannel: MessageChannel | undefined;
    let yieldAfterBatch: Promise<void> | undefined;
    let resolveYield: (() => void) | undefined;
    const claimTimer = setTimeout(
        () => finish({ error: new RpcError("timeout", "Worker stream port was not claimed.") }),
        claimTimeoutMs
    );

    function post(message: ProducerMessage<T>): void {
        producerPort.postMessage(message);
    }

    function clearYield(): void {
        const resolve = resolveYield;
        resolveYield = undefined;
        yieldAfterBatch = undefined;
        resolve?.();
        if (yieldChannel !== undefined) {
            yieldChannel.port1.onmessage = null;
            yieldChannel.port1.close();
            yieldChannel.port2.close();
            yieldChannel = undefined;
        }
    }

    function scheduleYield(): void {
        if (yieldAfterBatch !== undefined) {
            return;
        }
        if (yieldChannel === undefined) {
            yieldChannel = new MessageChannel();
        }
        const channel = yieldChannel;
        yieldAfterBatch = new Promise<void>((resolve) => {
            resolveYield = resolve;
            channel.port1.onmessage = () => {
                if (resolveYield === resolve) {
                    resolveYield = undefined;
                    yieldAfterBatch = undefined;
                    resolve();
                }
            };
            channel.port2.postMessage(undefined);
        });
    }

    function finish(failure?: Failure, notifyPeer = true): void {
        if (finished) {
            return;
        }
        finished = true;
        clearTimeout(claimTimer);
        clearTimeout(flushTimer);
        clearYield();
        batch = [];
        stagedItem = undefined;
        producerPort.removeEventListener("message", onMessage);
        producerPort.removeEventListener("messageerror", onMessageError);
        producerPort.removeEventListener("close", onClose);
        signal?.removeEventListener("abort", onAbort);
        try {
            if (failure && notifyPeer) {
                post({ version: VERSION, type: "error", error: serialiseError(failure.error) });
            }
        } catch {
            // Cleanup still owns the source if the peer cannot receive the error.
        } finally {
            producerPort.close();
            if (failure || source) {
                controller.abort(failure?.error);
            }
            if (source) {
                try {
                    void Promise.resolve(source.return?.()).catch((): void => undefined);
                } catch {
                    // A source may throw while closing after cancellation.
                }
                source = undefined;
            }
        }
    }

    function postBatch(shouldYield: boolean): void {
        post({ version: VERSION, type: "batch", items: batch, chargeBytes: batchCharge });
        inFlightBytes += batchCharge;
        oversizedInFlight = batchCharge > initialGrant;
        batch = [];
        batchCharge = 0;
        if (shouldYield) {
            scheduleYield();
        }
    }

    function flushWhileReading(): void {
        if (!finished && batch.length > 0) {
            try {
                postBatch(true);
            } catch (error) {
                finish({ error });
            }
        }
    }

    function admitStagedItem(limit: number): "continue" | "wait" {
        const next = stagedItem!;
        if (batch.length > 0 && next.charge > limit - batchCharge) {
            postBatch(true);
            return "continue";
        }
        if (!canSend(next.charge, inFlightBytes, initialGrant)) {
            return "wait";
        }
        batch.push(next.item);
        batchCharge += next.charge;
        stagedItem = undefined;
        if (batchCharge >= limit || batch.length === maxBatchItems) {
            postBatch(true);
        }
        return "continue";
    }

    async function readNextItem(iterator: AsyncIterator<T>): Promise<IteratorResult<T>> {
        if (batch.length > 0) {
            flushTimer = setTimeout(flushWhileReading, 0);
        }
        try {
            return await iterator.next();
        } finally {
            clearTimeout(flushTimer);
        }
    }

    async function pump(iterator: AsyncIterator<T>): Promise<void> {
        if (pumping) {
            return;
        }
        pumping = true;
        try {
            while (!finished) {
                if (yieldAfterBatch !== undefined) {
                    await yieldAfterBatch;
                    if (finished) {
                        return;
                    }
                }
                if (oversizedInFlight) {
                    return;
                }
                const available = initialGrant - inFlightBytes;
                const limit = Math.min(batchTargetBytes, available);
                if (stagedItem !== undefined) {
                    if (admitStagedItem(limit) === "wait") {
                        return;
                    }
                    continue;
                }
                if (available <= 0) {
                    return;
                }
                const result = await readNextItem(iterator);
                if (finished) {
                    return;
                }
                if (result.done) {
                    if (batch.length > 0) {
                        postBatch(false);
                    }
                    post({ version: VERSION, type: "end" });
                    source = undefined;
                    finish();
                    return;
                }
                stagedItem = { item: result.value, charge: measureItem(options, result.value) };
            }
        } catch (error) {
            finish({ error });
        } finally {
            pumping = false;
        }
    }

    function applyCancel(rawError: unknown): void {
        // Cancellation also closes an unclaimed port without starting the source.
        if (rawError === undefined) {
            finish({ error: new RpcError("aborted", "Worker stream reader cancelled.") }, false);
        } else if (isWireError(rawError)) {
            finish({ error: deserialiseError(rawError) }, false);
        } else {
            finish({ error: protocolError("Invalid Worker stream cancellation error.") });
        }
    }

    function applyCredit(bytes: number): void {
        if (initialGrant === 0) {
            initialGrant = bytes;
            clearTimeout(claimTimer);
            try {
                source = options.createSource(controller.signal)[Symbol.asyncIterator]();
            } catch (error) {
                finish({ error });
                return;
            }
        } else {
            if (bytes > inFlightBytes) {
                finish({ error: protocolError("Worker stream refunded more than the outstanding charge.") });
                return;
            }
            inFlightBytes -= bytes;
            if (inFlightBytes === 0) {
                oversizedInFlight = false;
            }
        }
        if (source) {
            void pump(source);
        }
    }

    function onMessage({ data }: MessageEvent<unknown>): void {
        if (!isRecord(data) || data.version !== VERSION) {
            finish({ error: protocolError("Invalid Worker stream reader message.") });
            return;
        }
        if (data.type === "cancel") {
            applyCancel(data.error);
            return;
        }
        if (data.type !== "credit" || !isPositiveSafeInteger(data.bytes)) {
            finish({ error: protocolError("Invalid Worker stream credit.") });
            return;
        }
        applyCredit(data.bytes);
    }

    function onMessageError(): void {
        finish({ error: protocolError("Could not decode Worker stream reader message.") });
    }

    function onClose(): void {
        finish({ error: new RpcError("disconnected", "Worker stream port closed unexpectedly.") }, false);
    }

    function onAbort(): void {
        finish({ error: disconnected(signal!) });
    }

    producerPort.addEventListener("message", onMessage);
    producerPort.addEventListener("messageerror", onMessageError);
    producerPort.addEventListener("close", onClose);
    signal?.addEventListener("abort", onAbort, { once: true });
    producerPort.start();
    if (signal?.aborted) {
        onAbort();
    }
    return withTransfer(readerPort, [readerPort]);
}

export function readWorkerPushStream<T>(options: ReadOptions<T>): AsyncGenerator<readonly T[], void, unknown> {
    const {
        port,
        signal,
        onRemoteEnd,
        onError,
        initialCreditBytes = DEFAULT_INITIAL_CREDIT_BYTES,
        maxBatchItems = DEFAULT_MAX_BATCH_ITEMS,
    } = options;
    checkLimits(options.maxItemBytes, initialCreditBytes, maxBatchItems);
    const queue: Batch<T>[] = [];
    let inFlightBytes = 0;
    let remoteEnded = false;
    let outcome: "return" | Failure | undefined;
    let waiting: ReturnType<typeof promiseWithResolvers<void>> | undefined;

    function detach(): void {
        port.removeEventListener("message", onMessage);
        port.removeEventListener("messageerror", onMessageError);
        port.removeEventListener("close", onClose);
        signal?.removeEventListener("abort", onAbort);
    }

    function finish(result: "return" | Failure, notifyPeer = true): void {
        if (outcome !== undefined) {
            return;
        }
        outcome = result;
        queue.length = 0;
        waiting?.resolve();
        if (!remoteEnded) {
            detach();
            if (notifyPeer) {
                cancelWorkerPushStream(port, result === "return" ? undefined : result);
            } else {
                port.close();
            }
        }
        if (result !== "return") {
            onError?.(result.error);
        }
    }

    function acceptBatch(data: Record<string, unknown>): void {
        const { items, chargeBytes } = data;
        if (
            !Array.isArray(items) ||
            items.length === 0 ||
            items.length > maxBatchItems ||
            !isPositiveSafeInteger(chargeBytes) ||
            !canSend(chargeBytes, inFlightBytes, initialCreditBytes) ||
            (chargeBytes > initialCreditBytes - inFlightBytes && items.length !== 1)
        ) {
            throw protocolError("Invalid Worker stream batch or credit usage.");
        }
        let measured = 0;
        for (const item of items) {
            const charge = measureItem(options, item);
            if (charge > chargeBytes - measured) {
                throw protocolError("Worker stream batch charge does not match its items.");
            }
            measured += charge;
        }
        if (measured !== chargeBytes) {
            throw protocolError("Worker stream batch charge does not match its items.");
        }
        inFlightBytes += chargeBytes;
        queue.push({ items, chargeBytes });
        waiting?.resolve();
    }

    function onMessage({ data }: MessageEvent<unknown>): void {
        try {
            if (!isRecord(data) || data.version !== VERSION) {
                throw protocolError("Invalid Worker stream producer message.");
            }
            switch (data.type) {
                case "batch":
                    acceptBatch(data);
                    return;
                case "end":
                    remoteEnded = true;
                    detach();
                    port.close();
                    waiting?.resolve();
                    onRemoteEnd?.();
                    return;
                case "error":
                    if (isWireError(data.error)) {
                        finish({ error: deserialiseError(data.error) }, false);
                        return;
                    }
            }
            throw protocolError("Invalid Worker stream producer message type or error.");
        } catch (error) {
            finish({ error });
        }
    }

    function onMessageError(): void {
        finish({ error: protocolError("Could not decode Worker stream producer message.") });
    }

    function onClose(): void {
        if (!remoteEnded) {
            finish({ error: new RpcError("disconnected", "Worker stream port closed unexpectedly.") }, false);
        }
    }

    function onAbort(): void {
        finish({ error: disconnected(signal!) });
    }

    function sendCredit(bytes: number): void {
        try {
            const message: ReaderMessage = { version: VERSION, type: "credit", bytes };
            port.postMessage(message);
        } catch (error) {
            finish({ error });
        }
    }

    async function* read(): AsyncGenerator<readonly T[], void, unknown> {
        while (outcome === undefined) {
            const batch = queue.shift();
            if (batch !== undefined) {
                yield batch.items;
                // The next call after the whole batch was yielded returns its credit.
                if (outcome === undefined && !remoteEnded) {
                    inFlightBytes -= batch.chargeBytes;
                    sendCredit(batch.chargeBytes);
                }
            } else if (remoteEnded) {
                return;
            } else {
                waiting = promiseWithResolvers<void>();
                await waiting.promise;
                waiting = undefined;
            }
        }
        if (outcome !== "return") {
            throw outcome.error;
        }
    }

    port.addEventListener("message", onMessage);
    port.addEventListener("messageerror", onMessageError);
    port.addEventListener("close", onClose);
    signal?.addEventListener("abort", onAbort, { once: true });
    port.start();
    if (signal?.aborted) {
        onAbort();
    } else {
        sendCredit(initialCreditBytes);
    }
    return stopGeneratorOnReturn(read(), () => finish("return"));
}
