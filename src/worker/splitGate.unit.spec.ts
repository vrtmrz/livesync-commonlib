import { RpcError } from "@vrtmrz/rpc";
import { describe, expect, it, vi } from "vitest";
import { createSplitGate } from "./splitGate.ts";

const signal = () => new AbortController().signal;

describe("split gate", () => {
    it("hands off slots in FIFO order within capacity", async () => {
        const gate = createSplitGate(2);
        const first = await gate.acquire(signal());
        const second = await gate.acquire(signal());
        const admitted = vi.fn();
        const third = gate.acquire(signal()).then((release) => {
            admitted(3);
            return release;
        });
        const fourth = gate.acquire(signal()).then((release) => {
            admitted(4);
            return release;
        });

        await Promise.resolve();
        expect(admitted).not.toHaveBeenCalled();
        first();
        const releaseThird = await third;
        expect(admitted.mock.calls).toEqual([[3]]);
        second();
        const releaseFourth = await fourth;
        expect(admitted.mock.calls).toEqual([[3], [4]]);
        releaseThird();
        releaseFourth();
    });

    it("removes an aborted waiter without consuming the next permit", async () => {
        const gate = createSplitGate(1);
        const release = await gate.acquire(signal());
        const controller = new AbortController();
        const queued = gate.acquire(controller.signal);
        const next = gate.acquire(signal());
        controller.abort(new Error("cancelled"));
        await expect(queued).rejects.toBe(controller.signal.reason);
        release();
        (await next)();
    });

    it("rejects an already-aborted signal even when capacity is available", async () => {
        const gate = createSplitGate(1);
        const controller = new AbortController();
        controller.abort(new Error("cancelled"));
        await expect(gate.acquire(controller.signal)).rejects.toBe(controller.signal.reason);
        (await gate.acquire(signal()))();
    });

    it("releases each permit once, including after a handoff", async () => {
        const gate = createSplitGate(1);
        const first = await gate.acquire(signal());
        const second = gate.acquire(signal());
        const admitThird = vi.fn();
        const third = gate.acquire(signal()).then((release) => {
            admitThird();
            return release;
        });

        first();
        const releaseSecond = await second;
        first();
        await Promise.resolve();
        await Promise.resolve();
        expect(admitThird).not.toHaveBeenCalled();
        releaseSecond();
        const releaseThird = await third;
        releaseSecond();
        releaseThird();

        const fourth = await gate.acquire(signal());
        const admitFifth = vi.fn();
        const fifth = gate.acquire(signal()).then((release) => {
            admitFifth();
            return release;
        });
        await Promise.resolve();
        expect(admitFifth).not.toHaveBeenCalled();
        fourth();
        (await fifth)();
    });

    it("rejects queued and subsequent acquisitions when closed", async () => {
        const gate = createSplitGate(1);
        const release = await gate.acquire(signal());
        const queued = gate.acquire(signal());
        const error = new RpcError("disconnected", "pool closed");
        gate.close(error);
        await expect(queued).rejects.toBe(error);
        release();
        await expect(gate.acquire(signal())).rejects.toBe(error);
    });
});
