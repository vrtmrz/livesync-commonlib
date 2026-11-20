import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decrypt, encrypt } from "octagonal-wheels/encryption";
import { decrypt as decryptHKDF, encrypt as encryptHKDF } from "octagonal-wheels/encryption/hkdf";
import { createLiveSyncEventHub } from "@lib/hub/hub";
import { EVENT_PLATFORM_UNLOADED } from "@lib/events/coreEvents";
import * as bgWorker from "./bgWorker.ts";
import { LoopbackWorker } from "./fixtures/LoopbackWorker.test.ts";

const inlineWorkerFactory = vi.hoisted(() => vi.fn<() => LoopbackWorker>());
vi.mock("./bg.worker.ts?worker&inline", () => ({ default: inlineWorkerFactory }));

const workers: LoopbackWorker[] = [];
const secret = "fixture passphrase";
const input = "Sample note 漢🙂";

function createWorker(start = true): LoopbackWorker {
    const worker = new LoopbackWorker(start);
    workers.push(worker);
    return worker;
}

describe("browser background Worker", () => {
    beforeEach(() => {
        vi.stubGlobal("navigator", { hardwareConcurrency: 2 });
        inlineWorkerFactory.mockImplementation(() => createWorker());
    });

    afterEach(() => {
        bgWorker.terminateWorker();
        workers.length = 0;
        inlineWorkerFactory.mockReset();
        vi.unstubAllGlobals();
    });

    it("returns a task immediately and makes removeTask idempotent", async () => {
        bgWorker.initialiseWorkerModule(createLiveSyncEventHub());
        const process = bgWorker.startWorker({
            type: "encrypt",
            input,
            passphrase: secret,
            autoCalculateIterations: false,
        });

        expect(bgWorker.tasks.get(process.key)).toBe(process);
        bgWorker.removeTask(process.key);
        expect(bgWorker.tasks.has(process.key)).toBe(false);
        expect(() => bgWorker.removeTask(process.key)).not.toThrow();
        await expect(decrypt(await process.task.promise, secret, false)).resolves.toBe(input);
        process.finalize();
        process.finalize();
    });

    it("drains a low-level split and exposes its completion through the task handle", async () => {
        bgWorker.initialiseWorkerModule(createLiveSyncEventHub());
        const process = bgWorker.startWorker({
            type: "split",
            dataSrc: new Blob([input], { type: "text/plain" }),
            pieceSize: 100,
            plainSplit: true,
            minimumChunkSize: 1,
            splitVersion: 3,
            useSegmenter: false,
        });
        expect(bgWorker.tasks.get(process.key)).toBe(process);
        await vi.waitFor(() => expect(process.workerFinished).toBe(true));
        expect(bgWorker.tasks.has(process.key)).toBe(false);
    });

    it("terminates workers only when the supplied event hub unloads and supports reinitialisation", async () => {
        const events = createLiveSyncEventHub();
        const unrelatedEvents = createLiveSyncEventHub();
        bgWorker.initialiseWorkerModule(events);
        expect(workers).toHaveLength(1);
        const [worker] = workers;

        unrelatedEvents.emitEvent(EVENT_PLATFORM_UNLOADED);
        expect(worker.terminate).not.toHaveBeenCalled();
        events.emitEvent(EVENT_PLATFORM_UNLOADED);
        expect(worker.terminate).toHaveBeenCalledTimes(1);

        bgWorker.initialiseWorkerModule(unrelatedEvents);
        events.emitEvent(EVENT_PLATFORM_UNLOADED);
        await expect(bgWorker.decryptWorker(await encrypt(input, secret, false), secret, false)).resolves.toBe(input);
        expect(workers).toHaveLength(2);
    });

    it.each(["crash", "unload"] as const)("rejects pending encryption on %s", async (failure) => {
        const events = createLiveSyncEventHub();
        bgWorker.initialiseWorkerModule(events);
        const [worker] = workers;
        await worker.ready;
        worker.deliverRequests = false;
        const process = bgWorker.startWorker({
            type: "encrypt",
            input,
            passphrase: secret,
            autoCalculateIterations: false,
        });
        const message = failure === "crash" ? "fixture Worker failure" : "shut down";
        const rejected = expect(process.task.promise).rejects.toMatchObject({
            code: "disconnected",
            message: expect.stringContaining(message),
        });
        await vi.waitFor(() => expect(worker.postMessage).toHaveBeenCalledTimes(1));

        if (failure === "crash") {
            worker.crash(message);
        } else {
            events.emitEvent(EVENT_PLATFORM_UNLOADED);
        }
        await rejected;
        expect(bgWorker.tasks.has(process.key)).toBe(false);
        expect(worker.terminate).toHaveBeenCalledTimes(1);
        if (failure === "crash") {
            await expect(bgWorker.decryptWorker(await encrypt(input, secret, false), secret, false)).resolves.toBe(
                input
            );
            expect(workers).toHaveLength(2);
        }
    });

    it("prewarms two slots and prefers the idle Worker while a split holds a lease", async () => {
        vi.stubGlobal("navigator", { hardwareConcurrency: 4 });
        bgWorker.initialiseWorkerModule(createLiveSyncEventHub());
        expect(workers).toHaveLength(2);
        await Promise.all(workers.map((worker) => worker.ready));

        const split = bgWorker.splitPieces2WorkerRabinKarp(new Blob([input], { type: "text/plain" }), 100, true, 1)();
        await expect(split.next()).resolves.toEqual({ done: false, value: input });
        const busy = workers.find((worker) => worker.postMessage.mock.calls.length > 0);
        const idle = workers.find((worker) => worker !== busy);
        expect(busy).toBeDefined();

        await expect(bgWorker.decryptWorker(await encrypt(input, secret, false), secret, false)).resolves.toBe(input);
        expect(busy?.postMessage).toHaveBeenCalledTimes(1);
        expect(idle?.postMessage).toHaveBeenCalledTimes(1);
        await split.return();
    });

    it("reads existing ciphertext and emits compatible V1 and HKDF ciphertext", async () => {
        bgWorker.initialiseWorkerModule(createLiveSyncEventHub());
        for (const calculate of [false, true]) {
            await expect(
                bgWorker.decryptWorker(await encrypt(input, secret, calculate), secret, calculate)
            ).resolves.toBe(input);
            await expect(
                decrypt(await bgWorker.encryptWorker(input, secret, calculate), secret, calculate)
            ).resolves.toBe(input);
        }
        const storage = new Uint8Array(40).fill(63);
        const salt = storage.subarray(3, 35);
        const originalSalt = salt.slice();
        await expect(bgWorker.decryptHKDFWorker(await encryptHKDF(input, secret, salt), secret, salt)).resolves.toBe(
            input
        );

        const pending = bgWorker.encryptHKDFWorker(input, secret, salt);
        salt.fill(5);
        await expect(decryptHKDF(await pending, secret, originalSalt)).resolves.toBe(input);
        expect(storage.byteLength).toBe(40);
        await expect(
            bgWorker.decryptHKDFWorker(await encryptHKDF(input, secret, salt), "wrong passphrase", salt)
        ).rejects.toBeInstanceOf(Error);
        expect(bgWorker.tasks.size).toBe(0);
    });
});
