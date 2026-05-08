import { describe, expect, it } from "vitest";
import { IncomingChunkBuffer, splitIntoChunks } from "./chunking";
import { asRpcErrorShape, RpcError } from "./errors";

describe("RPC helpers", () => {
    it("covers error normalisation", () => {
        const rpc = asRpcErrorShape(new RpcError("TIMEOUT", "t", { x: 1 } as any));
        expect(rpc.code).toBe("TIMEOUT");
        const normal = asRpcErrorShape(new Error("boom"));
        expect(normal.code).toBe("REMOTE_ERROR");
        const unknown = asRpcErrorShape("x");
        expect(unknown.message).toBe("Unknown remote error");
    });

    it("covers chunk splitting and missing chunk failure", () => {
        const payload = "x".repeat(2048);
        const chunks = splitIntoChunks(payload, 64);
        expect(chunks.length).toBeGreaterThan(1);
        const buf = new IncomingChunkBuffer(3);
        buf.add(0, "a");
        buf.add(2, "c");
        expect(buf.missingIndices()).toEqual([1]);
        expect(() => buf.toPayload()).toThrow();
    });
});
