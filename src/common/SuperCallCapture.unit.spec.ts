import { promiseWithResolvers } from "octagonal-wheels/promises";
import { describe, expect, it, vi } from "vitest";
import { SuperCallCapture } from "./SuperCallCapture.ts";

describe("SuperCallCapture", () => {
    it("serialises a receiver's captures without host async context and advances after rejection", async () => {
        vi.stubGlobal("process", undefined);
        vi.stubGlobal("require", undefined);
        let capture: SuperCallCapture<string>;
        try {
            capture = new SuperCallCapture();
        } finally {
            vi.unstubAllGlobals();
        }

        const owner = {};
        const gate = promiseWithResolvers<void>();
        const entered = promiseWithResolvers<void>();
        const failure = new Error("override failed");
        const first = capture.invoke(owner, async (receiver) => {
            expect(receiver).toBe(owner);
            entered.resolve();
            await gate.promise;
            capture.takeRecorder(receiver)?.("first");
            throw failure;
        });
        const rejection = expect(first).rejects.toBe(failure);
        const nextOverride = vi.fn(async (receiver: typeof owner) => {
            expect(receiver).toBe(owner);
            await Promise.resolve();
            capture.takeRecorder(receiver)?.("second");
            return false;
        });
        const second = capture.invoke(owner, nextOverride);

        await entered.promise;
        expect(nextOverride).not.toHaveBeenCalled();
        gate.resolve();
        await rejection;
        await expect(second).resolves.toEqual({ result: false, delegated: { value: "second" } });
        expect(capture.takeRecorder(owner)).toBeUndefined();
    });
});
