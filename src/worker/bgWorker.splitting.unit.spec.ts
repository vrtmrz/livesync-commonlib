import { promiseWithResolvers } from "octagonal-wheels/promises.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLiveSyncEventHub } from "@lib/hub/hub";
import { initialiseWorkerModule, removeTask, splitPieces2WorkerRabinKarp, tasks, terminateWorker } from "./bgWorker.ts";
import type { CancelSplitArguments, ResultPayloadWithSeq, SplitArguments } from "./universalTypes.ts";

const { worker } = vi.hoisted(() => ({
    worker: {
        onmessage: null as ((event: MessageEvent<ResultPayloadWithSeq>) => void) | null,
        postMessage: vi.fn<(message: { data: SplitArguments | CancelSplitArguments }) => Promise<void>>(),
        terminate: vi.fn(),
    },
}));

vi.mock("./bg.worker.ts?worker&inline", () => ({ default: () => worker }));

const workerScope = {
    onmessage: undefined as
        | ((event: MessageEvent<{ data: SplitArguments | CancelSplitArguments }>) => Promise<void> | void)
        | undefined,
    postMessage(data: ResultPayloadWithSeq) {
        worker.onmessage?.(new MessageEvent("message", { data: structuredClone(data) }));
    },
};

describe("Rabin–Karp worker splitting failures", () => {
    beforeEach(async () => {
        vi.stubGlobal("navigator", { hardwareConcurrency: 2 });
        vi.stubGlobal("self", workerScope);
        await import("./bg.worker.ts");
        worker.terminate.mockClear();
        worker.postMessage.mockReset();
        worker.postMessage.mockImplementation(async (message) => {
            await Promise.resolve();
            await workerScope.onmessage!(new MessageEvent("message", { data: message }));
        });
        initialiseWorkerModule(createLiveSyncEventHub());
    });

    afterEach(() => {
        terminateWorker();
        for (const key of tasks.keys()) {
            removeTask(key);
        }
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    const blockBytes = 1024 * 1024;
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
        const error = new RangeError("Could not read input");
        Object.defineProperty(error, "stack", stack);
        if (stack.get) {
            Object.defineProperties(error, { name: { value: Symbol() }, message: { value: 42 } });
        }
        const source = new Blob([new Uint8Array(16)]);
        vi.spyOn(source, "arrayBuffer").mockRejectedValue(error);

        const iterator = splitPieces2WorkerRabinKarp(source, 16, false, 16)();
        await expect(iterator.next()).rejects.toMatchObject({ name, message });
        await expect(worker.postMessage.mock.results[0].value).resolves.toBeUndefined();
        expect(tasks.size).toBe(0);
    });

    it.each([
        { state: "with a pending read", pieceSize: blockBytes, readPending: true },
        { state: "with an unread chunk", pieceSize: blockBytes / 2, readPending: false },
    ])("rejects and clears a failed split $state, then reuses the worker", async ({ pieceSize, readPending }) => {
        const secondReadStarted = promiseWithResolvers<void>();
        const secondBlock = promiseWithResolvers<ArrayBuffer>();
        const source = new Blob([new Uint8Array(blockBytes + 1)]);
        const slice = source.slice.bind(source);
        vi.spyOn(source, "slice").mockImplementation((start, end) => {
            const range = slice(start, end);
            if (start === blockBytes) {
                vi.spyOn(range, "arrayBuffer").mockImplementation(() => {
                    secondReadStarted.resolve();
                    return secondBlock.promise;
                });
            }
            return range;
        });

        const iterator = splitPieces2WorkerRabinKarp(source, pieceSize, false, pieceSize)();
        const firstRead = iterator.next();
        const failedKey = worker.postMessage.mock.calls[0][0].data.key;
        expect(tasks.has(failedKey)).toBe(true);
        const first = await firstRead;
        expect(first.done).toBe(false);
        expect(first.value).toHaveLength(4 * Math.ceil(pieceSize / 3));

        await secondReadStarted.promise;
        const error = new DOMException("Could not read second range", "NotReadableError");
        const expectReadFailure = () =>
            expect(iterator.next()).rejects.toMatchObject({ name: error.name, message: error.message });
        const pendingFailure = readPending ? expectReadFailure() : undefined;
        secondBlock.reject(error);

        const workerRun = worker.postMessage.mock.results[0].value;
        await Promise.all([expect(workerRun).resolves.toBeUndefined(), pendingFailure]);
        expect(tasks.has(failedKey)).toBe(false);
        if (!readPending) {
            await expectReadFailure();
        }

        const nextSource = new Blob(["next split"], { type: "text/plain" });
        const next = splitPieces2WorkerRabinKarp(nextSource, pieceSize, true, pieceSize)();
        await expect(next.next()).resolves.toEqual({ done: false, value: "next split" });
        await expect(next.next()).resolves.toEqual({ done: true, value: undefined });
        expect(worker.postMessage).toHaveBeenCalledTimes(2);
        expect(worker.terminate).not.toHaveBeenCalled();
        expect(tasks.size).toBe(0);
    });

    it("stops further range reads and ignores in-flight chunks after the consumer returns", async () => {
        const secondReadStarted = promiseWithResolvers<void>();
        const secondBlock = promiseWithResolvers<ArrayBuffer>();
        const source = new Blob([new Uint8Array(3 * blockBytes)]);
        const slice = source.slice.bind(source);
        const sliceSpy = vi.spyOn(source, "slice").mockImplementation((start, end) => {
            const range = slice(start, end);
            if (start === blockBytes) {
                vi.spyOn(range, "arrayBuffer").mockImplementation(() => {
                    secondReadStarted.resolve();
                    return secondBlock.promise;
                });
            }
            return range;
        });
        const logError = vi.spyOn(console, "error").mockImplementation(() => {});
        const iterator = splitPieces2WorkerRabinKarp(source, blockBytes, false, blockBytes)();

        expect((await iterator.next()).done).toBe(false);
        await secondReadStarted.promise;
        const key = worker.postMessage.mock.calls[0][0].data.key;
        const workerRun = worker.postMessage.mock.results[0].value;
        await iterator.return();
        worker.onmessage?.(new MessageEvent("message", { data: { key, seq: 1, result: "queued chunk" } }));
        secondBlock.resolve(new ArrayBuffer(blockBytes));
        await workerRun;

        expect.soft(sliceSpy.mock.calls).toEqual([
            [0, blockBytes],
            [blockBytes, 2 * blockBytes],
        ]);
        expect.soft(logError).not.toHaveBeenCalled();
        expect(tasks.size).toBe(0);
    });

    it("reuses the worker after a consumer exits while a write is blocked", async () => {
        const secondWriteStarted = promiseWithResolvers<void>();
        const write = WritableStreamDefaultWriter.prototype.write;
        let writes = 0;
        const writeSpy = vi.spyOn(WritableStreamDefaultWriter.prototype, "write").mockImplementation(function (
            this: WritableStreamDefaultWriter<string | null>,
            chunk: string | null
        ) {
            const pendingWrite = write.call(this, chunk);
            if (++writes === 2) {
                secondWriteStarted.resolve();
            }
            return pendingWrite;
        });

        const pieceSize = blockBytes / 2;
        const source = new Blob([new Uint8Array(blockBytes)]);
        const iterator = splitPieces2WorkerRabinKarp(source, pieceSize, false, pieceSize)();
        for await (const chunk of iterator) {
            expect(chunk).toHaveLength(4 * Math.ceil(pieceSize / 3));
            await secondWriteStarted.promise;
            expect(typeof writeSpy.mock.calls[1][0]).toBe("string");
            break;
        }

        const key = worker.postMessage.mock.calls[0][0].data.key;
        expect(tasks.has(key)).toBe(false);

        const nextSource = new Blob(["next split"], { type: "text/plain" });
        const next = splitPieces2WorkerRabinKarp(nextSource, pieceSize, true, pieceSize)();
        await expect(next.next()).resolves.toEqual({ done: false, value: "next split" });
        await expect(next.next()).resolves.toEqual({ done: true, value: undefined });
        expect(tasks.size).toBe(0);
        expect(worker.terminate).not.toHaveBeenCalled();
    });

    it("does not dispatch a split or acquire a writer when returned before the first read", async () => {
        const getWriter = vi.spyOn(WritableStream.prototype, "getWriter");
        const source = new Blob([new Uint8Array(blockBytes)]);
        const iterator = splitPieces2WorkerRabinKarp(source, blockBytes, false, blockBytes)();

        await expect(iterator.return()).resolves.toEqual({ done: true, value: undefined });
        expect.soft(worker.postMessage).not.toHaveBeenCalled();
        expect.soft(getWriter).not.toHaveBeenCalled();
        expect(tasks.size).toBe(0);
    });
});
