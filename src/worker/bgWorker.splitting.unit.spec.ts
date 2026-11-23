import { promiseWithResolvers } from "octagonal-wheels/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLiveSyncEventHub } from "@lib/hub/hub";
import {
    cancelSplitTask,
    initialiseWorkerModule,
    splitPieces2WorkerRabinKarp,
    tasks,
    terminateWorker,
} from "./bgWorker.ts";
import { createSplitOperation } from "./bgWorker.splitting.ts";
import { LoopbackWorker } from "./fixtures/LoopbackWorker.test.ts";

const inlineWorkerFactory = vi.hoisted(() => vi.fn<() => LoopbackWorker>());
vi.mock("./bg.worker.ts?worker&inline", () => ({ default: inlineWorkerFactory }));

const blockBytes = 1024 * 1024;
const fixtureType = "application/x-worker-fixture";

function holdSecondRead() {
    const source = new Blob([new Uint8Array(3 * blockBytes)], { type: fixtureType });
    const secondReadStarted = promiseWithResolvers<void>();
    const secondBlock = promiseWithResolvers<ArrayBuffer>();
    const ranges: [number, number][] = [];
    const slice = Blob.prototype.slice;
    vi.spyOn(Blob.prototype, "slice").mockImplementation(function (this: Blob, start, end, contentType) {
        const range = slice.call(this, start, end, contentType);
        if (this.type === fixtureType) {
            ranges.push([start, end]);
            if (start === blockBytes) {
                vi.spyOn(range, "arrayBuffer").mockImplementation(() => {
                    secondReadStarted.resolve();
                    return secondBlock.promise;
                });
            }
        }
        return range;
    });
    return { source, secondReadStarted, secondBlock, ranges };
}

function observeSplitWire() {
    const firstBatch = promiseWithResolvers<void>();
    const twoBatches = promiseWithResolvers<void>();
    const ended = promiseWithResolvers<void>();
    const cancelSent = promiseWithResolvers<void>();
    const batches: { items: string[]; chargeBytes: number }[] = [];
    const readerMessages: unknown[] = [];
    const postMessage = MessagePort.prototype.postMessage;
    vi.spyOn(MessagePort.prototype, "postMessage").mockImplementation(function (this: MessagePort, data, transfer) {
        if (data?.version === 1 && data.type === "credit" && readerMessages.length === 0) {
            this.addEventListener("message", ({ data: reply }) => {
                if (reply.type === "batch") {
                    batches.push(reply);
                    firstBatch.resolve();
                    if (batches.length === 2) {
                        twoBatches.resolve();
                    }
                } else if (reply.type === "end") {
                    ended.resolve();
                }
            });
        }
        if (data?.version === 1 && (data.type === "credit" || data.type === "cancel")) {
            readerMessages.push(data);
            if (data.type === "cancel") {
                cancelSent.resolve();
            }
        }
        postMessage.call(this, data, transfer);
    });
    return {
        batches,
        readerMessages,
        firstBatchReceived: firstBatch.promise,
        twoBatchesReceived: twoBatches.promise,
        ended: ended.promise,
        cancelSent: cancelSent.promise,
    };
}

async function expectNextSplit(activeTasks = 0): Promise<void> {
    const next = splitPieces2WorkerRabinKarp(
        new Blob(["next split"], { type: "text/plain" }),
        blockBytes,
        true,
        blockBytes
    )();
    const chunks = [];
    for await (const chunk of next) {
        chunks.push(chunk);
    }
    expect(chunks).toEqual(["next split"]);
    expect(tasks.size).toBe(activeTasks);
}

describe("Rabin–Karp background Worker splitting", () => {
    let worker: LoopbackWorker;

    beforeEach(() => {
        vi.stubGlobal("navigator", { hardwareConcurrency: 2 });
        inlineWorkerFactory.mockImplementation(() => (worker = new LoopbackWorker(true)));
    });

    afterEach(() => {
        terminateWorker();
        inlineWorkerFactory.mockReset();
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
    });

    it.each([
        { stack: { value: () => "non-cloneable" }, name: "RangeError", message: "Could not read input" },
        {
            stack: {
                get() {
                    throw new Error("Could not read stack");
                },
            },
            name: "Error",
            message: "Background splitting failed",
        },
    ])("reports an error with an unusable stack", async ({ stack, name, message }) => {
        initialiseWorkerModule(createLiveSyncEventHub());
        const error = new RangeError("Could not read input");
        Object.defineProperty(error, "stack", stack);
        if (stack.get) {
            Object.defineProperties(error, { name: { value: Symbol() }, message: { value: 42 } });
        }
        const read = Blob.prototype.arrayBuffer;
        vi.spyOn(Blob.prototype, "arrayBuffer").mockImplementation(function (this: Blob) {
            return this.type === fixtureType ? Promise.reject(error) : read.call(this);
        });
        const source = new Blob([new Uint8Array(16)], { type: fixtureType });

        const iterator = splitPieces2WorkerRabinKarp(source, 16, false, 16)();
        await expect(iterator.next()).rejects.toMatchObject({ name, message });
        expect(tasks.size).toBe(0);
    });

    it("rejects a pending read when a later range fails, then reuses the same Worker", async () => {
        initialiseWorkerModule(createLiveSyncEventHub());
        const { source, secondReadStarted, secondBlock } = holdSecondRead();
        const iterator = splitPieces2WorkerRabinKarp(source, blockBytes, false, blockBytes)();
        await expect(iterator.next()).resolves.toMatchObject({ done: false });
        expect(tasks.size).toBe(1);
        const read = iterator.next();
        const error = new DOMException("Could not read second range", "NotReadableError");
        const failed = expect(read).rejects.toMatchObject({ name: error.name, message: error.message });
        await secondReadStarted.promise;
        secondBlock.reject(error);

        await failed;
        await expectNextSplit();
        expect(worker.terminate).not.toHaveBeenCalled();
    });

    it.each(["return", "throw", "key cancellation"] as const)("stops a pending read on %s", async (action) => {
        initialiseWorkerModule(createLiveSyncEventHub());
        const { source, secondReadStarted, secondBlock, ranges } = holdSecondRead();
        const iterator = splitPieces2WorkerRabinKarp(source, blockBytes, false, blockBytes)();
        await expect(iterator.next()).resolves.toMatchObject({ done: false });
        const read = iterator.next();
        const stopped =
            action === "key cancellation"
                ? expect(read).rejects.toMatchObject({ code: "aborted" })
                : expect(read).resolves.toEqual({ done: true, value: undefined });
        await secondReadStarted.promise;

        if (action === "return") {
            await iterator.return();
        } else if (action === "throw") {
            const error = new Error("consumer failure");
            await expect(iterator.throw(error)).rejects.toBe(error);
        } else {
            const [key] = tasks.keys();
            cancelSplitTask(key);
            cancelSplitTask(key);
        }
        await stopped;
        await expectNextSplit();
        secondBlock.resolve(new ArrayBuffer(blockBytes));
        expect(ranges).toEqual([
            [0, blockBytes],
            [blockBytes, 2 * blockBytes],
        ]);
        expect(worker.terminate).not.toHaveBeenCalled();
    });

    it("discards queued batches on a Worker crash and replaces the failed slot", async () => {
        initialiseWorkerModule(createLiveSyncEventHub());
        const wire = observeSplitWire();
        const pieceSize = 32 * 1024;
        const source = new Blob([new Uint8Array(16 * pieceSize)]);
        const iterator = splitPieces2WorkerRabinKarp(source, pieceSize, false, pieceSize)();

        await expect(iterator.next()).resolves.toMatchObject({ done: false });
        await wire.twoBatchesReceived;
        const failedWorker = worker;
        failedWorker.crash("fixture split crash");
        expect(tasks.size).toBe(0);
        await expect(iterator.next()).rejects.toMatchObject({
            code: "disconnected",
            message: "fixture split crash",
        });
        await expectNextSplit();
        expect(failedWorker.terminate).toHaveBeenCalledTimes(1);
        expect(inlineWorkerFactory).toHaveBeenCalledTimes(2);
    });

    it.each(["drain", "return", "key cancellation"] as const)("can %s after remote end", async (action) => {
        initialiseWorkerModule(createLiveSyncEventHub());
        const wire = observeSplitWire();
        const pieceSize = 32 * 1024;
        const source = new Blob([new Uint8Array(4 * pieceSize)]);
        const iterator = splitPieces2WorkerRabinKarp(source, pieceSize, false, pieceSize)();

        const first = await iterator.next();
        expect(first.done).toBe(false);
        await wire.ended;
        expect(tasks.size).toBe(1);
        await expectNextSplit(1);

        if (action === "key cancellation") {
            const [key] = tasks.keys();
            cancelSplitTask(key);
            await expect(iterator.next()).rejects.toMatchObject({ code: "aborted" });
        } else if (action === "return") {
            await expect(iterator.return()).resolves.toMatchObject({ done: true });
        } else {
            worker.crash("Worker ended after delivering the full split");
            const chunks = [];
            for await (const chunk of iterator) {
                chunks.push(chunk);
            }
            expect(chunks).toHaveLength(3);
            expect(chunks.join("")).toBe(String(first.value).repeat(3));
        }
        await expect(iterator.next()).resolves.toMatchObject({ done: true });
        expect(tasks.size).toBe(0);
    });

    it("dispatches the next queued split at remote end while the first iterator still has buffered chunks", async () => {
        initialiseWorkerModule(createLiveSyncEventHub());
        await worker.ready;
        const forward = worker.postMessage.getMockImplementation()!;
        const heldRequest = promiseWithResolvers<() => void>();
        worker.postMessage.mockImplementationOnce((data, transfer) => {
            heldRequest.resolve(() => forward(data, transfer));
        });
        const wire = observeSplitWire();
        const pieceSize = 32 * 1024;
        const payload = "a".repeat(4 * pieceSize);
        const first = splitPieces2WorkerRabinKarp(
            new Blob([payload], { type: "text/plain" }),
            pieceSize,
            true,
            pieceSize
        )();
        const firstRead = first.next();
        const send = await heldRequest.promise;
        const second = splitPieces2WorkerRabinKarp(
            new Blob(["second"], { type: "text/plain" }),
            pieceSize,
            true,
            pieceSize
        )();
        const secondRead = second.next();
        try {
            await new Promise(setImmediate);
            expect(worker.postMessage).toHaveBeenCalledTimes(1);

            send();
            const firstChunk = await firstRead;
            expect(firstChunk.done).toBe(false);
            await wire.ended;
            await expect(secondRead).resolves.toEqual({ done: false, value: "second" });
            expect(worker.postMessage).toHaveBeenCalledTimes(2);
            expect(tasks.size).toBe(2);

            const buffered = [];
            for await (const chunk of first) {
                buffered.push(chunk);
            }
            expect(buffered.length).toBeGreaterThan(0);
            expect([firstChunk.value, ...buffered].join("")).toBe(payload);
        } finally {
            await first.return();
            await second.return();
        }
    });

    it.each(["return", "throw", "key cancellation"] as const)("removes a queued split on %s", async (action) => {
        initialiseWorkerModule(createLiveSyncEventHub());
        await worker.ready;
        worker.postMessage.mockImplementationOnce(() => undefined);
        const first = splitPieces2WorkerRabinKarp(new Blob(["first"]), blockBytes, true, blockBytes)();
        const firstRead = first.next();
        await vi.waitFor(() => expect(worker.postMessage).toHaveBeenCalledTimes(1));
        const second = splitPieces2WorkerRabinKarp(new Blob(["cancelled"]), blockBytes, true, blockBytes)();
        const secondRead = second.next();
        const key = [...tasks.keys()].at(-1)!;
        try {
            await new Promise(setImmediate);
            expect(worker.postMessage).toHaveBeenCalledTimes(1);
            const cancelled =
                action === "key cancellation"
                    ? expect(secondRead).rejects.toMatchObject({ code: "aborted" })
                    : expect(secondRead).resolves.toMatchObject({ done: true });
            if (action === "return") {
                await second.return();
            } else if (action === "throw") {
                const error = new Error("consumer failure");
                await expect(second.throw(error)).rejects.toBe(error);
            } else {
                cancelSplitTask(key);
            }
            await cancelled;
            expect(tasks.has(key)).toBe(false);

            const third = expectNextSplit();
            await first.return();
            await third;
            expect(worker.postMessage).toHaveBeenCalledTimes(2);
        } finally {
            await first.return();
            await second.return();
            await Promise.allSettled([firstRead, secondRead]);
        }
    });

    it("rejects queued splits on shutdown without sending them to the replacement pool", async () => {
        initialiseWorkerModule(createLiveSyncEventHub());
        await worker.ready;
        const originalWorker = worker;
        originalWorker.deliverRequests = false;
        const first = splitPieces2WorkerRabinKarp(new Blob(["first"]), blockBytes, true, blockBytes)();
        const second = splitPieces2WorkerRabinKarp(new Blob(["queued"]), blockBytes, true, blockBytes)();
        const disconnected = { code: "disconnected", message: "The background Worker pool has shut down." };
        const reads = [first.next(), second.next()];
        const rejected = reads.map((read) => expect(read).rejects.toMatchObject(disconnected));
        try {
            await new Promise(setImmediate);
            expect(originalWorker.postMessage).toHaveBeenCalledTimes(1);

            initialiseWorkerModule(createLiveSyncEventHub());
            await Promise.all(rejected);
            expect(originalWorker.postMessage).toHaveBeenCalledTimes(1);
            expect(tasks.size).toBe(0);
            await expectNextSplit();
            expect(worker.postMessage).toHaveBeenCalledTimes(1);
        } finally {
            terminateWorker();
            await Promise.allSettled(rejected);
        }
    });

    it("refunds a batch only after the last of its flattened chunks", async () => {
        initialiseWorkerModule(createLiveSyncEventHub());
        const wire = observeSplitWire();
        const pieceSize = 4 * 1024;
        const source = new Blob(["x".repeat(512 * 1024)], { type: "text/plain" });
        const iterator = splitPieces2WorkerRabinKarp(source, pieceSize, true, pieceSize)();
        try {
            await expect(iterator.next()).resolves.toMatchObject({ done: false });
            await wire.firstBatchReceived;
            const firstCount = wire.batches[0].items.length;
            expect(firstCount).toBeGreaterThan(1);
            for (let i = 1; i < firstCount; i++) {
                await expect(iterator.next()).resolves.toMatchObject({ done: false });
            }
            expect(wire.readerMessages).toEqual([{ version: 1, type: "credit", bytes: 512 * 1024 }]);

            await expect(iterator.next()).resolves.toMatchObject({ done: false });
            expect(wire.readerMessages[1]).toEqual({
                version: 1,
                type: "credit",
                bytes: wire.batches[0].chargeBytes,
            });
        } finally {
            await iterator.return();
        }
    });

    it("can exit between pulls and independently reuse the same factory", async () => {
        initialiseWorkerModule(createLiveSyncEventHub());
        const { source, ranges } = holdSecondRead();
        const factory = splitPieces2WorkerRabinKarp(source, blockBytes, false, blockBytes);
        for await (const chunk of factory()) {
            expect(chunk).toHaveLength(4 * Math.ceil(blockBytes / 3));
            expect(ranges).toEqual([[0, blockBytes]]);
            break;
        }
        expect(tasks.size).toBe(0);
        const second = factory();
        await expect(second.next()).resolves.toMatchObject({ done: false });
        expect(ranges).toEqual([
            [0, blockBytes],
            [0, blockBytes],
        ]);
        await second.return();
        await expectNextSplit();
    });

    it("does not dispatch a split when returned before the first read", async () => {
        initialiseWorkerModule(createLiveSyncEventHub());
        const source = new Blob([new Uint8Array(blockBytes)]);
        const iterator = splitPieces2WorkerRabinKarp(source, blockBytes, false, blockBytes)();

        await expect(iterator.return()).resolves.toEqual({ done: true, value: undefined });
        expect(worker.postMessage).not.toHaveBeenCalled();
        expect(tasks.size).toBe(0);
    });

    it("can return before Worker readiness and leaves the slot available for a later call", async () => {
        inlineWorkerFactory.mockImplementation(() => (worker = new LoopbackWorker(false)));
        initialiseWorkerModule(createLiveSyncEventHub());
        const source = new Blob([new Uint8Array(blockBytes)]);
        const iterator = splitPieces2WorkerRabinKarp(source, blockBytes, false, blockBytes)();
        const read = iterator.next();
        await expect(iterator.return()).resolves.toEqual({ done: true, value: undefined });
        await expect(read).resolves.toEqual({ done: true, value: undefined });
        worker.start();
        await worker.ready;
        expect(worker.postMessage).not.toHaveBeenCalled();
        await expectNextSplit();
    });

    it("closes a stream port that arrives after the consumer has returned", async () => {
        initialiseWorkerModule(createLiveSyncEventHub());
        await worker.ready;
        const forward = worker.postMessage.getMockImplementation()!;
        const heldRequest = promiseWithResolvers<() => void>();
        worker.postMessage.mockImplementationOnce((data, transfer) => {
            heldRequest.resolve(() => forward(data, transfer));
        });
        const wire = observeSplitWire();
        const { source, ranges } = holdSecondRead();
        const iterator = splitPieces2WorkerRabinKarp(source, blockBytes, false, blockBytes)();
        const read = iterator.next();
        const send = await heldRequest.promise;
        await iterator.return();
        await expect(read).resolves.toEqual({ done: true, value: undefined });
        send();
        await wire.cancelSent;
        expect(wire.readerMessages).toEqual([{ version: 1, type: "cancel" }]);
        expect(ranges).toEqual([]);
        await expectNextSplit();
    });

    it("releases an acquired pool lease before a late stream port arrives", async () => {
        const { port1: producer, port2: port } = new MessageChannel();
        const latePort = promiseWithResolvers<MessagePort>();
        const splitCalled = promiseWithResolvers<void>();
        const release = vi.fn();
        const releaseSplitSlot = vi.fn();
        const controller = new AbortController();
        const cancelReceived = promiseWithResolvers<unknown>();
        producer.addEventListener("message", ({ data }) => cancelReceived.resolve(data), { once: true });
        producer.start();
        try {
            const operation = createSplitOperation(
                () => ({
                    acquireSplitSlot: async () => releaseSplitSlot,
                    acquire: async () => ({
                        connection: { signal: controller.signal } as never,
                        client: {
                            call: {
                                split: () => {
                                    splitCalled.resolve();
                                    return latePort.promise;
                                },
                            },
                        } as never,
                        release,
                    }),
                }),
                {
                    dataSrc: new Blob(["abc"], { type: "text/plain" }),
                    pieceSize: 16,
                    plainSplit: true,
                    minimumChunkSize: 1,
                    splitVersion: 3,
                    useSegmenter: false,
                },
                () => undefined
            );
            const pending = operation.iterator.next();
            await splitCalled.promise;
            await expect(operation.iterator.return()).resolves.toEqual({ done: true, value: undefined });
            await expect(pending).resolves.toEqual({ done: true, value: undefined });
            expect(release).toHaveBeenCalledTimes(1);
            expect(releaseSplitSlot).toHaveBeenCalledTimes(1);

            latePort.resolve(port);
            await expect(cancelReceived.promise).resolves.toEqual({ version: 1, type: "cancel" });
            expect(release).toHaveBeenCalledTimes(1);
            expect(releaseSplitSlot).toHaveBeenCalledTimes(1);
        } finally {
            producer.close();
        }
    });

    it("clears split cancellation entries on terminateWorker while letting a remotely ended FIFO drain", async () => {
        initialiseWorkerModule(createLiveSyncEventHub());
        const wire = observeSplitWire();
        const pieceSize = 32 * 1024;
        const payload = "a".repeat(128 * 1024);
        const source = new Blob([payload], { type: "text/plain" });
        const iterator = splitPieces2WorkerRabinKarp(source, pieceSize, true, pieceSize)();
        const first = await iterator.next();
        expect(first.done).toBe(false);
        await wire.ended;
        const [oldKey] = tasks.keys();
        expect(oldKey).toBeDefined();

        terminateWorker();
        expect(tasks.size).toBe(0);
        // Old cancellation registration must be cleared by terminateWorker().
        cancelSplitTask(oldKey);

        const remaining = [];
        for await (const chunk of iterator) {
            remaining.push(chunk);
        }
        expect([first.value, ...remaining].join("")).toBe(payload);
    });
});
