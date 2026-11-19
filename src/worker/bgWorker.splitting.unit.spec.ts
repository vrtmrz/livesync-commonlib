import { promiseWithResolvers } from "octagonal-wheels/promises.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLiveSyncEventHub } from "@lib/hub/hub";
import { processSplit } from "./bg.worker.splitting.ts";
import { initialiseWorkerModule, removeTask, splitPieces2WorkerRabinKarp, tasks, terminateWorker } from "./bgWorker.ts";
import type { ResultPayloadWithSeq, SplitArguments } from "./universalTypes.ts";

const { worker } = vi.hoisted(() => ({
    worker: {
        onmessage: null as ((event: MessageEvent<ResultPayloadWithSeq>) => void) | null,
        postMessage: vi.fn<(message: { data: SplitArguments }) => Promise<void>>(),
        terminate: vi.fn(),
    },
}));

vi.mock("./bg.worker.ts?worker&inline", () => ({ default: () => worker }));

describe("Rabin–Karp worker splitting failures", () => {
    beforeEach(() => {
        vi.stubGlobal("navigator", { hardwareConcurrency: 2 });
        vi.stubGlobal("self", {
            postMessage(data: ResultPayloadWithSeq) {
                worker.onmessage?.(new MessageEvent("message", { data: structuredClone(data) }));
            },
        });
        worker.terminate.mockClear();
        worker.postMessage.mockReset();
        worker.postMessage.mockImplementation(({ data }) => Promise.resolve().then(() => processSplit(data)));
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
        const failedKey = worker.postMessage.mock.calls[0][0].data.key;
        expect(tasks.has(failedKey)).toBe(true);
        const first = await iterator.next();
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
});
