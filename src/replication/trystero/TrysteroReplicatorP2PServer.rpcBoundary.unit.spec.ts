import { afterEach, describe, expect, it, vi } from "vitest";
import PouchDB from "pouchdb-core";
import MemoryAdapter from "pouchdb-adapter-memory";

import { AutoAccepting, DEFAULT_SETTINGS, type P2PSyncSetting } from "@lib/common/types";
import { defaultLogger, setGlobalLogFunction } from "@lib/common/logger";
import { createLiveSyncEventHub } from "@lib/hub/hub";
import type { Confirm } from "@lib/interfaces/Confirm";
import type { SimpleStore } from "@lib/common/utils";
import type { JoinError, Room, joinRoom } from "@trystero-p2p/nostr";
import { passthroughMessageTranslator } from "@lib/services/base/MessageTranslator";
import {
    exposeDB,
    RpcError,
    RpcPouchDBProxy,
    RpcRoom,
    RpcSession,
    type RpcEnvelope,
    type RpcWireMessage,
} from "@lib/rpc";
import { RpcRoom as FancyKitRpcRoom, RpcSession as FancyKitRpcSession } from "@vrtmrz/rpc/p2p";
import type { P2PDiagnosticEvent } from "@lib/p2p/p2pDiagnostics";

import {
    EVENT_ADVERTISEMENT_RECEIVED,
    EVENT_DEVICE_LEAVED,
    EVENT_SERVER_STATUS,
    TrysteroReplicatorP2PServer,
} from "./TrysteroReplicatorP2PServer";
import type { BindableObject, ReplicatorHostEnv } from "./types";

PouchDB.plugin(MemoryAdapter);

type FakeActionHandler = (data: unknown, context: { peerId: string }) => void | Promise<void>;
type FakeAction = {
    onMessage: FakeActionHandler | null;
    send(data: unknown, options?: { target?: string }): Promise<void>;
};

/** Minimal external Room boundary which routes named actions to a paired peer. */
class FakeTrysteroRoom {
    peer?: FakeTrysteroRoom;
    onPeerJoin: ((peerId: string) => void) | null = null;
    onPeerLeave: ((peerId: string) => void) | null = null;
    readonly sent: Array<{ action: string; message: unknown; target?: string }> = [];
    readonly actionHandlers = new Map<string, FakeAction>();
    readonly leave = vi.fn(async () => undefined);
    onSend?: (action: string, message: unknown) => void;

    constructor(readonly id: string) {}

    makeAction<T>(name: string) {
        const action: FakeAction = {
            onMessage: null,
            send: async (message: unknown, options?: { target?: string }) => {
                this.sent.push({ action: name, message, target: options?.target });
                this.onSend?.(name, message);
                const peer = this.peer;
                if (!peer || (options?.target && options.target !== peer.id)) {
                    return;
                }
                await peer.actionHandlers.get(name)?.onMessage?.(message, { peerId: this.id });
            },
        };
        this.actionHandlers.set(name, action);
        return action as unknown as {
            onMessage: ((data: T, context: { peerId: string }) => void | Promise<void>) | null;
            send(data: T, options?: { target?: string }): Promise<void>;
        };
    }

    getPeers(): Record<string, RTCPeerConnection> {
        return {};
    }

    triggerPeerLeave(peerId: string) {
        this.onPeerLeave?.(peerId);
    }

    triggerPeerJoin(peerId: string) {
        this.onPeerJoin?.(peerId);
    }

    action(name: string) {
        return this.actionHandlers.get(name);
    }
}

const hosts: TrysteroReplicatorP2PServer[] = [];

afterEach(async () => {
    await Promise.all(
        hosts.splice(0).map(async (host) => {
            try {
                await host.shutdown();
            } finally {
                host.dispose();
            }
        })
    );
});

function asTrysteroRoom(room: FakeTrysteroRoom): Room {
    // This is the sole assertion at the external Room seam; the fake implements the Room methods used here.
    return room as unknown as Room;
}

function createRoomFactory(room: FakeTrysteroRoom) {
    return vi.fn<typeof joinRoom>(() => asTrysteroRoom(room));
}

function makeEnvironment(
    deviceName: string,
    overrides: Partial<P2PSyncSetting> = {},
    reportDiagnostic?: ReplicatorHostEnv["reportDiagnostic"]
): ReplicatorHostEnv {
    const values = new Map<string, unknown>();
    const simpleStore: SimpleStore<unknown> = {
        db: undefined,
        get: async (key) => values.get(key),
        set: async (key, value) => {
            values.set(key, value);
        },
        delete: async (key) => {
            values.delete(key);
        },
        keys: async () => [...values.keys()],
    };
    const confirm: Confirm = {
        askYesNo: async () => "no",
        askString: async () => false,
        askYesNoDialog: async () => "no",
        askSelectString: async (_message, items) => items[0] ?? "",
        askSelectStringDialogue: async <T extends readonly string[]>(
            _message: string,
            _buttons: T,
            options: { title?: string; defaultAction: T[number]; timeout?: number }
        ) => options.defaultAction,
        askInPopup: () => undefined,
        confirmWithMessage: async (_title, _content, _buttons, defaultAction) => defaultAction,
    };
    const settings: P2PSyncSetting = {
        ...DEFAULT_SETTINGS,
        P2P_Enabled: true,
        P2P_AutoAccepting: AutoAccepting.ALL,
        P2P_IsHeadless: true,
        P2P_roomID: "rpc-boundary-room",
        P2P_passphrase: "rpc-boundary-passphrase",
        P2P_relays: "wss://relay.example.test",
        P2P_AppID: "rpc-boundary-test",
        ...overrides,
    };

    return {
        deviceName,
        platform: "test",
        confirm,
        events: createLiveSyncEventHub(),
        translate: passthroughMessageTranslator,
        settings,
        ...(reportDiagnostic !== undefined ? { reportDiagnostic } : {}),
        // createHostingDB only wraps these bindings in this boundary test; no database operation is invoked.
        db: {} as unknown as ReplicatorHostEnv["db"],
        simpleStore,
        processReplicatedDocs: async () => undefined,
    } satisfies ReplicatorHostEnv;
}

function createHost(env: ReplicatorHostEnv, peerId: string, createRoom: typeof joinRoom) {
    const host = new TrysteroReplicatorP2PServer(env, peerId, { createRoom });
    hosts.push(host);
    return host;
}

async function createConnectedPair(
    registerTargetService: (target: TrysteroReplicatorP2PServer) => void,
    targetBindings: BindableObject[] = [],
    advertiseCaller = true
) {
    const callerRoom = new FakeTrysteroRoom("caller-peer");
    const targetRoom = new FakeTrysteroRoom("target-peer");
    callerRoom.peer = targetRoom;
    targetRoom.peer = callerRoom;

    const caller = createHost(makeEnvironment("Caller"), callerRoom.id, createRoomFactory(callerRoom));
    const target = createHost(makeEnvironment("Target"), targetRoom.id, createRoomFactory(targetRoom));

    await caller.start();
    await target.start(targetBindings, () => registerTargetService(target));
    if (advertiseCaller) {
        caller.sendAdvertisement(target.serverPeerId);
    }

    return { caller, target, callerRoom, targetRoom };
}

function parseRpcEnvelope(message: unknown): RpcEnvelope | undefined {
    if (typeof message !== "object" || message === null || !("wire" in message)) {
        return undefined;
    }
    const wireMessage = message as RpcWireMessage;
    if (wireMessage.wire !== "raw") {
        return undefined;
    }
    try {
        return JSON.parse(wireMessage.payload) as RpcEnvelope;
    } catch {
        return undefined;
    }
}

function rpcEnvelopes(room: FakeTrysteroRoom) {
    return room.sent
        .filter(({ action }) => action === "rpc2")
        .map(({ message }) => parseRpcEnvelope(message))
        .filter((envelope): envelope is RpcEnvelope => envelope !== undefined);
}

function deferred<T = void>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    const promise = new Promise<T>((resolvePromise) => {
        resolve = resolvePromise;
    });
    return { promise, resolve };
}

function waitForAbort(signal: AbortSignal) {
    if (signal.aborted) {
        return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
        signal.addEventListener("abort", () => resolve(), { once: true });
    });
}

function flushQueuedCallbacks() {
    return new Promise<void>((resolve) => setImmediate(resolve));
}

describe("TrysteroReplicatorP2PServer RPC boundaries", () => {
    it("starts with the session room configuration and registers services before advertising", async () => {
        const callerRoom = new FakeTrysteroRoom("caller-peer");
        const targetRoom = new FakeTrysteroRoom("target-peer");
        callerRoom.peer = targetRoom;
        targetRoom.peer = callerRoom;

        const targetSnapshot: P2PSyncSetting = {
            ...DEFAULT_SETTINGS,
            P2P_Enabled: true,
            P2P_AutoAccepting: AutoAccepting.ALL,
            P2P_IsHeadless: true,
            P2P_roomID: "snapshot-room",
            P2P_passphrase: "snapshot-passphrase",
            P2P_relays: "wss://snapshot-relay.example.test",
            P2P_AppID: "snapshot-app",
        };
        const targetEnv = makeEnvironment("Target", targetSnapshot);
        targetEnv.currentSettings = () => ({
            ...targetSnapshot,
            P2P_roomID: "later-room",
            P2P_passphrase: "later-passphrase",
            P2P_relays: "wss://later-relay.example.test",
            P2P_AppID: "later-app",
        });
        const caller = createHost(makeEnvironment("Caller"), callerRoom.id, createRoomFactory(callerRoom));
        const targetFactory = createRoomFactory(targetRoom);
        const target = createHost(targetEnv, targetRoom.id, targetFactory);
        const order: string[] = [];
        targetRoom.onSend = (action) => order.push(`send:${action}`);
        const objectMethod = vi.fn((value: string) => `object:${value}`);
        const bindings = [{ echo: objectMethod }];
        const beforeAdvertisement = vi.fn(() => {
            target.serveCancellationAwareFunction<[string], string>("ready", async (_context, _peerId, value) => {
                return `ready:${value}`;
            });
            order.push("before-advertisement");
        });

        await caller.start();
        await target.start(bindings, beforeAdvertisement);

        expect(target.serverPeerId).toBe("target-peer");
        expect(targetFactory).toHaveBeenCalledOnce();
        const [joinOptions, joinedRoomId, joinCallbacks] = targetFactory.mock.calls[0];
        expect(joinOptions).toMatchObject({
            appId: "snapshot-app",
            relayConfig: { manualReconnection: true, urls: ["wss://snapshot-relay.example.test"] },
        });
        expect(joinOptions.password).not.toBe("later-passphrase");
        expect(joinedRoomId).toBe("snapshot-room");
        expect(joinCallbacks).toMatchObject({ handshakeTimeoutMs: 30000, onJoinError: expect.any(Function) });
        expect(order).toEqual(["before-advertisement", "send:ad"]);

        caller.sendAdvertisement(target.serverPeerId);
        const client = caller.getConnection(target.serverPeerId);
        await expect(client.invokeRemoteFunction("echo", ["value"])).resolves.toBe("object:value");
        await expect(client.invokeRemoteFunction("ready", ["value"])).resolves.toBe("ready:value");
        expect(objectMethod).toHaveBeenCalledExactlyOnceWith("value");
    });

    it("does not emit status after disposal while persisted peer decisions are still loading", async () => {
        const env = makeEnvironment("Target");
        const room = new FakeTrysteroRoom("target-peer");
        const host = createHost(env, room.id, createRoomFactory(room));
        const status = vi.fn();
        const pendingDecision = deferred<boolean | undefined>();
        const getPersistedDecision = vi.spyOn(env.simpleStore, "get").mockReturnValue(pendingDecision.promise);
        env.events.onEvent(EVENT_SERVER_STATUS, status);

        host.onAdvertisement({ peerId: "caller-peer", name: "Caller", platform: "test" }, "caller-peer");
        const pendingStatus = host.dispatchConnectionStatus();

        expect(getPersistedDecision).toHaveBeenCalled();
        expect(status).not.toHaveBeenCalled();
        host.dispose();
        pendingDecision.resolve(undefined);
        await pendingStatus;
        await flushQueuedCallbacks();

        expect(status).not.toHaveBeenCalled();
    });

    it("keeps replacement session handlers when an older disposer runs", async () => {
        const room = new FakeTrysteroRoom("target-peer");
        const host = createHost(makeEnvironment("Target"), room.id, createRoomFactory(room));
        const firstHandlers = { onAdvertisement: vi.fn(), onPeerLeft: vi.fn() };
        const replacementHandlers = { onAdvertisement: vi.fn(), onPeerLeft: vi.fn() };
        const disposeFirstHandlers = host.setSessionPeerHandlers(firstHandlers);
        host.setSessionPeerHandlers(replacementHandlers);

        disposeFirstHandlers();
        host.onAdvertisement({ peerId: "caller-peer", name: "Caller", platform: "test" }, "caller-peer");
        await flushQueuedCallbacks();

        expect(firstHandlers.onAdvertisement).not.toHaveBeenCalled();
        expect(replacementHandlers.onAdvertisement).toHaveBeenCalledExactlyOnceWith({
            peerId: "caller-peer",
            name: "Caller",
            platform: "test",
        });
    });

    it("allows an unknown peer to request authentication while rejecting its ordinary RPC calls", async () => {
        const requestAuthentication = vi.fn(() => "authentication allowed");
        const ordinaryMethod = vi.fn(() => "ordinary result");
        const { caller, target } = await createConnectedPair(
            () => undefined,
            [{ "!reqAuth": requestAuthentication, ordinary: ordinaryMethod }],
            false
        );

        expect(target.knownAdvertisements).not.toContainEqual(expect.objectContaining({ peerId: caller.serverPeerId }));
        const client = caller.getConnection(target.serverPeerId);
        await expect(client.invokeRemoteFunction("!reqAuth", [], 1000)).resolves.toBe("authentication allowed");
        await expect(client.invokeRemoteFunction("ordinary", [], 25)).rejects.toMatchObject({ code: "TIMEOUT" });

        expect(requestAuthentication).toHaveBeenCalledOnce();
        expect(ordinaryMethod).not.toHaveBeenCalled();
    });

    it("keeps disabled startup and service calls from joining or advertising", async () => {
        const room = new FakeTrysteroRoom("disabled-peer");
        const createRoom = createRoomFactory(room);
        const env = makeEnvironment("Disabled", { P2P_Enabled: false });
        const host = createHost(env, room.id, createRoom);
        const sendAdvertisement = vi.fn(async () => undefined);
        const beforeAdvertisement = vi.fn();
        const advertisementReceived = vi.fn();
        const binding = { run: vi.fn() };
        host._sendAdvertisement = sendAdvertisement;
        env.events.onEvent(EVENT_ADVERTISEMENT_RECEIVED, advertisementReceived);

        await host.start([binding], beforeAdvertisement);
        await host.startService([binding], beforeAdvertisement);
        host.sendAdvertisement();
        host.onAdvertisement({ peerId: "caller-peer", name: "Caller", platform: "test" }, "caller-peer");

        expect(createRoom).not.toHaveBeenCalled();
        expect(sendAdvertisement).not.toHaveBeenCalled();
        expect(beforeAdvertisement).not.toHaveBeenCalled();
        expect(room.sent).toEqual([]);
        expect(host.knownAdvertisements).toEqual([]);
        expect(advertisementReceived).not.toHaveBeenCalled();
    });

    it("broadcasts without a target and ignores self and self-claimed advertisements", async () => {
        const room = new FakeTrysteroRoom("target-peer");
        const env = makeEnvironment("Target");
        const host = createHost(env, room.id, createRoomFactory(room));
        const advertisementReceived = vi.fn();
        env.events.onEvent(EVENT_ADVERTISEMENT_RECEIVED, advertisementReceived);

        host.sendAdvertisement();
        expect(room.sent).toEqual([]);
        await host.start();
        room.sent.length = 0;
        host.sendAdvertisement();
        host.onAdvertisement({ peerId: "other-peer", name: "Other", platform: "test" }, host.serverPeerId);
        host.onAdvertisement({ peerId: host.serverPeerId, name: "Claimed self", platform: "test" }, "other-peer");
        host.onAdvertisement({ peerId: "claimed-peer", name: "Mismatch", platform: "test" }, "other-peer");

        expect(room.sent).toHaveLength(1);
        expect(room.sent[0]).toMatchObject({
            action: "ad",
            target: undefined,
            message: { peerId: host.serverPeerId, name: "Target", platform: "test" },
        });
        expect(host.knownAdvertisements).toEqual([]);
        expect(advertisementReceived).not.toHaveBeenCalled();
    });

    it("advertises to a peer on room join and ignores a delayed join callback after disposal", async () => {
        const { caller, target, targetRoom } = await createConnectedPair(() => undefined);
        targetRoom.sent.length = 0;

        targetRoom.triggerPeerJoin(caller.serverPeerId);

        expect(targetRoom.sent).toContainEqual(expect.objectContaining({ action: "ad", target: caller.serverPeerId }));
        targetRoom.sent.length = 0;
        target.dispose();
        targetRoom.triggerPeerJoin(caller.serverPeerId);

        expect(targetRoom.sent.some(({ action }) => action === "ad")).toBe(false);
    });

    it.each([true, false])(
        "reports join failures and fences late diagnostics with managed ICE: %s",
        async (managedIce) => {
            const logs: unknown[] = [];
            const diagnostics: P2PDiagnosticEvent[] = [];
            const reportDiagnostic: NonNullable<ReplicatorHostEnv["reportDiagnostic"]> = (event) => {
                diagnostics.push(event);
            };
            const room = new FakeTrysteroRoom("target-peer");
            const createRoom = createRoomFactory(room);
            const env = makeEnvironment(
                "Target",
                managedIce
                    ? { P2P_iceServers: [{ urls: "turn:relay.example.test", credential: "private-credential" }] }
                    : { P2P_iceServers: undefined },
                reportDiagnostic
            );
            const host = createHost(env, room.id, createRoom);
            const transportError: JoinError = {
                error: "private transport diagnostic",
                appId: "rpc-boundary-test",
                roomId: "rpc-boundary-room",
                peerId: "unknown-peer",
            };
            setGlobalLogFunction((message) => logs.push(message));

            try {
                await host.start();
                const onJoinError = createRoom.mock.calls[0][2].onJoinError;
                onJoinError(transportError);

                expect(diagnostics).toHaveLength(1);
                expect(diagnostics[0]).toMatchObject({
                    category: "relay",
                    code: "room-join-error",
                    reason: "transport-error",
                });
                if (managedIce) {
                    expect(logs).toContain("Managed P2P transport error details were omitted.");
                    expect(logs).not.toContain(transportError);
                    expect(
                        logs.some((message) => typeof message === "string" && message.includes(transportError.error))
                    ).toBe(false);
                } else {
                    expect(logs).toContain(transportError);
                    expect(logs).not.toContain("Managed P2P transport error details were omitted.");
                }

                host.dispose();
                onJoinError(transportError);

                expect(diagnostics).toHaveLength(1);
            } finally {
                setGlobalLogFunction(defaultLogger);
            }
        }
    );

    it.each(["advertisement", "departure"] as const)(
        "preserves the peer event when its session %s callback rejects",
        async (event) => {
            const room = new FakeTrysteroRoom("target-peer");
            const env = makeEnvironment("Target");
            const host = createHost(env, room.id, createRoomFactory(room));
            await host.start();
            const advertisement = { peerId: "caller-peer", name: "Caller", platform: "test" };
            host.onAdvertisement(advertisement, advertisement.peerId);
            await flushQueuedCallbacks();
            const failure = new Error("session callback failed");
            const callback = vi.fn(async () => {
                throw failure;
            });
            host.setSessionPeerHandlers({ onAdvertisement: callback, onPeerLeft: callback });
            const observed = vi.fn();
            env.events.onEvent(
                event === "advertisement" ? EVENT_ADVERTISEMENT_RECEIVED : EVENT_DEVICE_LEAVED,
                observed
            );
            const logs: unknown[] = [];
            setGlobalLogFunction((message) => logs.push(message));
            try {
                if (event === "advertisement") {
                    host.onAdvertisement(advertisement, advertisement.peerId);
                } else {
                    room.triggerPeerLeave(advertisement.peerId);
                }
                await flushQueuedCallbacks();

                expect(callback).toHaveBeenCalledOnce();
                expect(logs).toContain(failure);
                if (event === "advertisement") {
                    expect(observed).toHaveBeenCalledExactlyOnceWith(advertisement);
                    expect(host.knownAdvertisements).toContainEqual(advertisement);
                } else {
                    expect(observed).toHaveBeenCalledExactlyOnceWith(advertisement.peerId);
                    expect(host.knownAdvertisements).toEqual([]);
                }
            } finally {
                setGlobalLogFunction(defaultLogger);
            }
        }
    );

    it("transmits structured errors from Commonlib handlers", async () => {
        const failure = new RpcError("PROTOCOL_ERROR", 'Operation rejected: "review"', { reason: "fixture" });
        const { caller, target, targetRoom } = await createConnectedPair(
            () => undefined,
            [
                {
                    fail: () => {
                        throw failure;
                    },
                },
            ]
        );

        expect(target.rpcRoom).toBeInstanceOf(RpcRoom);
        const client = caller.getConnection(target.serverPeerId);
        const error = await client.invokeRemoteFunction("fail", []).catch((reason: unknown) => reason);
        expect(error).toBeInstanceOf(RpcError);
        expect(error).toMatchObject({
            code: failure.code,
            message: failure.message,
            details: failure.details,
        });
        expect(rpcEnvelopes(targetRoom)).toContainEqual(
            expect.objectContaining({ kind: "response", ok: false, error: failure.toShape() })
        );
    });

    it("keeps the details key on errors rejected by a hosted session call", async () => {
        const { caller, target } = await createConnectedPair(() => undefined);
        const room = caller.rpcRoom;
        if (!room) {
            throw new Error("Expected a started caller room");
        }
        const error = await room
            .session(target.serverPeerId)
            .call("events.missing")
            .catch((reason: unknown) => reason);

        expect(Object.getPrototypeOf(error)).toBe(RpcError.prototype);
        if (!(error instanceof RpcError)) {
            throw new Error("Expected an RPC error");
        }
        expect(error.toShape()).toStrictEqual({
            code: "REMOTE_ERROR",
            message: "Method not found: events.missing",
            details: undefined,
        });
    });

    it.each(["call", "notify"] as const)("shapes a hosted session %s error with no peer", async (operation) => {
        const { caller } = await createConnectedPair(() => undefined);
        const room = caller.rpcRoom;
        if (!room) {
            throw new Error("Expected a started caller room");
        }
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
    });

    it.each(["invoke", "notify"] as const)("normalises errors from hosted room %s", async (operation) => {
        const { caller, target } = await createConnectedPair(() => undefined);
        const room = caller.rpcRoom;
        if (!room) {
            throw new Error("Expected a started caller room");
        }
        const error = await room[operation](target.serverPeerId, "invalid", []).catch((reason: unknown) => reason);
        if (!(error instanceof RpcError)) {
            throw new Error("Expected an RPC error");
        }
        expect(error.toShape()).toMatchObject({ code: "PROTOCOL_ERROR" });
        expect(Object.hasOwn(error.toShape(), "details")).toBe(true);
    });

    it.each(["register", "registerCancellable"] as const)(
        "normalises errors from hosted room %s",
        async (operation) => {
            const { caller } = await createConnectedPair(() => undefined);
            const room = caller.rpcRoom;
            if (!room) {
                throw new Error("Expected a started caller room");
            }
            let error: unknown;
            try {
                room[operation]("invalid", (): null => null);
            } catch (reason) {
                error = reason;
            }
            expect(error).toBeInstanceOf(RpcError);
            if (!(error instanceof RpcError)) {
                throw new Error("Expected an RPC error");
            }
            const shape = error.toShape();
            expect(shape.code).toBe("PROTOCOL_ERROR");
            expect(Object.hasOwn(shape, "details")).toBe(true);
        }
    );

    it("exposes hosted rooms and sessions as instances of the public RPC classes", async () => {
        const { caller, target } = await createConnectedPair(() => undefined);
        const room = caller.rpcRoom;
        const session = room?.session(target.serverPeerId);
        class CustomRoom extends RpcRoom {}

        expect(room).toBeInstanceOf(RpcRoom);
        expect(room).toBeInstanceOf(FancyKitRpcRoom);
        expect(room).not.toBeInstanceOf(CustomRoom);
        expect(session).toBeInstanceOf(RpcSession);
        expect(session).toBeInstanceOf(FancyKitRpcSession);
        expect(room?.session(target.serverPeerId)).toBe(session);
    });

    it("round-trips a PouchDB document and reconstructs missing-document errors over the hosted RPC room", async () => {
        const db = new PouchDB<{ value: string }>("rpc-boundary-pouchdb", { adapter: "memory" });
        try {
            const { caller, target } = await createConnectedPair((host) => {
                const room = host.rpcRoom;
                if (!room) {
                    throw new Error("Expected a started target room");
                }
                exposeDB(room, db);
            });
            const room = caller.rpcRoom;
            if (!room) {
                throw new Error("Expected a started caller room");
            }
            const proxy = new RpcPouchDBProxy(room.session(target.serverPeerId), db.name);
            const doc = { _id: "doc", value: "stored via RPC" };

            const result = await proxy.put(doc);
            expect(result).toMatchObject({ ok: true, id: doc._id });
            await expect(proxy.get(doc._id)).resolves.toEqual({ ...doc, _rev: result.rev });
            await expect(db.get(doc._id)).resolves.toEqual({ ...doc, _rev: result.rev });
            await expect(proxy.get("missing-doc")).rejects.toMatchObject({
                status: 404,
                name: "not_found",
                reason: "missing",
            });
        } finally {
            await db.destroy();
        }
    });

    it.each([
        ["admission", "events.changed: review"],
        ["handler", "events.changed: review"],
        ["throwing message getter", "events.changed: review"],
        ["cancellation-aware handler", "events.changed: review"],
        ["handler", "events.changed: review: Commonlib RPC callback failed: Method not found: events.changed: review"],
    ] as const)("omits exception details from a notification warning during %s for %s", async (stage, method) => {
        const exceptionText = "fixture-only exception detail: private context";
        const handler = vi.fn(() => {
            const error = new Error(exceptionText);
            if (stage === "throwing message getter") {
                Object.defineProperty(error, "message", {
                    get() {
                        throw new Error("fixture-only secondary exception");
                    },
                });
            }
            throw error;
        });
        const cancellationAware = stage === "cancellation-aware handler";
        const { caller, target, targetRoom } = await createConnectedPair(
            (host) => {
                if (cancellationAware) {
                    host.serveCancellationAwareFunction(method, handler);
                }
            },
            cancellationAware ? [] : [{ [method]: handler }]
        );
        const room = caller.rpcRoom;
        if (!room) {
            throw new Error("Expected a started test room");
        }
        const admission =
            stage === "admission"
                ? vi.spyOn(target, "isAcceptablePeer").mockRejectedValue(new Error(exceptionText))
                : undefined;
        const warnings: string[] = [];
        setGlobalLogFunction((message) => {
            if (typeof message === "string" && message.startsWith("RPC Protocol warning")) {
                warnings.push(message);
            }
        });

        try {
            await room.session(target.serverPeerId).notify(method);
            await flushQueuedCallbacks();

            if (admission) {
                expect(admission).toHaveBeenCalledOnce();
                expect(handler).not.toHaveBeenCalled();
            } else {
                expect(handler).toHaveBeenCalledOnce();
            }
            expect(rpcEnvelopes(targetRoom).filter((message) => message.kind === "response")).toEqual([]);
            expect(warnings).toEqual([
                `RPC Protocol warning from ${caller.serverPeerId}: RPC notification ${method}: failed`,
            ]);
        } finally {
            admission?.mockRestore();
            setGlobalLogFunction(defaultLogger);
        }
    });

    it.each(["missing method", "major mismatch", "minor mismatch"] as const)(
        "preserves the full notification method when Fancy Kit reports %s",
        async (failure) => {
            const prefix = "events.changed: RPC major mismatch: local=1, remote=10";
            const method =
                failure === "major mismatch" ? `${prefix}: Method not found: events.changed` : "events.changed: review";
            const { caller, target, callerRoom, targetRoom } = await createConnectedPair(() => undefined);
            const room = caller.rpcRoom;
            if (!room) {
                throw new Error("Expected a started caller room");
            }
            if (failure !== "missing method") {
                await callerRoom.action("rpc2")?.send({
                    wire: "raw",
                    payload: JSON.stringify({
                        kind: "handshake",
                        versionMajor: failure === "major mismatch" ? 10 : 1,
                        versionMinor: 10,
                    }),
                } satisfies RpcWireMessage);
                await flushQueuedCallbacks();
            }
            const warnings: unknown[] = [];
            setGlobalLogFunction((message) => warnings.push(message));
            try {
                await room.session(target.serverPeerId).notify(method);
                await flushQueuedCallbacks();

                expect(warnings).toContain(
                    `RPC Protocol warning from ${caller.serverPeerId}: RPC notification ${method}: failed`
                );
                if (failure === "minor mismatch") {
                    expect(warnings).toContain(
                        `RPC Protocol warning from ${caller.serverPeerId}: RPC notification ${method}: protocol minor version mismatch`
                    );
                }
                expect(rpcEnvelopes(targetRoom).filter((message) => message.kind === "response")).toEqual([]);
            } finally {
                setGlobalLogFunction(defaultLogger);
            }
        }
    );

    it("reports malformed RPC input without preventing the next authentication request", async () => {
        const room = new FakeTrysteroRoom("target-peer");
        const host = createHost(makeEnvironment("Target"), room.id, createRoomFactory(room));
        const authenticate = vi.fn(() => "authentication ready");
        const logs: unknown[] = [];
        setGlobalLogFunction((message) => logs.push(message));
        try {
            await host.start([{ "!reqAuth": authenticate }]);
            const receive = room.action("rpc2")?.onMessage;
            if (!receive) {
                throw new Error("Expected the started room to register its RPC action");
            }
            const invalidPayload = "synthetic malformed RPC input";
            await receive({ wire: "raw", payload: invalidPayload }, { peerId: "caller-peer" });
            await flushQueuedCallbacks();
            expect(logs).toContain("RPC Protocol warning from caller-peer: Invalid payload");
            expect(logs.join(" ")).not.toContain(invalidPayload);

            await receive(
                {
                    wire: "raw",
                    payload: JSON.stringify({
                        kind: "request",
                        requestId: "after-invalid",
                        method: "legacy/!reqAuth",
                        args: [],
                    }),
                },
                { peerId: "caller-peer" }
            );
            await flushQueuedCallbacks();
            expect(authenticate).toHaveBeenCalledOnce();
            expect(rpcEnvelopes(room)).toContainEqual({
                kind: "response",
                requestId: "after-invalid",
                ok: true,
                data: "authentication ready",
            });
        } finally {
            setGlobalLogFunction(defaultLogger);
        }
    });

    it("sends accepted notifications without a response while ordinary calls still receive one", async () => {
        const started = deferred<{ peerId: string; value: string }>();
        const releaseNotification = deferred<void>();
        const notificationFinished = deferred<void>();
        let notificationHandlerFinished = false;
        const { caller, target, callerRoom, targetRoom } = await createConnectedPair(
            (host) => {
                host.serveCancellationAwareFunction<[string], string>("apply", async (_context, peerId, value) => {
                    started.resolve({ peerId, value });
                    await releaseNotification.promise;
                    notificationHandlerFinished = true;
                    notificationFinished.resolve();
                    return "processed";
                });
            },
            [{ echo: (value: string) => `echo:${value}` }]
        );

        const client = caller.getConnection(target.serverPeerId);
        await client.notifyRemoteFunction("apply", ["change-1"]);

        const notification = rpcEnvelopes(callerRoom).find(
            (envelope) => envelope.kind === "request" && envelope.method === "legacy/apply"
        );
        expect(notification).toMatchObject({
            kind: "request",
            method: "legacy/apply",
            args: ["change-1"],
            expectsResponse: false,
        });
        const received = await started.promise;
        expect(received).toEqual({ peerId: caller.serverPeerId, value: "change-1" });
        expect(notificationHandlerFinished).toBe(false);

        releaseNotification.resolve();
        await notificationFinished.promise;
        await flushQueuedCallbacks();
        if (notification?.kind !== "request") {
            throw new Error("Expected a notification request envelope");
        }
        expect(
            rpcEnvelopes(targetRoom).some(
                (envelope) => envelope.kind === "response" && envelope.requestId === notification.requestId
            )
        ).toBe(false);

        await expect(client.invokeRemoteFunction("echo", ["ordinary-call"])).resolves.toBe("echo:ordinary-call");
        const ordinaryRequest = rpcEnvelopes(callerRoom).find(
            (envelope) => envelope.kind === "request" && envelope.method === "legacy/echo"
        );
        expect(ordinaryRequest).toMatchObject({ kind: "request", args: ["ordinary-call"] });
        if (ordinaryRequest?.kind !== "request") {
            throw new Error("Expected an ordinary request envelope");
        }
        expect(ordinaryRequest.expectsResponse).toBeUndefined();
        expect(rpcEnvelopes(targetRoom)).toContainEqual(
            expect.objectContaining({
                kind: "response",
                requestId: ordinaryRequest.requestId,
                ok: true,
                data: "echo:ordinary-call",
            })
        );
    });

    it.each(["caller abort", "peer leave", "room close"] as const)(
        "aborts the cancellation-aware remote handler on %s and releases Room bindings",
        async (trigger) => {
            const handlerStarted = deferred<AbortSignal>();
            const handlerFinished = deferred<void>();
            const { caller, target, targetRoom } = await createConnectedPair((host) => {
                host.serveCancellationAwareFunction<[], string>("wait", async (context) => {
                    handlerStarted.resolve(context.signal);
                    await waitForAbort(context.signal);
                    handlerFinished.resolve();
                    return "cancelled";
                });
            });
            const controller = new AbortController();
            const call = caller
                .getConnection(target.serverPeerId)
                .invokeRemoteFunction("wait", [], 10000, controller.signal);
            const callRejected = expect(call).rejects.toThrow();
            const remoteSignal = await handlerStarted.promise;
            const remoteAbortObserved = waitForAbort(remoteSignal);

            if (trigger === "caller abort") {
                controller.abort();
            } else if (trigger === "peer leave") {
                targetRoom.triggerPeerLeave(caller.serverPeerId);
            } else {
                await target.shutdown();
            }

            await remoteAbortObserved;
            await handlerFinished.promise;
            if (trigger !== "caller abort") {
                controller.abort();
            }
            await callRejected;
            if (trigger !== "room close") {
                await target.shutdown();
            }

            const reason: unknown = remoteSignal.reason;
            expect(reason).toBeInstanceOf(RpcError);
            expect(reason).toMatchObject({ code: "CANCELLED", message: "Invocation cancelled" });
            if (!(reason instanceof RpcError)) {
                throw new Error("Expected a Commonlib RPC error");
            }
            expect(Object.prototype.hasOwnProperty.call(reason, "details")).toBe(true);
            expect(Object.prototype.hasOwnProperty.call(reason.toShape(), "details")).toBe(true);

            expect(targetRoom.action("rpc2")?.onMessage).toBeNull();
            expect(targetRoom.onPeerJoin).toBeNull();
            expect(targetRoom.onPeerLeave).toBeNull();
        }
    );

    it("replaces RPC callbacks on restart and fences delayed callbacks from the old Room", async () => {
        const callerRoom = new FakeTrysteroRoom("caller-peer");
        const firstTargetRoom = new FakeTrysteroRoom("target-peer");
        const replacementTargetRoom = new FakeTrysteroRoom("target-peer");
        const rooms = [firstTargetRoom, replacementTargetRoom];
        const callerFactory = createRoomFactory(callerRoom);
        const targetFactory = vi.fn<typeof joinRoom>(() => {
            const room = rooms.shift();
            if (!room) {
                throw new Error("Unexpected extra Room creation");
            }
            callerRoom.peer = room;
            room.peer = callerRoom;
            return asTrysteroRoom(room);
        });
        const caller = createHost(makeEnvironment("Caller"), callerRoom.id, callerFactory);
        const target = createHost(makeEnvironment("Target"), firstTargetRoom.id, targetFactory);
        const firstVersion = vi.fn(() => "first");
        const replacementVersion = vi.fn(() => "replacement");

        await caller.start();
        await target.start([{ version: firstVersion }]);
        caller.sendAdvertisement(target.serverPeerId);
        const client = caller.getConnection(target.serverPeerId);
        await expect(client.invokeRemoteFunction("version", [])).resolves.toBe("first");

        const delayedRpcMessage = firstTargetRoom.action("rpc2")?.onMessage;
        const delayedPeerLeave = firstTargetRoom.onPeerLeave;
        expect(delayedRpcMessage).toBeTypeOf("function");
        expect(delayedPeerLeave).toBeTypeOf("function");

        await target.start([{ version: replacementVersion }]);
        caller.sendAdvertisement(target.serverPeerId);
        await expect(client.invokeRemoteFunction("version", [])).resolves.toBe("replacement");

        delayedRpcMessage?.(
            {
                wire: "raw",
                payload: JSON.stringify({
                    kind: "request",
                    requestId: "old-room-request",
                    method: "legacy/version",
                    args: [],
                }),
            } satisfies RpcWireMessage,
            { peerId: caller.serverPeerId }
        );
        delayedPeerLeave?.(caller.serverPeerId);
        await flushQueuedCallbacks();

        expect(firstTargetRoom.action("rpc2")?.onMessage).toBeNull();
        expect(firstTargetRoom.onPeerJoin).toBeNull();
        expect(firstTargetRoom.onPeerLeave).toBeNull();
        expect(replacementVersion).toHaveBeenCalledOnce();
        expect(target.knownAdvertisements.map(({ peerId }) => peerId)).toContain(caller.serverPeerId);
        expect(targetFactory).toHaveBeenCalledTimes(2);
    });
});
