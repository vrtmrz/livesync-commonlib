import { describe, expect, it, vi } from "vitest";
import { createLiveSyncEventHub } from "@lib/hub/hub";
import { P2PRoomSession } from "./P2PRoomSession";

function createDeferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((res) => {
        resolve = res;
    });
    return { promise, resolve };
}

function createSession() {
    return new P2PRoomSession({
        events: createLiveSyncEventHub(),
        translate: (key: string) => key,
        settings: { P2P_Enabled: true },
        db: {},
        simpleStore: {},
        deviceName: "device-a",
        platform: "test",
        confirm: {},
        processReplicatedDocs: vi.fn(),
    } as any);
}

describe("P2PRoomSession finite-operation ownership", () => {
    it("cancels every concurrent finite operation owned by the room", async () => {
        const session = createSession();
        const signals: AbortSignal[] = [];
        const gates = [createDeferred(), createDeferred()];
        const operations = gates.map((gate) =>
            session.runFiniteOperation(async (signal) => {
                signals.push(signal);
                await gate.promise;
                return signal.aborted;
            })
        );
        await vi.waitFor(() => expect(signals).toHaveLength(2));

        session.cancelActiveTransfers();

        expect(signals.every((signal) => signal.aborted)).toBe(true);
        gates.forEach((gate) => gate.resolve());
        await expect(Promise.all(operations)).resolves.toEqual([true, true]);
    });

    it("cancels current operations while allowing a later operation to reuse the room", async () => {
        const session = createSession();
        const settled = createDeferred();
        let firstSignal: AbortSignal | undefined;
        const first = session.runFiniteOperation(async (signal) => {
            firstSignal = signal;
            await settled.promise;
            return signal.aborted ? "cancelled" : "completed";
        });
        await vi.waitFor(() => expect(firstSignal).toBeDefined());

        session.cancelActiveTransfers();
        expect(firstSignal?.aborted).toBe(true);
        settled.resolve();
        await expect(first).resolves.toBe("cancelled");

        await expect(session.runFiniteOperation((signal) => signal.aborted)).resolves.toBe(false);
    });

    it("aborts and settles current operations before releasing a retired room", async () => {
        const session = createSession();
        const operationSettled = createDeferred();
        const close = vi.spyOn(session.replicator, "close").mockResolvedValue(undefined);
        const operation = session.runFiniteOperation(async (signal) => {
            if (!signal.aborted) {
                await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
            }
            operationSettled.resolve();
        });

        const retirement = session.retire();
        await operationSettled.promise;
        expect(close).not.toHaveBeenCalled();
        await operation;
        await retirement;

        expect(close).toHaveBeenCalledOnce();
        await expect(session.runFiniteOperation(() => undefined)).rejects.toThrow("retiring");
    });
});
