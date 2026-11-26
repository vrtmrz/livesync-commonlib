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

        const blockBytes = 1024 * 1024;
        const source = new Blob([new Uint8Array(2 * blockBytes)]);
        const split = bgWorker.splitPieces2WorkerRabinKarp(source, blockBytes, false, blockBytes)();
        const first = await split.next();
        expect(first.done).toBe(false);
        expect(first.value).toHaveLength(4 * Math.ceil(blockBytes / 3));
        const busy = workers.find((worker) => worker.postMessage.mock.calls.length > 0);
        const idle = workers.find((worker) => worker !== busy);
        expect(busy).toBeDefined();

        const ciphertext = await encrypt(input, secret, false);
        try {
            await expect(bgWorker.decryptWorker(ciphertext, secret, false)).resolves.toBe(input);
            // The first decrypt rotated the pool's tie-breaker back to the busy slot.
            await expect(bgWorker.decryptWorker(ciphertext, secret, false)).resolves.toBe(input);
            expect(busy?.postMessage).toHaveBeenCalledTimes(1);
            expect(idle?.postMessage).toHaveBeenCalledTimes(2);
        } finally {
            await split.return();
        }
    });

    it("runs encryption and decryption while a split holds the only split slot", async () => {
        bgWorker.initialiseWorkerModule(createLiveSyncEventHub());
        const [worker] = workers;
        await worker.ready;
        worker.postMessage.mockImplementationOnce(() => undefined);
        const split = bgWorker.splitPieces2WorkerRabinKarp(new Blob(["pending split"]), 32, true, 32)();
        const read = split.next();
        try {
            await vi.waitFor(() => expect(worker.postMessage).toHaveBeenCalledTimes(1));
            const ciphertext = await bgWorker.encryptWorker(input, secret, false);
            await expect(bgWorker.decryptWorker(ciphertext, secret, false)).resolves.toBe(input);
            expect(worker.postMessage).toHaveBeenCalledTimes(3);
            expect(bgWorker.tasks.size).toBe(1);
        } finally {
            await split.return();
            await expect(read).resolves.toMatchObject({ done: true });
        }
    });

    it("starts two splits concurrently on a two-Worker pool and queues the third", async () => {
        vi.stubGlobal("navigator", { hardwareConcurrency: 4 });
        bgWorker.initialiseWorkerModule(createLiveSyncEventHub());
        const [worker1, worker2] = workers;
        await Promise.all(workers.map((worker) => worker.ready));
        worker1.postMessage.mockImplementationOnce(() => undefined);
        worker2.postMessage.mockImplementationOnce(() => undefined);
        const split = (body: string) =>
            bgWorker.splitPieces2WorkerRabinKarp(new Blob([body], { type: "text/plain" }), 32, true, 32, body)();
        const [first, second, third, fourth] = ["first", "second", "third", "fourth"].map(split);
        const [read1, read2, read3, read4] = [first.next(), second.next(), third.next(), fourth.next()];
        try {
            await new Promise(setImmediate);
            expect(worker1.postMessage).toHaveBeenCalledTimes(1);
            expect(worker2.postMessage).toHaveBeenCalledTimes(1);

            await first.return();
            await expect(read3).resolves.toEqual({ done: false, value: "third" });
            await expect(read4).resolves.toEqual({ done: false, value: "fourth" });
            expect(worker1.postMessage).toHaveBeenCalledTimes(3);
            expect(worker2.postMessage).toHaveBeenCalledTimes(1);
            expect(worker1.postMessage.mock.calls.map(([request]) => request)).toEqual(
                ["first", "third", "fourth"].map((filename) =>
                    expect.objectContaining({ method: "split", args: [expect.objectContaining({ filename })] })
                )
            );
        } finally {
            await Promise.all([first.return(), second.return(), third.return(), fourth.return()]);
            await Promise.allSettled([read1, read2, read3, read4]);
        }
    });

    it("places a second split on the Worker without an active split even with multiple pending encryptions there", async () => {
        vi.stubGlobal("navigator", { hardwareConcurrency: 4 });
        bgWorker.initialiseWorkerModule(createLiveSyncEventHub());
        const [worker1, worker2] = workers;
        await Promise.all(workers.map((worker) => worker.ready));
        const forward1 = worker1.postMessage.getMockImplementation()!;
        const forward2 = worker2.postMessage.getMockImplementation()!;
        const heldWorker1Encrypts: (() => void)[] = [];
        const heldWorker2Encrypts: (() => void)[] = [];
        // Hold split1 on worker1, and hold encryptions on both Workers so we can fill W2 to 3 leases
        // then drain W1 back to 1 lease (split1 only) before dispatching split2.
        worker1.postMessage.mockImplementation((data, transfer) => {
            if (data?.method === "split" && data?.args?.[0]?.filename === "first") {
                return;
            }
            if (data?.method === "encrypt") {
                heldWorker1Encrypts.push(() => forward1(data, transfer));
                return;
            }
            forward1(data, transfer);
        });
        worker2.postMessage.mockImplementation((data, transfer) => {
            if (data?.method === "encrypt") {
                heldWorker2Encrypts.push(() => forward2(data, transfer));
                return;
            }
            forward2(data, transfer);
        });
        const split1 = bgWorker.splitPieces2WorkerRabinKarp(
            new Blob(["first"], { type: "text/plain" }),
            32,
            true,
            32,
            "first"
        )();
        const read1 = split1.next();
        const encryptions: Promise<string>[] = [];
        let settledEncrypts = 0;
        let split2: AsyncGenerator<string, void, unknown> | undefined;
        let read2: Promise<IteratorResult<string, void>> | undefined;
        try {
            await vi.waitFor(() => expect(worker1.postMessage).toHaveBeenCalledTimes(1));
            // Dispatch 5 concurrent encryptions: W1 gets 2 (+ split1 = 3 leases), W2 gets 3 leases.
            for (let i = 0; i < 5; i++) {
                encryptions.push(
                    bgWorker.encryptWorker(input, secret, false).then((ciphertext) => {
                        settledEncrypts++;
                        return ciphertext;
                    })
                );
            }
            await vi.waitFor(() => expect(heldWorker1Encrypts.length + heldWorker2Encrypts.length).toBe(5));
            expect(heldWorker2Encrypts).toHaveLength(3);
            expect(heldWorker1Encrypts).toHaveLength(2);
            // Drain W1's 2 encryptions so W1 has 1 lease (split1) while W2 still holds 3 pending encryption leases.
            for (const release of heldWorker1Encrypts.splice(0)) {
                release();
            }
            await vi.waitFor(() => expect(settledEncrypts).toBe(2));

            split2 = bgWorker.splitPieces2WorkerRabinKarp(
                new Blob(["second"], { type: "text/plain" }),
                32,
                true,
                32,
                "second"
            )();
            read2 = split2.next();
            await expect(read2).resolves.toEqual({ done: false, value: "second" });
            const worker1Splits = worker1.postMessage.mock.calls.filter(([req]) => req.method === "split");
            const worker2Splits = worker2.postMessage.mock.calls.filter(([req]) => req.method === "split");
            expect(worker1Splits).toHaveLength(1);
            expect(worker2Splits).toHaveLength(1);
            for (const release of heldWorker2Encrypts.splice(0)) {
                release();
            }
            const ciphertexts = await Promise.all(encryptions);
            for (const ciphertext of ciphertexts) {
                await expect(decrypt(ciphertext, secret, false)).resolves.toBe(input);
            }
        } finally {
            for (const release of [...heldWorker1Encrypts, ...heldWorker2Encrypts]) {
                release();
            }
            await Promise.all([split1.return(), split2?.return()]);
            await Promise.allSettled([read1, read2, ...encryptions]);
        }
    });

    it("tracks fallback splits per Worker so a later split uses a recovered Worker despite encryption leases", async () => {
        vi.stubGlobal("navigator", { hardwareConcurrency: 4 });
        let created = 0;
        inlineWorkerFactory.mockImplementation(() => {
            created += 1;
            return createWorker(created !== 3);
        });
        bgWorker.initialiseWorkerModule(createLiveSyncEventHub());
        const [worker1, worker2] = workers;
        await Promise.all([worker1.ready, worker2.ready]);
        const forward1 = worker1.postMessage.getMockImplementation()!;
        let releaseSplitA: (() => void) | undefined;
        let releaseSplitB: (() => void) | undefined;
        const heldWorker1Encrypts: (() => void)[] = [];
        const heldReplacementEncrypts: (() => void)[] = [];
        worker1.postMessage.mockImplementation((data, transfer) => {
            if (data?.method === "split" && data?.args?.[0]?.filename === "splitA") {
                releaseSplitA = () => forward1(data, transfer);
                return;
            }
            if (data?.method === "split" && data?.args?.[0]?.filename === "splitB") {
                releaseSplitB = () => forward1(data, transfer);
                return;
            }
            if (data?.method === "encrypt") {
                heldWorker1Encrypts.push(() => forward1(data, transfer));
                return;
            }
            forward1(data, transfer);
        });

        const split = (name: string) =>
            bgWorker.splitPieces2WorkerRabinKarp(new Blob([name], { type: "text/plain" }), 32, true, 32, name)();
        const splitA = split("splitA");
        const readA = splitA.next();
        let splitB: AsyncGenerator<string, void, unknown> | undefined;
        let readB: Promise<IteratorResult<string, void>> | undefined;
        let splitC: AsyncGenerator<string, void, unknown> | undefined;
        let readC: Promise<IteratorResult<string, void>> | undefined;
        const encryptions: Promise<string>[] = [];
        let settledEncrypts = 0;
        try {
            await vi.waitFor(() => expect(releaseSplitA).toBeDefined());
            // Crash W2 so its replacement stays starting while splitB takes the fallback onto W1.
            worker2.crash("simulated W2 restart");
            splitB = split("splitB");
            readB = splitB.next();
            await vi.waitFor(() => expect(releaseSplitB).toBeDefined());
            expect(workers).toHaveLength(3);
            const replacement = workers[2];
            const forwardReplacement = replacement.postMessage.getMockImplementation()!;
            replacement.postMessage.mockImplementation((data, transfer) => {
                if (data?.method === "encrypt") {
                    heldReplacementEncrypts.push(() => forwardReplacement(data, transfer));
                    return;
                }
                forwardReplacement(data, transfer);
            });

            // Complete splitA while splitB remains active on W1, then finish W2's recovery.
            releaseSplitA!();
            releaseSplitA = undefined;
            await expect(readA).resolves.toEqual({ done: false, value: "splitA" });
            await expect(splitA.next()).resolves.toEqual({ done: true, value: undefined });

            replacement.start();
            await replacement.ready;

            // Create the lease imbalance: W1 has 1 lease (splitB) while recovered W2 holds 2 pending encryptions.
            for (let i = 0; i < 3; i++) {
                encryptions.push(
                    bgWorker.encryptWorker(input, secret, false).then((ciphertext) => {
                        settledEncrypts++;
                        return ciphertext;
                    })
                );
            }
            await vi.waitFor(() => expect(heldWorker1Encrypts.length + heldReplacementEncrypts.length).toBe(3));
            expect(heldReplacementEncrypts).toHaveLength(2);
            expect(heldWorker1Encrypts).toHaveLength(1);
            for (const release of heldWorker1Encrypts.splice(0)) {
                release();
            }
            await vi.waitFor(() => expect(settledEncrypts).toBe(1));

            // splitC must land on recovered W2 instead of running alongside splitB on W1.
            splitC = split("splitC");
            readC = splitC.next();
            await expect(readC).resolves.toEqual({ done: false, value: "splitC" });
            const worker1SplitNames = worker1.postMessage.mock.calls
                .filter(([req]) => req.method === "split")
                .map(([req]) => req.args[0].filename);
            const replacementSplitNames = replacement.postMessage.mock.calls
                .filter(([req]) => req.method === "split")
                .map(([req]) => req.args[0].filename);
            expect(worker1SplitNames).toEqual(["splitA", "splitB"]);
            expect(replacementSplitNames).toEqual(["splitC"]);

            for (const release of heldReplacementEncrypts.splice(0)) {
                release();
            }
            const ciphertexts = await Promise.all(encryptions);
            for (const ciphertext of ciphertexts) {
                await expect(decrypt(ciphertext, secret, false)).resolves.toBe(input);
            }
        } finally {
            releaseSplitA?.();
            releaseSplitB?.();
            for (const release of [...heldWorker1Encrypts, ...heldReplacementEncrypts]) {
                release();
            }
            await Promise.all([splitA.return(), splitB?.return(), splitC?.return()]);
            await Promise.allSettled([readA, readB, readC, ...encryptions]);
        }
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
