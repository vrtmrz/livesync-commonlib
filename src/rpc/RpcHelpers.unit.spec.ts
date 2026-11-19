import { RpcError as FancyKitRpcError, RpcRoom as FancyKitRpcRoom } from "@vrtmrz/rpc/p2p";
import { describe, expect, it } from "vitest";
import { IncomingChunkBuffer, splitIntoChunks } from "./chunking";
import { asRpcErrorShape, RpcError } from "./errors";
import { RpcRoom } from "./RpcRoom";

const transport = {
    send() {},
    onMessage: () => () => {},
};

it("keeps the details property in the shape of a Commonlib RPC error", () => {
    const error = new RpcError("REMOTE_ERROR", "fixture error");
    expect(error.toShape()).toStrictEqual({ code: "REMOTE_ERROR", message: "fixture error", details: undefined });

    error.details = { status: 404 };
    expect(error.toShape()).toStrictEqual({
        code: "REMOTE_ERROR",
        message: "fixture error",
        details: { status: 404 },
    });
});

it("preserves Fancy Kit's native shape for directly constructed RPC errors", () => {
    const error = new FancyKitRpcError("REMOTE_ERROR", "fixture error");
    expect(Object.hasOwn(error.toShape(), "details")).toBe(false);
});

it("recognises Commonlib rooms and excludes a raw Fancy Kit room with a custom signal", () => {
    class CustomRoom extends RpcRoom {}
    const standalone = new RpcRoom({ transport });
    const subclass = new CustomRoom({ transport });
    const raw = new FancyKitRpcRoom({
        transport,
        createAbortController: () => ({
            signal: { aborted: false, addEventListener() {}, removeEventListener() {} },
            abort() {},
        }),
    });
    try {
        expect(standalone).toBeInstanceOf(RpcRoom);
        expect(subclass).toBeInstanceOf(RpcRoom);
        expect(subclass).toBeInstanceOf(CustomRoom);
        expect(raw).not.toBeInstanceOf(RpcRoom);
    } finally {
        raw.close();
        subclass.close();
        standalone.close();
    }
});

it.each(["call", "notify"] as const)("shapes a standalone session %s error with no peer", async (operation) => {
    const room = new RpcRoom({ transport });
    try {
        const error = await room
            .session("")
            [operation]("events.missing")
            .catch((reason: unknown) => reason);
        expect(Object.getPrototypeOf(error)).toBe(RpcError.prototype);
        if (!(error instanceof RpcError)) {
            throw new Error("Expected an RPC error");
        }
        expect(error.toShape()).toStrictEqual({
            code: "NOT_CONNECTED",
            message: "Peer is not connected",
            details: undefined,
        });
    } finally {
        room.close();
    }
});

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
