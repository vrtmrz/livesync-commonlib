import { afterEach, expect, it, vi } from "vitest";
import { RPC_VERSION_MAJOR, RPC_VERSION_MINOR } from "./types";
import {
    RpcError,
    RpcRoom,
    RpcSession,
    type RpcRoomOptions,
    type RpcWireMessage,
    type TransportAdapter,
} from "./index";

type RecordedMessage = { message: RpcWireMessage; peerId: string };
type ParsedEnvelope = Record<string, unknown> & { kind?: string };

class TestTransport implements TransportAdapter {
    readonly sent: RecordedMessage[] = [];
    peer?: TestTransport;
    receiveTransform?: (message: RpcWireMessage) => RpcWireMessage;
    sendCompletion?: Promise<void>;
    sendFailure?: unknown;
    private messageHandler?: (message: RpcWireMessage, peerId: string) => void;
    private leaveHandlers: Array<(peerId: string) => void> = [];

    constructor(readonly peerId: string) {}

    attach(peer: TestTransport) {
        this.peer = peer;
    }

    detach() {
        const peerId = this.peer?.peerId;
        this.peer = undefined;
        if (peerId) {
            this.leaveHandlers.forEach((handler) => handler(peerId));
        }
    }

    send(message: RpcWireMessage, peerId: string) {
        this.sent.push({ message, peerId });
        if (this.sendFailure !== undefined) {
            return Promise.reject(this.sendFailure);
        }
        this.peer?.receive(message, this.peerId);
        return this.sendCompletion;
    }

    onMessage(handler: (message: RpcWireMessage, peerId: string) => void) {
        this.messageHandler = handler;
        return () => {
            if (this.messageHandler === handler) {
                this.messageHandler = undefined;
            }
        };
    }

    onPeerLeave(handler: (peerId: string) => void) {
        this.leaveHandlers.push(handler);
        return () => {
            this.leaveHandlers = this.leaveHandlers.filter((candidate) => candidate !== handler);
        };
    }

    receive(message: RpcWireMessage, peerId: string) {
        this.messageHandler?.(this.receiveTransform?.(message) ?? message, peerId);
    }
}

const rooms: RpcRoom[] = [];

function makeRoom(options: RpcRoomOptions) {
    const room = new RpcRoom(options);
    rooms.push(room);
    return room;
}

function createPair(
    roomAOptions: Omit<RpcRoomOptions, "transport"> = {},
    roomBOptions: Omit<RpcRoomOptions, "transport"> = {}
) {
    const transportA = new TestTransport("peer-a");
    const transportB = new TestTransport("peer-b");
    transportA.attach(transportB);
    transportB.attach(transportA);
    const roomA = makeRoom({ ...roomAOptions, transport: transportA });
    const roomB = makeRoom({ ...roomBOptions, transport: transportB });
    return { transportA, transportB, roomA, roomB };
}

function parseRawEnvelope(message: RpcWireMessage): ParsedEnvelope | undefined {
    if (message.wire !== "raw") return undefined;
    return JSON.parse(message.payload) as ParsedEnvelope;
}

function responses(transport: TestTransport) {
    return transport.sent.filter(({ message }) => parseRawEnvelope(message)?.kind === "response");
}

function roomState(room: RpcRoom) {
    return room as unknown as {
        inboundCalls: Map<string, unknown>;
        outgoingChunkMap: Map<string, unknown>;
    };
}

function flushMessages() {
    return new Promise<void>((resolve) => setImmediate(resolve));
}

afterEach(() => {
    rooms.splice(0).forEach((room) => room.close());
    vi.restoreAllMocks();
    vi.useRealTimers();
});

it("suppresses the RPC response for a request marked as a notification", async () => {
    const transport = new TestTransport("peer-b");
    const warnings: string[] = [];
    const room = makeRoom({ transport, onProtocolWarning: (message) => warnings.push(message) });
    room.register("events.changed", () => "processed");

    transport.receive(
        {
            wire: "raw",
            payload: JSON.stringify({
                kind: "request",
                requestId: "notify-1",
                method: "events.changed",
                args: [],
                expectsResponse: false,
            }),
        },
        "peer-a"
    );
    await flushMessages();

    expect(responses(transport)).toEqual([]);
    expect(warnings).toEqual([]);
    expect(roomState(room).inboundCalls.size).toBe(0);
});

it("settles only after transport send and creates no response wait", async () => {
    vi.useFakeTimers();
    const transport = new TestTransport("peer-a");
    let finishSend!: () => void;
    transport.sendCompletion = new Promise<void>((resolve) => {
        finishSend = resolve;
    });
    const room = makeRoom({ transport });
    let settled = false;

    const notification = room
        .session("peer-b")
        .notify("events.changed")
        .then(() => {
            settled = true;
        });
    const request = parseRawEnvelope(transport.sent[0].message);
    expect(request).toMatchObject({ kind: "request", method: "events.changed", args: [], expectsResponse: false });
    expect(request?.requestId).toEqual(expect.any(String));
    expect(vi.getTimerCount()).toBe(0);
    await Promise.resolve();
    expect(settled).toBe(false);

    finishSend();
    await notification;
    expect(settled).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
});

it("does not wait for a long remote handler or block a later notification", async () => {
    const { transportB, roomA, roomB } = createPair();
    let firstStarted!: () => void;
    let secondStarted!: () => void;
    let releaseFirst!: () => void;
    const firstHandlerStarted = new Promise<void>((resolve) => {
        firstStarted = resolve;
    });
    const secondHandlerStarted = new Promise<void>((resolve) => {
        secondStarted = resolve;
    });
    const firstHandlerGate = new Promise<void>((resolve) => {
        releaseFirst = resolve;
    });
    roomB.register("events.changed", async (_peerId, sequence): Promise<null> => {
        if (sequence === 1) {
            firstStarted();
            await firstHandlerGate;
        } else {
            secondStarted();
        }
        return null;
    });

    const first = roomA.session("peer-b").notify("events.changed", [1]);
    await first;
    await firstHandlerStarted;

    await roomA.session("peer-b").notify("events.changed", [2]);
    await secondHandlerStarted;
    await flushMessages();
    expect(responses(transportB)).toEqual([]);

    releaseFirst();
    await flushMessages();
    expect(responses(transportB)).toEqual([]);
    expect(roomState(roomB).inboundCalls.size).toBe(0);
});

it("settles when the receiver denies admission without waiting for a response", async () => {
    const { transportB, roomA, roomB } = createPair({}, { canAcceptRequest: () => false });
    let handlerCalled = false;
    roomB.register("events.changed", (): null => {
        handlerCalled = true;
        return null;
    });

    await expect(roomA.session("peer-b").notify("events.changed")).resolves.toBeUndefined();
    await flushMessages();

    expect(handlerCalled).toBe(false);
    expect(responses(transportB)).toEqual([]);
});

it("rejects when the transport send fails", async () => {
    const transport = new TestTransport("peer-a");
    const failure = new Error("transport failed");
    transport.sendFailure = failure;
    const room = makeRoom({ transport });

    await expect(room.session("peer-b").notify("events.changed")).rejects.toBe(failure);
});

it.each(["admission exception", "protocol version mismatch", "missing method", "handler exception"] as const)(
    "does not send an RPC response or log arguments for a notification with %s",
    async (failure) => {
        const warnings: string[] = [];
        const transport = new TestTransport("peer-b");
        const roomOptions: RpcRoomOptions = {
            transport,
            onProtocolWarning: (message) => warnings.push(message),
        };
        if (failure === "admission exception") {
            roomOptions.canAcceptRequest = () => {
                throw new Error("credential-bearing diagnostic");
            };
        }
        const room = makeRoom(roomOptions);
        if (failure !== "missing method") {
            room.register("events.changed", (): null => {
                if (failure === "handler exception") {
                    throw new Error("credential-bearing diagnostic");
                }
                return null;
            });
        }
        if (failure === "protocol version mismatch") {
            transport.receive(
                { wire: "raw", payload: JSON.stringify({ kind: "handshake", versionMajor: 2, versionMinor: 0 }) },
                "peer-a"
            );
        }
        transport.receive(
            {
                wire: "raw",
                payload: JSON.stringify({
                    kind: "request",
                    requestId: "notify-error-1",
                    method: "events.changed",
                    args: ["private payload"],
                    expectsResponse: false,
                }),
            },
            "peer-a"
        );
        await flushMessages();

        expect(responses(transport)).toEqual([]);
        expect(warnings.some((message) => message.includes("events.changed"))).toBe(true);
        expect(warnings.join(" ")).not.toContain("private payload");
        expect(warnings.join(" ")).not.toContain("credential-bearing diagnostic");
        expect(roomState(room).inboundCalls.size).toBe(0);
    }
);

it("warns on a minor-version mismatch while processing a notification without replying", async () => {
    const transport = new TestTransport("peer-b");
    const warnings: string[] = [];
    const room = makeRoom({ transport, onProtocolWarning: (message) => warnings.push(message) });
    const handler = vi.fn((_peerId: string, _value: string) => "processed");
    room.register("events.changed", handler);
    transport.receive(
        {
            wire: "raw",
            payload: JSON.stringify({
                kind: "handshake",
                versionMajor: RPC_VERSION_MAJOR,
                versionMinor: RPC_VERSION_MINOR + 1,
            }),
        },
        "peer-a"
    );
    transport.receive(
        {
            wire: "raw",
            payload: JSON.stringify({
                kind: "request",
                requestId: "minor-notify",
                method: "events.changed",
                args: ["private argument"],
                expectsResponse: false,
            }),
        },
        "peer-a"
    );
    await flushMessages();

    expect(handler).toHaveBeenCalledExactlyOnceWith("peer-a", "private argument");
    expect(responses(transport)).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("protocol minor version mismatch");
    expect(warnings[0]).toContain("events.changed");
    expect(warnings[0]).not.toContain("private argument");
});

it("keeps request cleanup intact when the notification warning callback throws", async () => {
    const transport = new TestTransport("peer-b");
    const room = makeRoom({
        transport,
        onProtocolWarning: () => {
            throw new Error("observer failed");
        },
    });
    transport.receive(
        {
            wire: "raw",
            payload: JSON.stringify({
                kind: "request",
                requestId: "notify-observer-1",
                method: "events.missing",
                args: [],
                expectsResponse: false,
            }),
        },
        "peer-a"
    );
    await flushMessages();

    expect(responses(transport)).toEqual([]);
    expect(roomState(room).inboundCalls.size).toBe(0);
});

it("keeps ordinary calls response-bearing when the optional flag is omitted", async () => {
    const { transportA, transportB, roomA, roomB } = createPair();
    roomB.register("events.lookup", (_peerId, value) => value);

    await expect(roomA.session("peer-b").call("events.lookup", ["result"], 1000)).resolves.toBe("result");

    const request = transportA.sent
        .map(({ message }) => parseRawEnvelope(message))
        .find((envelope) => envelope?.kind === "request");
    expect(request).toMatchObject({ kind: "request", method: "events.lookup" });
    expect(request).not.toHaveProperty("expectsResponse");
    expect(responses(transportB)).toHaveLength(1);
});

it("interoperates with a simulated 0.4.3 receiver that ignores the optional flag", async () => {
    const { transportA, transportB, roomA, roomB } = createPair();
    transportB.receiveTransform = (message) => {
        const envelope = parseRawEnvelope(message);
        if (envelope?.kind !== "request" || envelope.expectsResponse !== false) return message;
        delete envelope.expectsResponse;
        return { wire: "raw", payload: JSON.stringify(envelope) };
    };
    roomB.register("events.changed", () => "legacy response");

    await expect(roomA.session("peer-b").notify("events.changed")).resolves.toBeUndefined();
    await flushMessages();

    expect(responses(transportB)).toHaveLength(1);
    expect(roomState(roomA).inboundCalls.size).toBe(0);
});

it("retains chunk acknowledgements and handler processing for large notifications", async () => {
    const { transportA, transportB, roomA, roomB } = createPair(
        { maxWirePayloadBytes: 128, chunkMissingRetryMs: 20 },
        { maxWirePayloadBytes: 128, chunkMissingRetryMs: 20 }
    );
    const payload = "x".repeat(3000);
    let received: unknown;
    roomB.register("events.large", (_peerId, value) => {
        received = value;
        return "processed";
    });

    await roomA.session("peer-b").notify("events.large", [payload]);
    await flushMessages();

    expect(received).toBe(payload);
    expect(transportA.sent.some(({ message }) => message.wire === "chunk")).toBe(true);
    expect(transportB.sent.some(({ message }) => message.wire === "chunk-ack" && message.missing.length === 0)).toBe(
        true
    );
    expect(responses(transportB)).toEqual([]);
    expect(roomState(roomA).outgoingChunkMap.size).toBe(0);
});

it.each(["peer leaves", "room closes"] as const)(
    "retains notification context and abort cleanup when the %s",
    async (lifecycle) => {
        const { transportB, roomA, roomB } = createPair();
        let receivedSignal: AbortSignal | undefined;
        let handlerStarted!: () => void;
        const started = new Promise<void>((resolve) => {
            handlerStarted = resolve;
        });
        roomB.registerCancellable("events.wait", async (context): Promise<null> => {
            receivedSignal = context.signal;
            handlerStarted();
            await new Promise<void>((resolve) => {
                context.signal.addEventListener("abort", () => resolve(), { once: true });
            });
            return null;
        });

        await roomA.session("peer-b").notify("events.wait");
        await started;
        expect(roomState(roomB).inboundCalls.size).toBe(1);
        expect(receivedSignal?.aborted).toBe(false);

        if (lifecycle === "peer leaves") {
            transportB.detach();
        } else {
            roomB.close();
        }
        await flushMessages();

        expect(receivedSignal?.aborted).toBe(true);
        expect(roomState(roomB).inboundCalls.size).toBe(0);
    }
);

it("validates method, room, and session peer before sending", async () => {
    const transport = new TestTransport("peer-a");
    const room = makeRoom({ transport });

    await expect(room.notify("peer-b", "invalid", [])).rejects.toMatchObject({ code: "PROTOCOL_ERROR" });
    await expect(new RpcSession(room, "").notify("events.changed")).rejects.toMatchObject({
        code: "NOT_CONNECTED",
    });
    room.close();
    await expect(room.notify("peer-b", "events.changed", [])).rejects.toMatchObject({
        code: "NOT_CONNECTED",
    });
    await expect(room.session("peer-b").notify("events.changed")).rejects.toBeInstanceOf(RpcError);
    expect(transport.sent).toEqual([]);
});
