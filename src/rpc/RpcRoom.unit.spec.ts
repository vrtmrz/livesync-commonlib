import { describe, expect, it } from "vitest";
import { RpcRoom, type RpcWireMessage, type TransportAdapter } from "./index";
import { RpcSession } from "./RpcSession";

class MockTransport implements TransportAdapter {
    readonly peerId: string;
    peer?: MockTransport;
    private messageHandler?: (message: RpcWireMessage, peerId: string) => void;
    private joinHandlers: Array<(peerId: string) => void> = [];
    private leaveHandlers: Array<(peerId: string) => void> = [];
    dropChunkOnce?: (msg: RpcWireMessage, toPeerId: string) => boolean;

    constructor(peerId: string) {
        this.peerId = peerId;
    }

    attach(peer: MockTransport) {
        this.peer = peer;
        this.joinHandlers.forEach((h) => h(peer.peerId));
    }

    detach() {
        const old = this.peer;
        this.peer = undefined;
        if (old) {
            this.leaveHandlers.forEach((h) => h(old.peerId));
        }
    }

    send(message: RpcWireMessage, _peerId: string) {
        const peer = this.peer;
        if (!peer || !peer.messageHandler) return;
        if (this.dropChunkOnce?.(message, peer.peerId)) {
            this.dropChunkOnce = undefined;
            return;
        }
        peer.messageHandler(message, this.peerId);
    }

    onMessage(handler: (message: RpcWireMessage, peerId: string) => void) {
        this.messageHandler = handler;
        return () => {
            if (this.messageHandler === handler) {
                this.messageHandler = undefined;
            }
        };
    }

    onPeerJoin(handler: (peerId: string) => void) {
        this.joinHandlers.push(handler);
        return () => {
            this.joinHandlers = this.joinHandlers.filter((h) => h !== handler);
        };
    }

    onPeerLeave(handler: (peerId: string) => void) {
        this.leaveHandlers.push(handler);
        return () => {
            this.leaveHandlers = this.leaveHandlers.filter((h) => h !== handler);
        };
    }
}

function createPair() {
    const tA = new MockTransport("peer-a");
    const tB = new MockTransport("peer-b");
    tA.attach(tB);
    tB.attach(tA);
    const roomA = new RpcRoom({ transport: tA, maxWirePayloadBytes: 128, chunkMissingRetryMs: 20 });
    const roomB = new RpcRoom({ transport: tB, maxWirePayloadBytes: 128, chunkMissingRetryMs: 20 });
    return { tA, tB, roomA, roomB };
}

describe("RpcRoom", () => {
    it("calls registered namespaced method", async () => {
        const { roomA, roomB } = createPair();
        roomB.register("calc.add", (_peerId, a, b) => ((a as number) + (b as number)) as any);
        const session = roomA.session("peer-b");
        const ret = await session.call<number>("calc.add", [2 as any, 3 as any], 1000);
        expect(ret).toBe(5);
        roomA.close();
        roomB.close();
    });

    it("times out at caller when remote rejects by auth gate", async () => {
        const tA = new MockTransport("peer-a");
        const tB = new MockTransport("peer-b");
        tA.attach(tB);
        tB.attach(tA);
        const roomA = new RpcRoom({ transport: tA, maxWirePayloadBytes: 128 });
        const roomB = new RpcRoom({
            transport: tB,
            maxWirePayloadBytes: 128,
            canAcceptRequest: () => false,
        });
        roomB.register("calc.add", () => 5 as any);
        await expect(roomA.session("peer-b").call("calc.add", [1 as any, 2 as any], 40)).rejects.toMatchObject({
            code: "TIMEOUT",
        });
        roomA.close();
        roomB.close();
    });

    it("re-sends missing chunks and completes call", async () => {
        const { tA, roomA, roomB } = createPair();
        tA.dropChunkOnce = (msg) => msg.wire === "chunk" && msg.index === 1;
        roomB.register("echo.large", (_peerId, text) => text);
        const session = roomA.session("peer-b");
        const large = "x".repeat(5000);
        const ret = await session.call<string>("echo.large", [large as any], 3000);
        expect(ret.length).toBe(5000);
        roomA.close();
        roomB.close();
    });

    it("supports cancellation", async () => {
        let capturedRequestId = "";
        const tA = new MockTransport("peer-a");
        const tB = new MockTransport("peer-b");
        tA.attach(tB);
        tB.attach(tA);
        const originalSend = tA.send.bind(tA);
        // eslint-disable-next-line @typescript-eslint/no-misused-promises
        tA.send = async (msg, peerId) => {
            if (msg.wire === "raw") {
                try {
                    const parsed = JSON.parse(msg.payload) as { kind?: string; requestId?: string };
                    if (parsed.kind === "request" && parsed.requestId) {
                        capturedRequestId = parsed.requestId;
                    }
                } catch {
                    // ignore
                }
            }
            return await originalSend(msg, peerId);
        };
        const roomA = new RpcRoom({ transport: tA, maxWirePayloadBytes: 128 });
        const roomB = new RpcRoom({ transport: tB, maxWirePayloadBytes: 128 });
        roomB.register("job.long", async () => {
            await new Promise((resolve) => setTimeout(resolve, 80));
            return "done" as any;
        });

        const p = roomA.session("peer-b").call("job.long", [], 1000);
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(capturedRequestId.length > 0).toBe(true);
        await roomA.cancel("peer-b", capturedRequestId);
        await expect(p).rejects.toMatchObject({ code: "CANCELLED" });
        roomA.close();
        roomB.close();
    });

    it("returns remote error for unknown method", async () => {
        const { roomA, roomB } = createPair();
        await expect(roomA.session("peer-b").call("missing.method", [], 500)).rejects.toMatchObject({
            code: "REMOTE_ERROR",
        });
        roomA.close();
        roomB.close();
    });

    it("validates namespaced methods", async () => {
        const { roomA, roomB } = createPair();
        expect(() => roomA.register("invalid", () => 1 as any)).toThrow();
        await expect(roomB.session("peer-a").call("invalid", [], 100)).rejects.toMatchObject({
            code: "PROTOCOL_ERROR",
        });
        roomA.close();
        roomB.close();
    });

    it("warns on invalid payload and minor mismatch", async () => {
        const warnings: string[] = [];
        const tA = new MockTransport("peer-a");
        const tB = new MockTransport("peer-b");
        tA.attach(tB);
        tB.attach(tA);
        const roomA = new RpcRoom({
            transport: tA,
            maxWirePayloadBytes: 128,
            onProtocolWarning: (msg) => warnings.push(msg),
        });
        const roomB = new RpcRoom({
            transport: tB,
            maxWirePayloadBytes: 128,
            onProtocolWarning: (msg) => warnings.push(msg),
        });

        tA.send({ wire: "raw", payload: "{" }, "peer-b");
        tA.send(
            {
                wire: "raw",
                payload: JSON.stringify({ kind: "handshake", versionMajor: 1, versionMinor: 999 }),
            },
            "peer-b"
        );
        roomB.register("echo.ok", (_p, v) => v);
        await roomA.session("peer-b").call("echo.ok", [1 as any], 500);
        expect(warnings.length).toBeGreaterThan(0);
        roomA.close();
        roomB.close();
    });

    it("blocks on major mismatch", async () => {
        const tA = new MockTransport("peer-a");
        const tB = new MockTransport("peer-b");
        tA.attach(tB);
        tB.attach(tA);
        const roomA = new RpcRoom({ transport: tA, maxWirePayloadBytes: 128 });
        const roomB = new RpcRoom({ transport: tB, maxWirePayloadBytes: 128 });
        tA.send(
            {
                wire: "raw",
                payload: JSON.stringify({ kind: "handshake", versionMajor: 999, versionMinor: 0 }),
            },
            "peer-b"
        );
        roomB.register("echo.ok", (_p, v) => v);
        await expect(roomA.session("peer-b").call("echo.ok", [1 as any], 500)).rejects.toMatchObject({
            code: "REMOTE_ERROR",
        });
        roomA.close();
        roomB.close();
    });

    it("rejects pending request when room closes", async () => {
        const { roomA, roomB } = createPair();
        roomB.register("job.wait", async () => {
            await new Promise((resolve) => setTimeout(resolve, 200));
            return "ok" as any;
        });
        const p = roomA.session("peer-b").call("job.wait", [], 1000);
        await new Promise((resolve) => setTimeout(resolve, 20));
        roomA.close();
        await expect(p).rejects.toMatchObject({ code: "NOT_CONNECTED" });
        roomB.close();
    });

    it("covers session proxy and disconnected peer check", async () => {
        const { roomA, roomB } = createPair();
        roomB.register("math.mul", (_peerId, a, b) => ((a as number) * (b as number)) as any);
        const proxy = roomA.session("peer-b").createProxy<{ mul(a: number, b: number): Promise<number> }>("math");
        expect(await proxy.mul(3, 4)).toBe(12);

        const session = new RpcSession(roomA, "");
        await expect(session.call("math.mul", [1 as any, 2 as any], 10)).rejects.toMatchObject({
            code: "NOT_CONNECTED",
        });
        roomA.close();
        roomB.close();
    });
});
