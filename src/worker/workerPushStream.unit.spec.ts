import { serialize } from "node:v8";
import { RpcError } from "@vrtmrz/rpc";
import { promiseWithResolvers } from "octagonal-wheels/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
    ITEM_OVERHEAD_BYTES,
    cancelWorkerPushStream,
    isStringItem,
    measureStringItem,
    readWorkerPushStream,
    serveWorkerPushStream,
} from "./workerPushStream.ts";

const limits = { isItem: isStringItem, chargeItem: measureStringItem, maxItemBytes: 128 * 1024 };
const batch = (items: readonly string[]) => ({
    version: 1,
    type: "batch",
    items,
    chargeBytes: items.reduce((charge, item) => charge + measureStringItem(item), 0),
});

async function* items(values: readonly string[]): AsyncGenerator<string> {
    yield* values;
}

async function collect(stream: AsyncIterable<readonly string[]>): Promise<(readonly string[])[]> {
    const batches: (readonly string[])[] = [];
    for await (const items of stream) {
        batches.push(items);
    }
    return batches;
}

function receive(port: MessagePort) {
    const messages: unknown[] = [];
    port.addEventListener("message", ({ data }) => messages.push(data));
    port.start();
    return messages;
}

function captureChannel(): MessageChannel {
    const NativeMessageChannel = globalThis.MessageChannel;
    const channel = new NativeMessageChannel();
    let captured = false;
    vi.stubGlobal(
        "MessageChannel",
        class {
            port1: MessagePort;
            port2: MessagePort;
            constructor() {
                if (!captured) {
                    captured = true;
                    this.port1 = channel.port1;
                    this.port2 = channel.port2;
                } else {
                    const extra = new NativeMessageChannel();
                    this.port1 = extra.port1;
                    this.port2 = extra.port2;
                }
            }
        }
    );
    return channel;
}

function nextMessage(port: MessagePort): Promise<unknown> {
    const message = promiseWithResolvers<unknown>();
    port.addEventListener("message", ({ data }) => message.resolve(data), { once: true });
    port.start();
    return message.promise;
}

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("Worker push stream", () => {
    it("preserves ordered chunks across batches, charging empty strings and capping batch items", async () => {
        const input = ["", "", "", "ASCII", "漢🙂", ""];
        const maxBatchItems = 2;
        const createSource = vi.fn(() => items(input));
        const { value: port } = serveWorkerPushStream({ ...limits, createSource, maxBatchItems });
        const messages = receive(port);
        expect(createSource).not.toHaveBeenCalled();
        expect(measureStringItem("")).toBe(64);
        const reader = readWorkerPushStream({ ...limits, port, maxBatchItems });
        try {
            await expect(collect(reader)).resolves.toEqual([input.slice(0, 2), input.slice(2, 4), input.slice(4)]);
            expect(messages).toEqual([
                { ...batch(["", ""]), chargeBytes: 2 * ITEM_OVERHEAD_BYTES },
                batch(["", "ASCII"]),
                batch(["漢🙂", ""]),
                { version: 1, type: "end" },
            ]);
            expect(createSource).toHaveBeenCalledTimes(1);
        } finally {
            await reader.return();
        }
    });

    it("ends a source that yields no items", async () => {
        const { value: port } = serveWorkerPushStream({ ...limits, createSource: () => items([]) });
        const onRemoteEnd = vi.fn();
        const reader = readWorkerPushStream({ ...limits, port, onRemoteEnd });
        await expect(reader.next()).resolves.toEqual({ done: true, value: undefined });
        expect(onRemoteEnd).toHaveBeenCalledTimes(1);
    });

    it("stalls the producer at the credit limit until the consumer advances past a batch", async () => {
        const input = Array.from({ length: 10 }, (_, i) => String(i));
        const charge = measureStringItem(input[0]);
        const source = items(input);
        const next = vi.spyOn(source, "next");
        const { value: port } = serveWorkerPushStream({
            ...limits,
            createSource: () => source,
            batchTargetBytes: 2 * charge,
        });
        const messages = receive(port);
        const reader = readWorkerPushStream({ ...limits, port, initialCreditBytes: 4 * charge });
        try {
            await expect(reader.next()).resolves.toEqual({ done: false, value: ["0", "1"] });
            await vi.waitFor(() => expect(messages).toHaveLength(2));
            expect(messages).toEqual([batch(["0", "1"]), batch(["2", "3"])]);
            expect(next).toHaveBeenCalledTimes(4);

            await expect(reader.next()).resolves.toEqual({ done: false, value: ["2", "3"] });
            await vi.waitFor(() => expect(messages).toHaveLength(3));
            expect(messages[2]).toEqual(batch(["4", "5"]));
            expect(next).toHaveBeenCalledTimes(6);
            await expect(collect(reader).then((batches) => batches.flat())).resolves.toEqual(input.slice(4));
        } finally {
            await reader.return();
        }
    });

    it.each([80, 120])(
        "waits for all earlier credit before sending a staged %i-code-unit singleton",
        async (length) => {
            const { port1: producer } = captureChannel();
            const singleton = "s".repeat(length);
            const source = items(["", "", singleton, "later"]);
            const next = vi.spyOn(source, "next");
            const { value: port } = serveWorkerPushStream({
                ...limits,
                createSource: () => source,
                batchTargetBytes: ITEM_OVERHEAD_BYTES,
            });
            const producerMessages = receive(producer);
            const messages = receive(port);
            const initialCreditBytes = 4 * ITEM_OVERHEAD_BYTES;
            const reader = readWorkerPushStream({ ...limits, port, initialCreditBytes });
            try {
                await expect(reader.next()).resolves.toEqual({ done: false, value: [""] });
                await vi.waitFor(() => expect(next).toHaveBeenCalledTimes(3));
                expect(messages).toEqual([batch([""]), batch([""])]);

                await expect(reader.next()).resolves.toEqual({ done: false, value: [""] });
                // Wait until the producer has actually processed the first refund before asserting no premature send.
                await vi.waitFor(() => expect(producerMessages).toHaveLength(2));
                await new Promise<void>((resolve) => setTimeout(resolve, 0));
                expect(messages).toHaveLength(2);
                expect(next).toHaveBeenCalledTimes(3);
                await expect(reader.next()).resolves.toEqual({ done: false, value: [singleton] });
                expect(messages).toEqual([batch([""]), batch([""]), batch([singleton])]);
                if (measureStringItem(singleton) > initialCreditBytes) {
                    expect(next).toHaveBeenCalledTimes(3);
                }
                await expect(collect(reader)).resolves.toEqual([["later"]]);
            } finally {
                await reader.return();
            }
        }
    );

    it("flushes a partial batch while a single subsequent source read is still blocked", async () => {
        const reading = promiseWithResolvers<void>();
        const unblock = promiseWithResolvers<void>();
        const source = (async function* () {
            yield "first";
            reading.resolve();
            await unblock.promise;
            yield "second";
        })();
        const next = vi.spyOn(source, "next");
        const { value: port } = serveWorkerPushStream({ ...limits, createSource: () => source });
        const reader = readWorkerPushStream({ ...limits, port });
        try {
            await reading.promise;
            await expect(reader.next()).resolves.toEqual({ done: false, value: ["first"] });
            expect(next).toHaveBeenCalledTimes(2);
            unblock.resolve();
            await expect(collect(reader)).resolves.toEqual([["second"]]);
        } finally {
            unblock.resolve();
            await reader.return();
        }
    });

    it.each(["drain", "return", "throw"] as const)("can %s a FIFO after the remote end", async (action) => {
        const { value: port } = serveWorkerPushStream({
            ...limits,
            maxBatchItems: 1,
            createSource: () => items(["first", "second", "third"]),
        });
        const ended = promiseWithResolvers<void>();
        const controller = new AbortController();
        const reader = readWorkerPushStream({ ...limits, port, signal: controller.signal, onRemoteEnd: ended.resolve });
        await ended.promise;
        controller.abort(new RpcError("disconnected", "Worker disconnected after end"));
        await expect(reader.next()).resolves.toEqual({ done: false, value: ["first"] });
        if (action === "return") {
            await expect(reader.return()).resolves.toEqual({ done: true, value: undefined });
        } else if (action === "throw") {
            const error = new Error("consumer failed");
            await expect(reader.throw(error)).rejects.toBe(error);
        } else {
            await expect(collect(reader)).resolves.toEqual([["second"], ["third"]]);
        }
        await expect(reader.next()).resolves.toEqual({ done: true, value: undefined });
    });

    it.each(["return", "throw"] as const)("handles %s while next() is pending out of band", async (action) => {
        const { port1: producer, port2: port } = new MessageChannel();
        const messages = receive(producer);
        const reader = readWorkerPushStream({ ...limits, port });
        const pending = reader.next();
        if (action === "return") {
            await expect(reader.return()).resolves.toEqual({ done: true, value: undefined });
        } else {
            const error = new Error("stop");
            await expect(reader.throw(error)).rejects.toBe(error);
        }
        await expect(pending).resolves.toEqual({ done: true, value: undefined });
        await vi.waitFor(() =>
            expect(messages).toEqual([
                { version: 1, type: "credit", bytes: 512 * 1024 },
                { version: 1, type: "cancel" },
            ])
        );
        producer.close();
    });

    it("cancels an unclaimed port with zero credit and without creating a source", async () => {
        const { port1: producer } = captureChannel();
        const createSource = vi.fn(() => items(["unexpected"]));
        const { value: port } = serveWorkerPushStream({ ...limits, createSource });
        const closed = promiseWithResolvers<void>();
        producer.addEventListener("close", () => closed.resolve(), { once: true });
        const messages = receive(producer);
        cancelWorkerPushStream(port);
        await closed.promise;
        expect(messages).toEqual([{ version: 1, type: "cancel" }]);
        expect(createSource).not.toHaveBeenCalled();
    });

    it("expires a port left unclaimed", async () => {
        const createSource = vi.fn(() => items(["unexpected"]));
        const { value: port } = serveWorkerPushStream({ ...limits, createSource, claimTimeoutMs: 5 });
        try {
            await expect(nextMessage(port)).resolves.toMatchObject({ type: "error", error: { code: "timeout" } });
            expect(createSource).not.toHaveBeenCalled();
        } finally {
            port.close();
        }
    });

    it.each([
        null,
        { version: 2, type: "credit", bytes: 64 },
        { version: 1, type: "pull" },
        ...[0, -1, 0.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1].map((bytes) => ({
            version: 1,
            type: "credit",
            bytes,
        })),
        { version: 1, type: "cancel", error: { code: "aborted", message: 123 } },
    ])("rejects malformed reader messages (%j)", async (value) => {
        const createSource = vi.fn(() => items(["unexpected"]));
        const { value: port } = serveWorkerPushStream({ ...limits, createSource });
        try {
            const reply = nextMessage(port);
            port.postMessage(value);
            await expect(reply).resolves.toMatchObject({ type: "error", error: { code: "stream-protocol-error" } });
            expect(createSource).not.toHaveBeenCalled();
        } finally {
            port.close();
        }
    });

    it.each([
        null,
        { ...batch(["good"]), version: 2 },
        { version: 1, type: "credit", bytes: 64 },
        { version: 1, type: "error", error: { code: "not-a-code", message: "invalid" } },
        { ...batch([]), chargeBytes: 64 },
        { ...batch(["good"]), items: [12] },
        { ...batch(["good"]), items: new Array(1) },
        { ...batch(["good"]), chargeBytes: Infinity },
        { ...batch(["good"]), chargeBytes: 64.5 },
        { ...batch(["good"]), chargeBytes: 64 },
        { ...batch(["good"]), chargeBytes: 100 },
        batch(["x".repeat(limits.maxItemBytes / 2)]),
    ])("rejects malformed producer messages (%j)", async (value) => {
        const { port1: producer, port2: port } = new MessageChannel();
        const messages = receive(producer);
        const reader = readWorkerPushStream({ ...limits, port });
        try {
            const pending = reader.next();
            producer.postMessage(value);
            await expect(pending).rejects.toMatchObject({ code: "stream-protocol-error" });
            await vi.waitFor(() =>
                expect(messages[1]).toMatchObject({ type: "cancel", error: { code: "stream-protocol-error" } })
            );
        } finally {
            await reader.return();
            producer.close();
        }
    });

    it("rejects an oversized source item before posting any batch", async () => {
        const { value: port } = serveWorkerPushStream({
            ...limits,
            maxItemBytes: ITEM_OVERHEAD_BYTES,
            createSource: () => items(["too large"]),
        });
        const messages = receive(port);
        const reader = readWorkerPushStream({ ...limits, port });
        await expect(reader.next()).rejects.toMatchObject({ code: "stream-protocol-error" });
        expect(messages).toEqual([expect.objectContaining({ type: "error" })]);
    });

    it.each(["producer", "reader"] as const)("aborts the source on a messageerror at the %s", async (side) => {
        const { port1: producer } = captureChannel();
        const started = promiseWithResolvers<AbortSignal>();
        const cancelled = promiseWithResolvers<void>();
        const { value: port } = serveWorkerPushStream({
            ...limits,
            async *createSource(signal) {
                started.resolve(signal);
                try {
                    await new Promise<void>((resolve) =>
                        signal.addEventListener("abort", () => resolve(), { once: true })
                    );
                } finally {
                    cancelled.resolve();
                }
            },
        });
        const reader = readWorkerPushStream({ ...limits, port });
        const rejected = expect(reader.next()).rejects.toMatchObject({ code: "stream-protocol-error" });
        const signal = await started.promise;
        const endpoint = side === "producer" ? producer : port;
        endpoint.dispatchEvent(new Event("messageerror"));
        await rejected;
        await cancelled.promise;
        expect(signal.reason).toMatchObject({ code: "stream-protocol-error" });
    });

    it("retains structured error details even when Error properties cannot be cloned", async () => {
        const error = new RpcError("remote-error", "read failed", { remoteName: "NotReadableError" });
        Object.defineProperties(error, {
            stack: {
                get: () => {
                    throw new Error("stack unavailable");
                },
            },
            cause: { value: () => "not cloneable" },
        });
        const { value: port } = serveWorkerPushStream({
            ...limits,
            createSource: () => {
                throw error;
            },
        });
        const reader = readWorkerPushStream({ ...limits, port });
        await expect(reader.next()).rejects.toMatchObject({
            code: "remote-error",
            message: "read failed",
            remoteName: "NotReadableError",
        });
    });

    it("discards queued batches when the remote fails before ending", async () => {
        const { port1: producer, port2: port } = new MessageChannel();
        const failed = promiseWithResolvers<unknown>();
        const reader = readWorkerPushStream({ ...limits, port, onError: failed.resolve });
        try {
            producer.postMessage(batch(["first"]));
            producer.postMessage(batch(["queued"]));
            await expect(reader.next()).resolves.toEqual({ done: false, value: ["first"] });
            producer.postMessage({
                version: 1,
                type: "error",
                error: { code: "remote-error", message: "read failed" },
            });
            await expect(failed.promise).resolves.toMatchObject({ code: "remote-error" });
            await expect(reader.next()).rejects.toMatchObject({ message: "read failed" });
        } finally {
            await reader.return();
            producer.close();
        }
    });

    it("rejects a positive credit refund exceeding the outstanding charge", async () => {
        const { value: port } = serveWorkerPushStream({
            ...limits,
            maxBatchItems: 1,
            createSource: () => items(["one", "two"]),
        });
        try {
            const firstBatch = nextMessage(port);
            port.postMessage({ version: 1, type: "credit", bytes: measureStringItem("one") });
            await expect(firstBatch).resolves.toEqual(batch(["one"]));
            const reply = nextMessage(port);
            port.postMessage({ version: 1, type: "credit", bytes: measureStringItem("one") + 1 });
            await expect(reply).resolves.toMatchObject({ type: "error", error: { code: "stream-protocol-error" } });
        } finally {
            port.close();
        }
    });

    it("fails the reader when the producer port closes unexpectedly, even with a queued batch", async () => {
        const { port1: producer, port2: port } = new MessageChannel();
        const controller = new AbortController();
        const failed = promiseWithResolvers<unknown>();
        const removeSpy = vi.spyOn(controller.signal, "removeEventListener");
        const reader = readWorkerPushStream({ ...limits, port, signal: controller.signal, onError: failed.resolve });
        try {
            producer.postMessage(batch(["queued"]));
            await expect(reader.next()).resolves.toEqual({ done: false, value: ["queued"] });
            producer.postMessage(batch(["dropped"]));
            await new Promise<void>((resolve) => setTimeout(resolve, 0));
            producer.close();
            await expect(failed.promise).resolves.toMatchObject({ code: "disconnected" });
            await expect(reader.next()).rejects.toMatchObject({ code: "disconnected" });
            expect(removeSpy).toHaveBeenCalledWith("abort", expect.any(Function));
        } finally {
            await reader.return();
        }
    });

    it("aborts the producer source when the reader port closes unexpectedly after the first batch", async () => {
        const started = promiseWithResolvers<AbortSignal>();
        const aborted = promiseWithResolvers<void>();
        const controller = new AbortController();
        const removeSpy = vi.spyOn(controller.signal, "removeEventListener");
        const { value: port } = serveWorkerPushStream({
            ...limits,
            signal: controller.signal,
            maxBatchItems: 1,
            async *createSource(signal) {
                started.resolve(signal);
                try {
                    yield "first";
                    await new Promise<void>((resolve) =>
                        signal.addEventListener("abort", () => resolve(), { once: true })
                    );
                } finally {
                    aborted.resolve();
                }
            },
        });
        const firstBatch = nextMessage(port);
        port.postMessage({ version: 1, type: "credit", bytes: 2 * measureStringItem("first") });
        const signal = await started.promise;
        await expect(firstBatch).resolves.toEqual(batch(["first"]));
        port.close();
        await aborted.promise;
        expect(signal.aborted).toBe(true);
        expect(signal.reason).toMatchObject({ code: "disconnected" });
        expect(removeSpy).toHaveBeenCalledWith("abort", expect.any(Function));
    });

    it("still drains queued FIFO batches if the producer port closes after sending end", async () => {
        const { port1: producer, port2: port } = new MessageChannel();
        const ended = promiseWithResolvers<void>();
        const reader = readWorkerPushStream({ ...limits, port, onRemoteEnd: ended.resolve });
        try {
            producer.postMessage(batch(["first"]));
            producer.postMessage(batch(["second"]));
            producer.postMessage({ version: 1, type: "end" });
            producer.close();
            await ended.promise;
            await expect(collect(reader)).resolves.toEqual([["first"], ["second"]]);
        } finally {
            await reader.return();
        }
    });

    it("serialises transferred ASCII chunks using one byte per code unit in V8", async () => {
        const ascii = "abc0".repeat(8_000);
        const unicode = "漢".repeat(ascii.length);
        const input = [ascii, unicode];
        const { value: port } = serveWorkerPushStream({ ...limits, createSource: () => items(input) });
        const reader = readWorkerPushStream({ ...limits, port });
        const result = (await collect(reader)).flat();
        expect(result).toEqual(input);
        expect(serialize(result[0]).length).toBe(serialize(ascii).length);
        expect(serialize(result[0]).length).toBeLessThan(ascii.length + 16);
        expect(serialize(result[1]).length).toBeGreaterThanOrEqual(2 * unicode.length);
    });
});
