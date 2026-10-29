import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RpcRoom } from "./RpcRoom";
import type { RpcEnvelope, RpcWireMessage, TransportAdapter } from "./types";

type SentMessage = { message: RpcWireMessage; peerId: string };

class ChunkTransport implements TransportAdapter {
    readonly sent: SentMessage[] = [];
    receive: (message: RpcWireMessage, peerId: string) => void = () => undefined;
    onSend?: (message: RpcWireMessage, peerId: string) => void | Promise<void>;

    send(message: RpcWireMessage, peerId: string) {
        this.sent.push({ message, peerId });
        return this.onSend?.(message, peerId);
    }

    onMessage(handler: (message: RpcWireMessage, peerId: string) => void) {
        this.receive = handler;
        return () => {
            this.receive = () => undefined;
        };
    }

    chunk(streamId: string, index: number, total = 3, payload = "part", peerId = "peer-a") {
        this.receive({ wire: "chunk", streamId, index, total, payload }, peerId);
    }

    acknowledgements() {
        return this.sent.filter(({ message }) => message.wire === "chunk-ack");
    }
}

function acknowledgement(streamId: string, missing: number[], peerId = "peer-a"): SentMessage {
    return { message: { wire: "chunk-ack", streamId, missing }, peerId };
}

describe("RPC missing-chunk waiting lifetime", () => {
    const rooms: RpcRoom[] = [];
    function fixture() {
        const transport = new ChunkTransport();
        const room = new RpcRoom({ transport, chunkMissingRetryMs: 50 });
        rooms.push(room);
        return { room, transport };
    }

    beforeEach(() => vi.useFakeTimers());
    afterEach(() => {
        rooms.splice(0).forEach((room) => room.close());
        vi.restoreAllMocks();
        vi.useRealTimers();
    });

    it("requests the missing indices once after the quiet period", async () => {
        const { transport } = fixture();
        transport.chunk("first", 1);
        expect(vi.getTimerCount()).toBe(1);
        await vi.advanceTimersByTimeAsync(49);
        expect(transport.sent).toEqual([]);
        await vi.advanceTimersByTimeAsync(1);
        expect(transport.sent).toEqual([acknowledgement("first", [0, 2])]);
        expect(vi.getTimerCount()).toBe(0);
        await vi.advanceTimersByTimeAsync(500);
        expect(transport.sent).toHaveLength(1);
    });

    it.each([
        { label: "new", index: 1, missing: [2] },
        { label: "duplicate", index: 0, missing: [1, 2] },
        { label: "out-of-range", index: 9, missing: [1, 2] },
    ])("replaces the deadline and sender after a $label chunk", async ({ index, missing }) => {
        const { transport } = fixture();
        transport.chunk("first", 0);
        await vi.advanceTimersByTimeAsync(30);
        transport.chunk("first", index, 3, "next", "peer-b");
        expect(vi.getTimerCount()).toBe(1);
        await vi.advanceTimersByTimeAsync(49);
        expect(transport.sent).toEqual([]);
        await vi.advanceTimersByTimeAsync(1);
        expect(transport.sent).toEqual([acknowledgement("first", missing, "peer-b")]);
    });

    it("starts another wait when a partial retransmission arrives after an acknowledgement", async () => {
        const { transport } = fixture();
        transport.chunk("first", 0);
        await vi.advanceTimersByTimeAsync(50);
        transport.chunk("first", 1);
        await vi.advanceTimersByTimeAsync(50);
        expect(transport.sent).toEqual([acknowledgement("first", [1, 2]), acknowledgement("first", [2])]);
        expect(vi.getTimerCount()).toBe(0);
    });

    it("preserves a new wait created synchronously while sending an acknowledgement", async () => {
        const { transport } = fixture();
        transport.onSend = (message) => {
            if (message.wire === "chunk-ack" && message.missing.length === 2) {
                transport.chunk("first", 1);
            }
        };
        transport.chunk("first", 0);
        await vi.advanceTimersByTimeAsync(50);
        expect(vi.getTimerCount()).toBe(1);
        await vi.advanceTimersByTimeAsync(50);
        expect(transport.sent).toEqual([acknowledgement("first", [1, 2]), acknowledgement("first", [2])]);
    });

    it("releases a completed stream before its acknowledgement finishes and then dispatches its payload", async () => {
        const { room, transport } = fixture();
        let finishAcknowledgement!: () => void;
        const sending = new Promise<void>((resolve) => {
            finishAcknowledgement = resolve;
        });
        transport.onSend = (message) => {
            if (message.wire === "chunk-ack" && message.missing.length === 0) return sending;
        };
        const handler = vi.fn((_peerId: string, value: unknown) => value);
        room.register("echo.value", handler);
        const request: RpcEnvelope = { kind: "request", requestId: "request", method: "echo.value", args: ["value"] };
        const payload = JSON.stringify(request);
        const split = Math.floor(payload.length / 2);
        transport.chunk("complete", 0, 2, payload.slice(0, split));
        transport.chunk("incomplete", 0);
        await vi.advanceTimersByTimeAsync(30);
        transport.chunk("complete", 1, 2, payload.slice(split));
        expect(transport.sent).toEqual([acknowledgement("complete", [])]);
        expect(vi.getTimerCount()).toBe(1);
        await vi.advanceTimersByTimeAsync(100);
        expect(handler).not.toHaveBeenCalled();
        expect(transport.acknowledgements()).toEqual([
            acknowledgement("complete", []),
            acknowledgement("incomplete", [1, 2]),
        ]);
        finishAcknowledgement();
        await vi.advanceTimersByTimeAsync(0);
        expect(handler).toHaveBeenCalledExactlyOnceWith("peer-a", "value");
        expect(transport.sent.at(-1)).toEqual({
            message: {
                wire: "raw",
                payload: JSON.stringify({ kind: "response", requestId: "request", ok: true, data: "value" }),
            },
            peerId: "peer-a",
        });
        expect(vi.getTimerCount()).toBe(0);
    });

    it("cancels every pending stream when the room closes, including a replaced wait", async () => {
        const { room, transport } = fixture();
        transport.chunk("first", 0);
        transport.chunk("second", 0);
        await vi.advanceTimersByTimeAsync(30);
        transport.chunk("first", 1);
        expect(vi.getTimerCount()).toBe(2);
        room.close();
        room.close();
        expect(vi.getTimerCount()).toBe(0);
        transport.chunk("after-close", 0);
        await vi.advanceTimersByTimeAsync(500);
        expect(transport.sent).toEqual([]);
        expect(vi.getTimerCount()).toBe(0);
    });
});
