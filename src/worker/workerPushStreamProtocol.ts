import {
    RpcError,
    serialiseRpcError,
    type CancelSignal,
    type RpcErrorCode,
    type RpcSerializedError,
} from "@vrtmrz/rpc";
import { OUT_OF_BAND_CANCEL_ITERATOR } from "./outOfBandCancelIterator.ts";

export const VERSION = 1;
export const DEFAULT_BATCH_TARGET_BYTES = 128 * 1024;
export const DEFAULT_MAX_BATCH_ITEMS = 256;
export const DEFAULT_INITIAL_CREDIT_BYTES = 512 * 1024;
export const DEFAULT_CLAIM_TIMEOUT_MS = 30_000;

export const ITEM_OVERHEAD_BYTES = 64;
export const measureStringItem = (item: string): number => ITEM_OVERHEAD_BYTES + 2 * item.length;
export const isStringItem = (item: unknown): item is string => typeof item === "string";

export type Batch<T> = { items: readonly T[]; chargeBytes: number };
export type ReaderMessage =
    | { version: 1; type: "credit"; bytes: number }
    | { version: 1; type: "cancel"; error?: RpcSerializedError };
export type ProducerMessage<T> =
    | ({ version: 1; type: "batch" } & Batch<T>)
    | { version: 1; type: "end" }
    | { version: 1; type: "error"; error: RpcSerializedError };
export type Failure = { error: unknown };

export interface ItemOptions<T> {
    isItem: (item: unknown) => item is T;
    chargeItem: (item: T) => number;
    maxItemBytes: number;
    maxBatchItems?: number;
    signal?: CancelSignal;
}

export interface ServeOptions<T> extends ItemOptions<T> {
    createSource: (signal: AbortSignal) => AsyncIterable<T>;
    batchTargetBytes?: number;
    claimTimeoutMs?: number;
}

export interface ReadOptions<T> extends ItemOptions<T> {
    port: MessagePort;
    initialCreditBytes?: number;
    onRemoteEnd?: () => void;
    onError?: (error: unknown) => void;
}

const STREAM_ERROR_CODES = new Set<RpcErrorCode>([
    "aborted",
    "disconnected",
    "timeout",
    "stream-protocol-error",
    "remote-error",
]);

export function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isWireError(value: unknown): value is RpcSerializedError {
    return (
        isRecord(value) &&
        typeof value.code === "string" &&
        STREAM_ERROR_CODES.has(value.code as RpcErrorCode) &&
        typeof value.message === "string" &&
        (value.remoteName === undefined || typeof value.remoteName === "string")
    );
}

export function serialiseError(error: unknown): RpcSerializedError {
    try {
        const wire = serialiseRpcError(error);
        const streamError = STREAM_ERROR_CODES.has(wire.code) ? wire : { ...wire, code: "remote-error" };
        if (isWireError(streamError)) {
            return streamError;
        }
    } catch {
        // A thrown object's error fields may themselves throw on access.
    }
    return { code: "remote-error", message: "Worker stream failed." };
}

export function deserialiseError(error: RpcSerializedError): RpcError {
    return new RpcError(error.code, error.message, { remoteName: error.remoteName });
}

export function protocolError(message: string): RpcError {
    return new RpcError("stream-protocol-error", message);
}

export function isPositiveSafeInteger(value: unknown): value is number {
    return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

export function measureItem<T>(options: ItemOptions<T>, item: unknown): number {
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

export function canSend(chargeBytes: number, inFlightBytes: number, initialGrant: number): boolean {
    // A singleton can exceed the remaining credit only when no other charge is outstanding.
    return inFlightBytes === 0 || chargeBytes <= initialGrant - inFlightBytes;
}

export function checkLimits(...limits: number[]): void {
    if (!limits.every(isPositiveSafeInteger)) {
        throw new RangeError("Worker stream limits must be positive safe integers.");
    }
}

export function disconnected(signal: CancelSignal): unknown {
    return signal.reason ?? new RpcError("disconnected", "Worker stream connection ended.");
}

// TypeScript requires async disposal on AsyncGenerator. Use a private symbol on older browsers.
const asyncDispose: typeof Symbol.asyncDispose = (Symbol.asyncDispose ??
    Symbol("workerStreamAsyncDispose")) as typeof Symbol.asyncDispose;

export function stopGeneratorOnReturn<T>(
    iterator: AsyncGenerator<T, void, unknown>,
    stop: () => void
): AsyncGenerator<T, void, unknown> {
    const wrapped: AsyncGenerator<T, void, unknown> & { [OUT_OF_BAND_CANCEL_ITERATOR]: true } = {
        // Interrupt pending reads before the generator queues return or throw.
        [OUT_OF_BAND_CANCEL_ITERATOR]: true,
        next: (...args: [] | [unknown]) => iterator.next(...args),
        return(value: void | PromiseLike<void>) {
            stop();
            return iterator.return(value);
        },
        throw(error: unknown) {
            stop();
            return iterator.throw(error);
        },
        [Symbol.asyncIterator]() {
            return this;
        },
        async [asyncDispose]() {
            await this.return(undefined);
        },
    };
    return wrapped;
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

/** Validate the contents and credit charge before the reader admits a batch. */
export function validateBatch<T>(
    options: ItemOptions<T>,
    data: Record<string, unknown>,
    maxBatchItems: number,
    inFlightBytes: number,
    initialCreditBytes: number
): Batch<T> {
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
    return { items: items as T[], chargeBytes };
}
