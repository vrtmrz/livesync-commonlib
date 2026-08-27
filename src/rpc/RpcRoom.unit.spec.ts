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

function waitForAbort(signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.resolve();
    return new Promise((resolve) => {
        signal.addEventListener("abort", () => resolve(), { once: true });
    });
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

    it("settles the invocation through its pending promise when the request transport fails", async () => {
        const transport = new MockTransport("peer-a");
        transport.send = async () => {
            throw new Error("request transport failed");
        };
        const room = new RpcRoom({ transport });

        try {
            await expect(room.session("peer-b").call("job.send", [], 1000)).rejects.toThrow("request transport failed");
        } finally {
            room.close();
        }
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

    it("rejects the caller promptly when an in-flight call is cancelled", async () => {
        let capturedRequestId = "";
        let observeRequest!: () => void;
        const requestObserved = new Promise<void>((resolve) => {
            observeRequest = resolve;
        });
        let releaseHandler!: () => void;
        const handlerReleased = new Promise<void>((resolve) => {
            releaseHandler = resolve;
        });
        let observeHandler!: () => void;
        const handlerObserved = new Promise<void>((resolve) => {
            observeHandler = resolve;
        });
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
                        observeRequest();
                    }
                } catch {
                    // ignore
                }
            }
            return await originalSend(msg, peerId);
        };
        const roomA = new RpcRoom({ transport: tA, maxWirePayloadBytes: 128 });
        const roomB = new RpcRoom({ transport: tB, maxWirePayloadBytes: 128 });
        roomB.register("job.cancel promptly", async () => {
            observeHandler();
            await handlerReleased;
            return "done" as any;
        });

        const p = roomA.session("peer-b").call("job.cancel promptly", [], 1000);
        await requestObserved;
        await handlerObserved;
        await roomA.cancel("peer-b", capturedRequestId);

        try {
            const result = await Promise.race([
                p.then(
                    () => "resolved",
                    (error: unknown) => {
                        if (typeof error === "object" && error !== null && "code" in error) {
                            return String((error as { code: unknown }).code);
                        }
                        return error instanceof Error ? error.message : String(error);
                    }
                ),
                new Promise<string>((resolve) => setTimeout(() => resolve("still-pending"), 50)),
            ]);
            expect(result).toBe("CANCELLED");
        } finally {
            releaseHandler();
            await p.catch(() => undefined);
            roomA.close();
            roomB.close();
        }
    });

    it("rejects an AbortSignal call promptly and suppresses the late response", async () => {
        let handlerStarted!: () => void;
        const started = new Promise<void>((resolve) => {
            handlerStarted = resolve;
        });
        let handlerCancelled!: () => void;
        const cancelled = new Promise<void>((resolve) => {
            handlerCancelled = resolve;
        });
        let responseSent = false;
        const tA = new MockTransport("peer-a");
        const tB = new MockTransport("peer-b");
        tA.attach(tB);
        tB.attach(tA);
        const originalSend = tB.send.bind(tB);
        // eslint-disable-next-line @typescript-eslint/no-misused-promises
        tB.send = async (msg, peerId) => {
            if (msg.wire === "raw") {
                try {
                    if ((JSON.parse(msg.payload) as { kind?: string }).kind === "response") responseSent = true;
                } catch {
                    // ignore
                }
            }
            return await originalSend(msg, peerId);
        };
        const roomA = new RpcRoom({ transport: tA });
        const roomB = new RpcRoom({ transport: tB });
        roomB.registerCancellable("job.signal", async ({ signal }) => {
            handlerStarted();
            await waitForAbort(signal);
            handlerCancelled();
            return "late" as any;
        });
        const controller = new AbortController();
        const p = roomA.session("peer-b").call("job.signal", [], { signal: controller.signal, timeoutMs: 1000 });
        void p.catch(() => undefined);

        try {
            await started;
            controller.abort();
            await expect(p).rejects.toMatchObject({ code: "CANCELLED" });
            await cancelled;
            expect(responseSent).toBe(false);
        } finally {
            roomA.close();
            roomB.close();
            await p.catch(() => undefined);
        }
    });

    it("rejects promptly while request transport send is pending and cancels after it settles", async () => {
        let observeRequestSend!: () => void;
        const requestSendStarted = new Promise<void>((resolve) => {
            observeRequestSend = resolve;
        });
        let releaseRequestSend!: () => void;
        const requestSendReleased = new Promise<void>((resolve) => {
            releaseRequestSend = resolve;
        });
        const sentKinds: string[] = [];
        const transport = new MockTransport("peer-a");
        transport.send = (message) => {
            if (message.wire !== "raw") return;
            const kind = (JSON.parse(message.payload) as { kind?: string }).kind;
            if (!kind) return;
            sentKinds.push(kind);
            if (kind === "request") {
                observeRequestSend();
                return requestSendReleased;
            }
        };
        const room = new RpcRoom({ transport });
        const controller = new AbortController();
        const call = room
            .session("peer-b")
            .call("job.stalled-send", [], { signal: controller.signal, timeoutMs: 1000 });
        void call.catch(() => undefined);

        try {
            await requestSendStarted;
            controller.abort();
            const result = await Promise.race([
                call.then(
                    () => "resolved",
                    (error: unknown) => {
                        if (typeof error === "object" && error !== null && "code" in error) {
                            return String((error as { code: unknown }).code);
                        }
                        return error instanceof Error ? error.message : String(error);
                    }
                ),
                new Promise<string>((resolve) => setTimeout(() => resolve("still-pending"), 50)),
            ]);
            expect(result).toBe("CANCELLED");

            releaseRequestSend();
            await new Promise((resolve) => setTimeout(resolve, 0));
            expect(sentKinds).toEqual(["request", "cancel"]);
        } finally {
            releaseRequestSend();
            await call.catch(() => undefined);
            room.close();
        }
    });

    it("suppresses a late request transport rejection after cancellation", async () => {
        let observeRequestSend!: () => void;
        const requestSendStarted = new Promise<void>((resolve) => {
            observeRequestSend = resolve;
        });
        let rejectRequestSend!: (reason: unknown) => void;
        const requestSendRejected = new Promise<void>((_resolve, reject) => {
            rejectRequestSend = reject;
        });
        const transport = new MockTransport("peer-a");
        transport.send = (message) => {
            if (message.wire !== "raw") return;
            const kind = (JSON.parse(message.payload) as { kind?: string }).kind;
            if (kind === "request") {
                observeRequestSend();
                return requestSendRejected;
            }
        };
        const room = new RpcRoom({ transport });
        const controller = new AbortController();
        const call = room
            .session("peer-b")
            .call("job.rejected-send", [], { signal: controller.signal, timeoutMs: 1000 });
        void call.catch(() => undefined);

        try {
            await requestSendStarted;
            controller.abort();
            const result = await Promise.race([
                call.then(
                    () => "resolved",
                    (error: unknown) => {
                        if (typeof error === "object" && error !== null && "code" in error) {
                            return String((error as { code: unknown }).code);
                        }
                        return error instanceof Error ? error.message : String(error);
                    }
                ),
                new Promise<string>((resolve) => setTimeout(() => resolve("still-pending"), 50)),
            ]);
            expect(result).toBe("CANCELLED");
            rejectRequestSend(new Error("late request transport failure"));
            await new Promise((resolve) => setTimeout(resolve, 0));
        } finally {
            rejectRequestSend(new Error("test cleanup request transport failure"));
            await call.catch(() => undefined);
            room.close();
        }
    });

    it("keeps the inbound context alive while admission awaits", async () => {
        let admissionStarted!: () => void;
        const started = new Promise<void>((resolve) => {
            admissionStarted = resolve;
        });
        let releaseAdmission!: () => void;
        const admissionReleased = new Promise<void>((resolve) => {
            releaseAdmission = resolve;
        });
        let admissionSignal!: AbortSignal;
        let handlerCalled = false;
        const { roomA, roomB } = (() => {
            const tA = new MockTransport("peer-a");
            const tB = new MockTransport("peer-b");
            tA.attach(tB);
            tB.attach(tA);
            const roomA = new RpcRoom({ transport: tA });
            const roomB = new RpcRoom({
                transport: tB,
                canAcceptRequest: async (_peerId, _method, context) => {
                    admissionSignal = context.signal;
                    admissionStarted();
                    await admissionReleased;
                    return true;
                },
            });
            roomB.registerCancellable("job.admission", () => {
                handlerCalled = true;
                return "unexpected" as any;
            });
            return { roomA, roomB };
        })();
        const controller = new AbortController();
        const p = roomA.session("peer-b").call("job.admission", [], { signal: controller.signal, timeoutMs: 1000 });
        void p.catch(() => undefined);

        try {
            await started;
            controller.abort();
            await new Promise((resolve) => setTimeout(resolve, 0));
            expect(admissionSignal.aborted).toBe(true);
            releaseAdmission();
            await expect(p).rejects.toMatchObject({ code: "CANCELLED" });
            expect(handlerCalled).toBe(false);
        } finally {
            roomA.close();
            roomB.close();
            await p.catch(() => undefined);
        }
    });

    it("notifies a cancellation-aware handler when the caller times out", async () => {
        let handlerStarted!: () => void;
        const started = new Promise<void>((resolve) => {
            handlerStarted = resolve;
        });
        let handlerCancelled!: () => void;
        const cancelled = new Promise<void>((resolve) => {
            handlerCancelled = resolve;
        });
        let responseSent = false;
        const tA = new MockTransport("peer-a");
        const tB = new MockTransport("peer-b");
        tA.attach(tB);
        tB.attach(tA);
        const originalSend = tB.send.bind(tB);
        // eslint-disable-next-line @typescript-eslint/no-misused-promises
        tB.send = async (msg, peerId) => {
            if (msg.wire === "raw") {
                try {
                    if ((JSON.parse(msg.payload) as { kind?: string }).kind === "response") responseSent = true;
                } catch {
                    // ignore
                }
            }
            return await originalSend(msg, peerId);
        };
        const roomA = new RpcRoom({ transport: tA });
        const roomB = new RpcRoom({ transport: tB });
        roomB.registerCancellable("job.timeout", async ({ signal }) => {
            handlerStarted();
            await waitForAbort(signal);
            handlerCancelled();
            return "late" as any;
        });
        const p = roomA.session("peer-b").call("job.timeout", [], 25);
        void p.catch(() => undefined);

        try {
            await started;
            await expect(p).rejects.toMatchObject({ code: "TIMEOUT" });
            await cancelled;
            expect(responseSent).toBe(false);
        } finally {
            roomA.close();
            roomB.close();
            await p.catch(() => undefined);
        }
    });

    it("aborts cancellation-aware handlers when the room closes", async () => {
        let handlerStarted!: () => void;
        const started = new Promise<void>((resolve) => {
            handlerStarted = resolve;
        });
        let handlerCancelled!: () => void;
        const cancelled = new Promise<void>((resolve) => {
            handlerCancelled = resolve;
        });
        const { roomA, roomB } = createPair();
        roomB.registerCancellable("job.room-close", async ({ signal }) => {
            handlerStarted();
            await waitForAbort(signal);
            handlerCancelled();
            return "late" as any;
        });
        const p = roomA.session("peer-b").call("job.room-close", [], 1000);
        void p.catch(() => undefined);

        try {
            await started;
            roomB.close();
            await cancelled;
            roomA.close();
            await expect(p).rejects.toMatchObject({ code: "NOT_CONNECTED" });
        } finally {
            roomA.close();
            roomB.close();
            await p.catch(() => undefined);
        }
    });

    it("aborts cancellation-aware handlers when their peer leaves", async () => {
        let handlerStarted!: () => void;
        const started = new Promise<void>((resolve) => {
            handlerStarted = resolve;
        });
        let handlerCancelled!: () => void;
        const cancelled = new Promise<void>((resolve) => {
            handlerCancelled = resolve;
        });
        const tA = new MockTransport("peer-a");
        const tB = new MockTransport("peer-b");
        tA.attach(tB);
        tB.attach(tA);
        const roomA = new RpcRoom({ transport: tA });
        const roomB = new RpcRoom({ transport: tB });
        roomB.registerCancellable("job.peer-leave", async ({ signal }) => {
            handlerStarted();
            await waitForAbort(signal);
            handlerCancelled();
            return "late" as any;
        });
        const p = roomA.session("peer-b").call("job.peer-leave", [], 1000);
        void p.catch(() => undefined);

        try {
            await started;
            tB.detach();
            await cancelled;
            tA.detach();
            await expect(p).rejects.toMatchObject({ code: "NOT_CONNECTED" });
        } finally {
            roomA.close();
            roomB.close();
            await p.catch(() => undefined);
        }
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
