import { promiseWithResolvers } from "octagonal-wheels/promises";
import { describe, expect, it, vi } from "vitest";
import {
    acquireTrackedSplitConnection,
    closeSplitConnectionTracker,
    createSplitConnectionTrackerState,
    trackConnection,
} from "./splitConnectionTracker.ts";

function fakeConnection(client: string) {
    const controller = new AbortController();
    const connection = { signal: controller.signal };
    const ready = promiseWithResolvers<string>();
    const release = vi.fn();
    return {
        connection,
        ready,
        release,
        abort: () => controller.abort(),
        acquire: async () => ({ connection, client, release }),
    };
}

function createTracker() {
    return createSplitConnectionTrackerState<ReturnType<typeof fakeConnection>["connection"], string>();
}

describe("split connection tracker", () => {
    it("keeps the pool's candidate when it has no active split", async () => {
        const state = createTracker();
        const first = fakeConnection("first");
        const candidate = fakeConnection("candidate");
        trackConnection(state, first.connection, Promise.resolve("first"));
        const split = await acquireTrackedSplitConnection(state, candidate.acquire);
        expect(split.connection).toBe(candidate.connection);
        expect(candidate.release).not.toHaveBeenCalled();
        split.release();
        expect(candidate.release).toHaveBeenCalledOnce();
    });

    it("bypasses the pool's candidate when it is already splitting and a Worker busy with encryption is ready", async () => {
        const state = createTracker();
        const splitting = fakeConnection("splitting");
        const encrypting = fakeConnection("encrypting");
        trackConnection(state, encrypting.connection, Promise.resolve("encrypting"));
        const first = await acquireTrackedSplitConnection(state, splitting.acquire);

        // The pool returns the same candidate because the other Worker has more encryption leases.
        const second = await acquireTrackedSplitConnection(state, splitting.acquire);
        expect(second.connection).toBe(encrypting.connection);
        expect(second.client).toBe("encrypting");
        expect(splitting.release).toHaveBeenCalledOnce();
        second.release();
        expect(encrypting.release).not.toHaveBeenCalled();
        first.release();
    });

    it("counts both splits on a fallback connection until the restarting Worker is ready", async () => {
        const state = createTracker();
        const worker1 = fakeConnection("W1");
        const worker2 = fakeConnection("W2");
        trackConnection(state, worker1.connection, Promise.resolve("W1"));
        trackConnection(state, worker2.connection, worker2.ready.promise);

        const splitA = await acquireTrackedSplitConnection(state, worker1.acquire);
        const splitB = await acquireTrackedSplitConnection(state, worker1.acquire);
        expect(splitB.connection).toBe(worker1.connection);
        expect(state.activeSplitCounts.get(worker1.connection)).toBe(2);
        splitA.release();
        expect(state.activeSplitCounts.get(worker1.connection)).toBe(1);

        worker2.ready.resolve("W2");
        // W2 has pending encryptions, so the pool still nominates W1.
        const splitC = await acquireTrackedSplitConnection(state, worker1.acquire);
        expect(splitC.connection).toBe(worker2.connection);
        splitB.release();
        splitC.release();
        expect(state.activeSplitCounts.size).toBe(0);
    });

    it("releases each lease once, preserving the count of another split on that connection", async () => {
        const state = createTracker();
        const candidate = fakeConnection("candidate");
        const first = await acquireTrackedSplitConnection(state, candidate.acquire);
        const second = await acquireTrackedSplitConnection(state, candidate.acquire);
        first.release();
        first.release();
        expect(candidate.release).toHaveBeenCalledOnce();
        expect(state.activeSplitCounts.get(candidate.connection)).toBe(1);
        second.release();
        expect(state.activeSplitCounts.size).toBe(0);
    });

    it("forgets aborted connections and ignores late readiness", async () => {
        const state = createTracker();
        const active = fakeConnection("active");
        const pending = fakeConnection("pending");
        trackConnection(state, active.connection, Promise.resolve("active"));
        trackConnection(state, pending.connection, pending.ready.promise);
        const split = await acquireTrackedSplitConnection(state, active.acquire);
        expect(state.readySlots.has(active.connection)).toBe(true);
        active.abort();
        pending.abort();
        pending.ready.resolve("pending");
        await pending.ready.promise;
        split.release();
        expect(state.readySlots.size).toBe(0);
        expect(state.activeSplitCounts.size).toBe(0);
        expect(active.release).toHaveBeenCalledOnce();
    });

    it("clears bookkeeping on close and ignores late readiness or acquisition", async () => {
        const state = createTracker();
        const active = fakeConnection("active");
        const pending = fakeConnection("pending");
        trackConnection(state, active.connection, Promise.resolve("active"));
        trackConnection(state, pending.connection, pending.ready.promise);
        const split = await acquireTrackedSplitConnection(state, active.acquire);
        const late = acquireTrackedSplitConnection(state, pending.acquire);

        closeSplitConnectionTracker(state);
        expect(state.readySlots.size).toBe(0);
        expect(state.activeSplitCounts.size).toBe(0);
        pending.ready.resolve("pending");
        const lateSplit = await late;
        expect(state.readySlots.size).toBe(0);
        expect(state.activeSplitCounts.size).toBe(0);
        lateSplit.release();
        split.release();
        expect(pending.release).toHaveBeenCalledOnce();
        expect(active.release).toHaveBeenCalledOnce();
    });
});
