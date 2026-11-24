import { RpcError } from "@vrtmrz/rpc";
import { describe, expect, it, vi } from "vitest";
import { isOutOfBandCancellableIterator } from "./outOfBandCancelIterator.ts";
import {
    isStringItem,
    isWireError,
    measureStringItem,
    serialiseError,
    stopGeneratorOnReturn,
    validateBatch,
} from "./workerPushStreamProtocol.ts";

describe("Worker push stream error protocol", () => {
    it.each(["aborted", "disconnected", "timeout", "stream-protocol-error", "remote-error"] as const)(
        "accepts and preserves %s",
        (code) => {
            const wire = { code, message: "diagnostic", remoteName: "WorkerError" };
            expect(isWireError(wire)).toBe(true);
            expect(serialiseError(new RpcError(code, wire.message, { remoteName: wire.remoteName }))).toEqual(wire);
        }
    );

    it.each([
        "encode-failed",
        "decode-failed",
        "transfer-failed",
        "unsupported-profile",
        "method-not-found",
        "invalid-contract",
        "invalid-envelope",
        "send-failed",
        "internal-error",
    ] as const)("maps %s to remote-error and preserves the diagnostic", (code) => {
        expect(isWireError({ code, message: "diagnostic" })).toBe(false);
        expect(serialiseError(new RpcError(code, "diagnostic", { remoteName: "WorkerError" }))).toEqual({
            code: "remote-error",
            message: "diagnostic",
            remoteName: "WorkerError",
        });
    });

    it("rejects malformed diagnostic fields", () => {
        expect(isWireError({ code: "aborted", message: 123 })).toBe(false);
        expect(isWireError({ code: "aborted", message: "diagnostic", remoteName: 123 })).toBe(false);
    });
});

describe("validateBatch", () => {
    const options = { isItem: isStringItem, chargeItem: measureStringItem, maxItemBytes: 256 };

    it("validates each item and the total charge", () => {
        const batch = { items: ["", "ab"], chargeBytes: 132 };
        expect(validateBatch(options, batch, 2, 64, 196)).toEqual(batch);
        expect(() => validateBatch(options, { ...batch, chargeBytes: 131 }, 2, 64, 196)).toThrow(
            "Worker stream batch charge does not match its items."
        );
        expect(() => validateBatch(options, { ...batch, chargeBytes: 133 }, 2, 64, 197)).toThrow(
            "Worker stream batch charge does not match its items."
        );
    });

    it("allows an oversized singleton only when the outstanding charge is zero", () => {
        const batch = { items: ["oversized"], chargeBytes: measureStringItem("oversized") };
        expect(validateBatch(options, batch, 2, 0, 64)).toEqual(batch);
        expect(() => validateBatch(options, batch, 2, 1, 64)).toThrow("Invalid Worker stream batch or credit usage.");
        expect(() => validateBatch(options, { items: ["", ""], chargeBytes: 128 }, 2, 0, 64)).toThrow(
            "Invalid Worker stream batch or credit usage."
        );
    });
});

describe("stopGeneratorOnReturn", () => {
    it.each(["return", "throw"] as const)("wraps a frozen iterator and stops it before %s", async (action) => {
        const calls: string[] = [];
        async function* source(): AsyncGenerator<string, void, unknown> {
            try {
                yield "chunk";
            } finally {
                calls.push("source closed");
            }
        }
        const iterator = Object.freeze(source());
        const stop = vi.fn(() => calls.push("stop"));
        const wrapper = stopGeneratorOnReturn(iterator, stop);
        expect(Object.getPrototypeOf(wrapper)).toBe(Object.prototype);
        expect(wrapper[Symbol.asyncIterator]()).toBe(wrapper);
        expect(isOutOfBandCancellableIterator(wrapper)).toBe(true);
        expect(isOutOfBandCancellableIterator(iterator)).toBe(false);
        await expect(wrapper.next()).resolves.toEqual({ done: false, value: "chunk" });
        expect(stop).not.toHaveBeenCalled();
        if (action === "return") {
            await expect(wrapper.return(Promise.resolve())).resolves.toEqual({ done: true, value: undefined });
        } else {
            const reason = new Error("consumer error");
            await expect(wrapper.throw(reason)).rejects.toBe(reason);
        }
        expect(calls).toEqual(["stop", "source closed"]);
    });
});
