import { RpcError } from "@vrtmrz/rpc";
import { promiseWithResolvers } from "octagonal-wheels/promises";
import { describe, expect, it, vi } from "vitest";
import { serveWorkerPushStream } from "./WorkerPushStreamProducer.ts";
import { readWorkerPushStream } from "./WorkerPushStreamReader.ts";
import { batch, collect, items, limits, receive } from "./fixtures/workerPushStream.test.ts";

describe("Worker push stream reader", () => {
    it("ends a source that yields no items", async () => {
        const { value: port } = serveWorkerPushStream({ ...limits, createSource: () => items([]) });
        const onRemoteEnd = vi.fn();
        const reader = readWorkerPushStream({ ...limits, port, onRemoteEnd });
        await expect(reader.next()).resolves.toEqual({ done: true, value: undefined });
        expect(onRemoteEnd).toHaveBeenCalledTimes(1);
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
});
