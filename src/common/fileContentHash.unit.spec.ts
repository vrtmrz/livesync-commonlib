import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { computeFileContentHash } from "./fileContentHash.ts";

describe("file content hashing", () => {
    it.each([new Uint8Array(), new Uint8Array([0, 255, 128, 13, 10]), new TextEncoder().encode("日本語\r\n")])(
        "hashes exact bytes without text normalisation",
        async (bytes) => {
            const content = new Blob([bytes]);
            await expect(computeFileContentHash(content)).resolves.toBe(
                `sha256:${createHash("sha256").update(bytes).digest("hex")}`
            );
        }
    );

    it("serialises whole-file reads and releases the slot after failure", async () => {
        let release!: () => void;
        const blocked = new Promise<void>(resolve => { release = resolve; });
        let started!: () => void;
        const reading = new Promise<void>(resolve => { started = resolve; });
        const first = new Blob(["first"]);
        const second = new Blob(["second"]);
        vi.spyOn(first, "arrayBuffer").mockImplementation(async () => {
            started();
            await blocked;
            throw new Error("read failed");
        });
        const nextRead = vi.spyOn(second, "arrayBuffer");
        const failed = expect(computeFileContentHash(first)).rejects.toThrow("read failed");
        await reading;
        const next = computeFileContentHash(second);
        await Promise.resolve();
        expect(nextRead).not.toHaveBeenCalled();
        release();
        await failed;
        await expect(next).resolves.toBe(`sha256:${createHash("sha256").update("second").digest("hex")}`);
        expect(nextRead).toHaveBeenCalledOnce();
    });
});
