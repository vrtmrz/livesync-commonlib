import { describe, expect, it, vi } from "vitest";
import { RpcRoom, type RpcWireMessage, type TransportAdapter } from "./index";
import { RpcSession } from "./RpcSession";
import { RpcError } from "./errors";

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

function readRawEnvelope(message: RpcWireMessage) {
    if (message.wire !== "raw") return undefined;
    return JSON.parse(message.payload) as { kind?: string; method?: string; requestId?: string };
}

function flushUnhandledRejectionEvents() {
    return new Promise<void>((resolve) => setImmediate(resolve));
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

    it("rejects a call after close without sending a request", async () => {
        const transport = new MockTransport("peer-a");
        const send = vi.spyOn(transport, "send");
        const room = new RpcRoom({ transport });
        room.close();

        await expect(room.invoke("peer-b", "job.run", [])).rejects.toMatchObject({ code: "NOT_CONNECTED" });
        expect(send).not.toHaveBeenCalled();
    });

    it.each([true, false])(
        "keeps cancellation failure local with a warning handler present: %s",
        async (reportWarning) => {
            const transport = new MockTransport("peer-a");
            let cancelSends = 0;
            transport.send = async (message) => {
                if (readRawEnvelope(message)?.kind === "cancel") {
                    cancelSends++;
                    throw new Error("cancel transport failed");
                }
            };
            const warnings: Array<{ message: string; peerId: string }> = [];
            const room = new RpcRoom({
                transport,
                ...(reportWarning
                    ? {
                          onProtocolWarning: (message: string, peerId: string) => {
                              warnings.push({ message, peerId });
                          },
                      }
                    : {}),
            });
            const controller = new AbortController();
            try {
                const pending = room.session("peer-b").call("job.wait", [], { signal: controller.signal });
                const rejected = expect(pending).rejects.toMatchObject({ code: "CANCELLED" });
                controller.abort();
                await rejected;
                await flushUnhandledRejectionEvents();

                expect(cancelSends).toBe(1);
                expect(warnings).toEqual(
                    reportWarning
                        ? [
                              {
                                  message: "Failed to send RPC cancellation: Error: cancel transport failed",
                                  peerId: "peer-b",
                              },
                          ]
                        : []
                );
            } finally {
                room.close();
            }
        }
    );

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

    it.each(["admission", "handler"] as const)("preserves a structured error from %s", async (source) => {
        const tA = new MockTransport("peer-a");
        const tB = new MockTransport("peer-b");
        tA.attach(tB);
        tB.attach(tA);
        const failure = new RpcError("PROTOCOL_ERROR", "Rejected operation", { reason: "fixture" });
        const roomA = new RpcRoom({ transport: tA });
        const roomB = new RpcRoom({
            transport: tB,
            canAcceptRequest: () => {
                if (source === "admission") throw failure;
                return true;
            },
        });
        roomB.register("job.reject", () => {
            throw failure;
        });
        try {
            await expect(roomA.invoke("peer-b", "job.reject", [], 1000)).rejects.toMatchObject({
                code: failure.code,
                message: failure.message,
                details: failure.details,
            });
        } finally {
            roomA.close();
            roomB.close();
        }
    });

    it("keeps serial execution ordered after an error and skips a cancelled queued call", async () => {
        const { roomA, roomB } = createPair();
        let releaseFirst!: () => void;
        const firstReleased = new Promise<void>((resolve) => {
            releaseFirst = resolve;
        });
        let observeFirst!: () => void;
        const firstStarted = new Promise<void>((resolve) => {
            observeFirst = resolve;
        });
        const calls: string[] = [];
        roomB.registerCancellable(
            "job.serial",
            async (_context, peerId, value) => {
                expect(peerId).toBe("peer-a");
                calls.push(String(value));
                if (value === "first") {
                    observeFirst();
                    await firstReleased;
                    throw new Error("First operation failed");
                }
                return value;
            },
            { serial: true }
        );
        const first = roomA.invoke("peer-b", "job.serial", ["first"], 1000);
        const firstRejected = expect(first).rejects.toMatchObject({
            code: "REMOTE_ERROR",
            message: "First operation failed",
        });
        try {
            await firstStarted;
            const controller = new AbortController();
            const second = roomA.invoke("peer-b", "job.serial", ["cancelled"], {
                signal: controller.signal,
                timeoutMs: 1000,
            });
            const secondRejected = expect(second).rejects.toMatchObject({ code: "CANCELLED" });
            const third = roomA.invoke("peer-b", "job.serial", ["third"], 1000);
            controller.abort();
            await secondRejected;
            expect(calls).toEqual(["first"]);
            releaseFirst();
            await firstRejected;
            await expect(third).resolves.toBe("third");
            expect(calls).toEqual(["first", "third"]);
        } finally {
            releaseFirst();
            roomA.close();
            roomB.close();
            await firstRejected;
        }
    });

    it("resends the original chunk to its peer in the requested order and ignores unknown indices", async () => {
        const { tA, tB, roomA, roomB } = createPair();
        const chunks: Array<{ message: Extract<RpcWireMessage, { wire: "chunk" }>; peerId: string }> = [];
        tA.send = (message, peerId) => {
            if (message.wire === "chunk") chunks.push({ message, peerId });
        };
        const call = roomA.invoke("peer-b", "echo.large", ["x".repeat(500)], 0);
        const rejected = expect(call).rejects.toMatchObject({ code: "NOT_CONNECTED" });
        try {
            await new Promise((resolve) => setTimeout(resolve, 0));
            const original = [...chunks];
            expect(original.length).toBeGreaterThan(2);
            expect(original.map(({ message }) => message.index)).toEqual(original.map((_, index) => index));
            const streamId = original[0].message.streamId;
            const last = original.length - 1;
            tB.send({ wire: "chunk-ack", streamId, missing: [last, -1, 0, original.length] }, "peer-a");
            await new Promise((resolve) => setTimeout(resolve, 0));
            expect(chunks.slice(original.length)).toEqual([original[last], original[0]]);
            expect(chunks.every(({ peerId }) => peerId === "peer-b")).toBe(true);
        } finally {
            roomA.close();
            roomB.close();
            await rejected;
        }
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

    it.each(["admission", "handler"] as const)(
        "consumes a late %s rejection after caller cancellation and keeps the room usable",
        async (rejectionSource) => {
            let workStarted!: () => void;
            const started = new Promise<void>((resolve) => {
                workStarted = resolve;
            });
            let rejectWork!: (reason: unknown) => void;
            const workGate = new Promise<void>((_resolve, reject) => {
                rejectWork = reject;
            });

            const tA = new MockTransport("peer-a");
            const tB = new MockTransport("peer-b");
            tA.attach(tB);
            tB.attach(tA);
            const cancelledMethod = `job.${rejectionSource}-reject-after-cancel`;
            let cancelledRequestId: string | undefined;
            const responseRequestIds: string[] = [];
            const sendA = tA.send.bind(tA);
            tA.send = (message, peerId) => {
                const envelope = readRawEnvelope(message);
                if (envelope?.kind === "request" && envelope.method === cancelledMethod && !cancelledRequestId) {
                    cancelledRequestId = envelope.requestId;
                }
                return sendA(message, peerId);
            };
            const sendB = tB.send.bind(tB);
            tB.send = (message, peerId) => {
                const envelope = readRawEnvelope(message);
                if (envelope?.kind === "response" && envelope.requestId) responseRequestIds.push(envelope.requestId);
                return sendB(message, peerId);
            };

            let inboundSignal!: AbortSignal;
            let admissionCalls = 0;
            let handlerCalls = 0;
            const roomA = new RpcRoom({ transport: tA });
            const roomB = new RpcRoom({
                transport: tB,
                canAcceptRequest: async (_peerId, method, context) => {
                    if (rejectionSource === "admission" && method === cancelledMethod && admissionCalls++ === 0) {
                        inboundSignal = context.signal;
                        workStarted();
                        await workGate;
                    }
                    return true;
                },
            });
            roomB.registerCancellable(cancelledMethod, async ({ signal }) => {
                handlerCalls++;
                if (rejectionSource === "handler" && handlerCalls === 1) {
                    inboundSignal = signal;
                    workStarted();
                    await workGate;
                }
                return "usable";
            });

            const controller = new AbortController();
            const cancelledCall = roomA
                .session("peer-b")
                .call(cancelledMethod, [], { signal: controller.signal, timeoutMs: 1000 });
            void cancelledCall.catch(() => undefined);
            let usableCall: Promise<unknown> | undefined;

            try {
                await started;
                controller.abort();
                await expect(cancelledCall).rejects.toMatchObject({ code: "CANCELLED" });
                expect(inboundSignal.aborted).toBe(true);

                rejectWork(new Error(`late ${rejectionSource} rejection`));
                usableCall = roomA.session("peer-b").call(cancelledMethod, [], 1000);
                await expect(usableCall).resolves.toBe("usable");
                await flushUnhandledRejectionEvents();

                expect(cancelledRequestId).toBeDefined();
                expect(responseRequestIds).toHaveLength(1);
                expect(responseRequestIds).not.toContain(cancelledRequestId);
                expect(handlerCalls).toBe(rejectionSource === "admission" ? 1 : 2);
            } finally {
                rejectWork(new Error(`test cleanup ${rejectionSource} rejection`));
                roomA.close();
                roomB.close();
                await cancelledCall.catch(() => undefined);
                await usableCall?.catch(() => undefined);
            }
        }
    );

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
        expect(Reflect.get(proxy, Symbol.iterator)).toBeUndefined();

        const session = new RpcSession(roomA, "");
        await expect(session.call("math.mul", [1 as any, 2 as any], 10)).rejects.toMatchObject({
            code: "NOT_CONNECTED",
        });
        roomA.close();
        roomB.close();
    });
});
