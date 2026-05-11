import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => {
    const createdWorkers: Array<{
        onmessage: ((ev: any) => void) | null;
        onerror: ((ev: any) => void) | null;
        postMessage: ReturnType<typeof vi.fn>;
        terminate: ReturnType<typeof vi.fn>;
    }> = [];
    const abortSplitTasks = vi.fn();
    const handleTaskSplit = vi.fn();
    const handleTaskEncrypt = vi.fn();
    const workerFactory = vi.fn(() => {
        const worker = {
            onmessage: null,
            onerror: null,
            postMessage: vi.fn(),
            terminate: vi.fn(),
        };
        createdWorkers.push(worker);
        return worker;
    });
    return {
        createdWorkers,
        abortSplitTasks,
        handleTaskSplit,
        handleTaskEncrypt,
        workerFactory,
    };
});

vi.mock("./bg.worker.ts?worker&inline", () => ({
    default: hoisted.workerFactory,
}));

vi.mock("./bgWorker.splitting.ts", () => ({
    _splitPieces2Worker: vi.fn(),
    handleTaskSplit: hoisted.handleTaskSplit,
    abortSplitTasks: hoisted.abortSplitTasks,
}));

vi.mock("./bgWorker.encryption.ts", () => ({
    encryptionOnWorker: vi.fn(),
    encryptionHKDFOnWorker: vi.fn(),
    handleTaskEncrypt: hoisted.handleTaskEncrypt,
}));

describe("bgWorker", () => {
    beforeEach(() => {
        vi.resetModules();
        hoisted.createdWorkers.length = 0;
        hoisted.abortSplitTasks.mockReset();
        hoisted.handleTaskSplit.mockReset();
        hoisted.handleTaskEncrypt.mockReset();
        hoisted.workerFactory.mockClear();
    });

    afterEach(async () => {
        try {
            const bgWorker = await import("./bgWorker.ts");
            bgWorker.terminateWorker();
            bgWorker.tasks.clear();
        } catch {
            // no-op for module reset edge cases
        }
    });

    it("removeTask should be idempotent and clear the task map", async () => {
        const bgWorker = await import("./bgWorker.ts");
        bgWorker.initialiseWorkerModule();

        const process = bgWorker.startWorker({
            type: "encrypt",
            input: "x",
            passphrase: "p",
            autoCalculateIterations: false,
        });

        expect(bgWorker.tasks.has(process.key)).toBe(true);

        bgWorker.removeTask(process.key);
        expect(bgWorker.tasks.has(process.key)).toBe(false);

        expect(() => bgWorker.removeTask(process.key)).not.toThrow();
    });

    it("should abort split tasks and clear task entry when worker crashes", async () => {
        const bgWorker = await import("./bgWorker.ts");
        bgWorker.initialiseWorkerModule();

        const process = bgWorker.startWorker({
            type: "split",
            dataSrc: new Blob(["hello"]),
            pieceSize: 4,
            plainSplit: false,
            minimumChunkSize: 2,
            filename: "a.txt",
            splitVersion: 3,
            useSegmenter: false,
        });

        const assignedWorker = hoisted.createdWorkers.find((w) =>
            w.postMessage.mock.calls.some((c) => c[0]?.data?.key === process.key)
        );
        expect(assignedWorker).toBeDefined();

        assignedWorker!.onerror?.({ message: "boom" });

        expect(bgWorker.tasks.has(process.key)).toBe(false);
        expect(hoisted.abortSplitTasks).toHaveBeenCalledTimes(1);
        expect(hoisted.abortSplitTasks.mock.calls[0][0]).toEqual([process.key]);
        expect(hoisted.abortSplitTasks.mock.calls[0][1]).toBeInstanceOf(Error);
        expect(assignedWorker!.terminate).toHaveBeenCalledTimes(1);
    });

    it("should reject encryption task promise when worker crashes", async () => {
        const bgWorker = await import("./bgWorker.ts");
        bgWorker.initialiseWorkerModule();

        const process = bgWorker.startWorker({
            type: "encrypt",
            input: "x",
            passphrase: "p",
            autoCalculateIterations: false,
        });

        const assignedWorker = hoisted.createdWorkers.find((w) =>
            w.postMessage.mock.calls.some((c) => c[0]?.data?.key === process.key)
        );
        expect(assignedWorker).toBeDefined();

        assignedWorker!.onerror?.({ message: "boom" });

        await expect(process.task.promise).rejects.toThrow("Background worker crashed: boom");
        expect(bgWorker.tasks.has(process.key)).toBe(false);
    });
});
