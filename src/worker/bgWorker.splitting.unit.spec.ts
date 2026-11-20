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

async function expectNextSplit(): Promise<void> {
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
    expect(tasks.size).toBe(0);
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

    it.each(["return", "key cancellation"] as const)("stops a pending read on %s", async (action) => {
        initialiseWorkerModule(createLiveSyncEventHub());
        const { source, secondReadStarted, secondBlock, ranges } = holdSecondRead();
        const iterator = splitPieces2WorkerRabinKarp(source, blockBytes, false, blockBytes)();
        await expect(iterator.next()).resolves.toMatchObject({ done: false });
        const read = iterator.next();
        const stopped =
            action === "return"
                ? expect(read).resolves.toEqual({ done: true, value: undefined })
                : expect(read).rejects.toMatchObject({ code: "aborted" });
        await secondReadStarted.promise;

        if (action === "return") {
            await iterator.return();
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

    it("rejects the next read after a Worker crashes while the consumer holds a chunk", async () => {
        initialiseWorkerModule(createLiveSyncEventHub());
        const source = new Blob([new Uint8Array(blockBytes)]);
        const iterator = splitPieces2WorkerRabinKarp(source, blockBytes / 2, false, blockBytes / 2)();
        await expect(iterator.next()).resolves.toMatchObject({ done: false });
        const failedWorker = worker;
        failedWorker.crash("fixture split crash");
        expect(tasks.size).toBe(0);
        await expect(iterator.next()).rejects.toMatchObject({ code: "disconnected", message: "fixture split crash" });
        await expectNextSplit();
        expect(failedWorker.terminate).toHaveBeenCalledTimes(1);
        expect(inlineWorkerFactory).toHaveBeenCalledTimes(2);
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
        const cancelSent = promiseWithResolvers<void>();
        const postMessage = MessagePort.prototype.postMessage;
        vi.spyOn(MessagePort.prototype, "postMessage").mockImplementation(function (
            this: MessagePort,
            value,
            transfer
        ) {
            if (value?.type === "cancel") {
                cancelSent.resolve();
            }
            postMessage.call(this, value, transfer);
        });
        const { source, ranges } = holdSecondRead();
        const iterator = splitPieces2WorkerRabinKarp(source, blockBytes, false, blockBytes)();
        const read = iterator.next();
        const send = await heldRequest.promise;
        await iterator.return();
        await expect(read).resolves.toEqual({ done: true, value: undefined });
        send();
        await cancelSent.promise;
        expect(ranges).toEqual([]);
        await expectNextSplit();
    });
});
