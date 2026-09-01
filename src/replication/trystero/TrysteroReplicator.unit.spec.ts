import { describe, expect, it, vi } from "vitest";
import { TrysteroReplicator } from "./TrysteroReplicator";
import { createLiveSyncEventHub } from "@lib/hub/hub";
import { defaultLogger, LOG_LEVEL_NOTICE, setGlobalLogFunction } from "@lib/common/logger";
import {
    EVENT_ADVERTISEMENT_RECEIVED,
    EVENT_P2P_REPLICATOR_STATUS,
    type P2PPeerAcceptance,
    type P2PHost,
} from "./TrysteroReplicatorP2PServer";
import type { Advertisement } from "./types";
import { RpcRoom, type JsonLike, type RpcWireMessage, type TransportAdapter } from "@lib/rpc";
import { toRpcMethodName } from "./rpcCompat";
import { fromP2PReplicationWireResult } from "./P2PReplicationWire";

function createRpcRoomPair() {
    let receiveA: ((message: RpcWireMessage, peerId: string) => void) | undefined;
    let receiveB: ((message: RpcWireMessage, peerId: string) => void) | undefined;
    const transportA: TransportAdapter = {
        send: (message) => receiveB?.(message, "peer-a"),
        onMessage: (handler) => {
            receiveA = handler;
            return () => {
                if (receiveA === handler) receiveA = undefined;
            };
        },
    };
    const transportB: TransportAdapter = {
        send: (message) => receiveA?.(message, "peer-b"),
        onMessage: (handler) => {
            receiveB = handler;
            return () => {
                if (receiveB === handler) receiveB = undefined;
            };
        },
    };
    return {
        roomA: new RpcRoom({ transport: transportA }),
        roomB: new RpcRoom({ transport: transportB }),
    };
}

function createReplicator(settings: Record<string, unknown> = {}) {
    const runFiniteReplicationActivity = vi.fn(async (task: () => unknown) => await task());
    const events = createLiveSyncEventHub();
    const sessionSettings = {
        P2P_Enabled: true,
        P2P_AutoSyncPeers: "",
        P2P_AutoWatchPeers: "",
        P2P_SyncOnReplication: "",
        ...settings,
    };
    const currentSettings = { ...sessionSettings };
    const replicator = new TrysteroReplicator(
        {
            events,
            translate: (key: string) => key,
            settings: sessionSettings,
            currentSettings: () => currentSettings,
            db: {},
            simpleStore: {},
            deviceName: "device-a",
            platform: "test",
            confirm: {},
            processReplicatedDocs: vi.fn(),
            runFiniteReplicationActivity,
        } as any,
        {
            _knownAdvertisements: new Map(),
            evaluatePeerAcceptance: vi.fn(async () => "accepted"),
        } as any
    );
    return { currentSettings, events, replicator, runFiniteReplicationActivity };
}

function createAdvertisementServer(advertisements: Advertisement[] = []) {
    const knownAdvertisements = new Map(advertisements.map((advertisement) => [advertisement.peerId, advertisement]));
    return {
        _knownAdvertisements: knownAdvertisements,
        get knownAdvertisements() {
            return [...knownAdvertisements.values()];
        },
        evaluatePeerAcceptance: vi.fn(async () => "accepted" as const),
    };
}

function captureGlobalLogs() {
    const entries: Array<{ message: unknown; level?: number; key?: string }> = [];
    setGlobalLogFunction((message, level, key) => entries.push({ message, level, key }));
    return {
        entries,
        restore: () => setGlobalLogFunction(defaultLogger),
    };
}

function hasNotice(entries: Array<{ level?: number }>): boolean {
    return entries.some((entry) => entry.level === LOG_LEVEL_NOTICE);
}

describe("TrysteroReplicator automatic remote activity", () => {
    it.each([
        [false, false],
        [true, true],
    ] as const)("uses the call authority for a no-target command (%s)", async (showResult, expectNotice) => {
        const { replicator } = createReplicator();
        const logs = captureGlobalLogs();
        try {
            await expect(replicator.replicateFromCommand(showResult, 0)).resolves.toEqual({
                status: "blocked",
                reason: "no-targets",
                targets: [],
            });

            expect(hasNotice(logs.entries)).toBe(expectNotice);
        } finally {
            logs.restore();
        }
    });

    it.each([
        [false, false],
        [true, true],
    ] as const)("uses the call authority for an authentication settlement (%s)", async (showNotice, expectNotice) => {
        const { replicator } = createReplicator();
        vi.spyOn(replicator, "requestAuthenticate").mockResolvedValue(false);
        const logs = captureGlobalLogs();
        try {
            await expect(replicator.replicateFrom("peer-id", showNotice)).resolves.toMatchObject({
                status: "failed",
                error: expect.any(Error),
            });

            expect(hasNotice(logs.entries)).toBe(expectNotice);
        } finally {
            logs.restore();
        }
    });

    it.each([
        [false, false],
        [true, true],
    ] as const)("uses the call authority for a tweak settlement (%s)", async (showNotice, expectNotice) => {
        const { replicator } = createReplicator();
        vi.spyOn(replicator, "requestAuthenticate").mockResolvedValue(true);
        vi.spyOn(replicator, "checkTweakValues").mockResolvedValue(false);
        const logs = captureGlobalLogs();
        try {
            await expect(replicator.replicateFrom("peer-id", showNotice)).resolves.toMatchObject({
                status: "failed",
                error: expect.any(Error),
            });

            expect(hasNotice(logs.entries)).toBe(expectNotice);
        } finally {
            logs.restore();
        }
    });

    it.each([
        [false, false],
        [true, true],
    ] as const)("propagates call authority through a real tweak mismatch (%s)", async (showNotice, expectNotice) => {
        const { replicator } = createReplicator();
        vi.spyOn(replicator, "requestAuthenticate").mockResolvedValue(true);
        vi.spyOn(replicator, "getTweakSettings").mockResolvedValue({ passphrase: "local" } as never);
        (replicator as any).server = {
            knownAdvertisements: [{ peerId: "peer-id", platform: "test" }],
            serverPeerId: "local-peer",
            getConnection: vi.fn(() => ({
                invokeRemoteObjectFunction: vi.fn(async () => ({ passphrase: "remote" })),
            })),
        };
        const logs = captureGlobalLogs();
        try {
            await expect(replicator.replicateFrom("peer-id", showNotice)).resolves.toMatchObject({
                status: "failed",
                error: expect.any(Error),
            });

            expect(hasNotice(logs.entries)).toBe(expectNotice);
        } finally {
            logs.restore();
        }
    });

    it.each([
        [false, false],
        [true, true],
    ] as const)("uses the call authority for an overlap settlement (%s)", async (showNotice, expectNotice) => {
        const { replicator } = createReplicator();
        vi.spyOn(replicator, "requestAuthenticate").mockResolvedValue(true);
        vi.spyOn(replicator, "checkTweakValues").mockResolvedValue(true);
        replicator._replicateFromPeers.add("peer-id");
        const logs = captureGlobalLogs();
        try {
            await expect(replicator.replicateFrom("peer-id", showNotice)).resolves.toMatchObject({
                status: "failed",
                error: expect.any(Error),
            });

            expect(hasNotice(logs.entries)).toBe(expectNotice);
        } finally {
            logs.restore();
        }
    });

    it("releases host-lifetime resources when terminally disposed", async () => {
        const { events, replicator } = createReplicator();
        const close = vi.spyOn(replicator, "close").mockResolvedValue(undefined);
        const disposeHost = vi.fn();
        (replicator as any).server = { dispose: disposeHost };
        const statuses: unknown[] = [];
        events.onEvent(EVENT_P2P_REPLICATOR_STATUS, (status) => statuses.push(status));

        await (replicator as any).dispose();
        replicator.dispatchStatus();

        expect(close).toHaveBeenCalledOnce();
        expect(disposeHost).toHaveBeenCalledOnce();
        expect(statuses).toEqual([]);
        await expect(replicator.open()).rejects.toThrow("disposed");
    });

    it("binds an incoming synchronisation request to the RPC cancellation signal", async () => {
        const { replicator } = createReplicator();
        const registrationOrder: string[] = [];
        const start = vi.fn(async (_bindings: unknown[], beforeAdvertisement?: () => void) => {
            registrationOrder.push("room-opened");
            beforeAdvertisement?.();
            registrationOrder.push("advertised");
        });
        const serveCancellationAwareFunction = vi.fn(() => registrationOrder.push("cancellable-handler"));
        (replicator as any).server = {
            _knownAdvertisements: new Map(),
            start,
            serveCancellationAwareFunction,
        };
        const replicateFrom = vi.spyOn(replicator, "replicateFrom").mockResolvedValue({ status: "cancelled" });

        await replicator.open();
        const handler = serveCancellationAwareFunction.mock.calls[0][1] as (
            context: { signal: AbortSignal },
            peerId: string,
            fromPeerId: string
        ) => Promise<unknown>;
        const controller = new AbortController();

        await handler({ signal: controller.signal }, "rpc-peer", "source-peer");

        expect(start).toHaveBeenCalledOnce();
        expect(registrationOrder).toEqual(["room-opened", "cancellable-handler", "advertised"]);
        expect(replicateFrom).toHaveBeenCalledWith("source-peer", false, false, false, controller.signal);
    });

    it("preserves a failed synchronisation reason through the RpcRoom JSON boundary", async () => {
        const { roomA, roomB } = createRpcRoomPair();
        try {
            const { replicator: source } = createReplicator();
            source.setOnSetup();
            (source as any).server = {
                start: vi.fn(async (_bindings: unknown[], beforeAdvertisement?: () => void) => beforeAdvertisement?.()),
                serveCancellationAwareFunction: vi.fn(
                    (
                        type: string,
                        handler: (
                            context: { signal: AbortSignal },
                            peerId: string,
                            fromPeerId: string
                        ) => Promise<unknown>
                    ) => roomB.registerCancellable(toRpcMethodName(type), handler as any)
                ),
            };
            await source.open();

            const { replicator: requester } = createReplicator();
            (requester as any).server = {
                serverPeerId: "peer-a",
                getConnection: vi.fn(() => ({
                    invokeRemoteFunction: (type: string, args: JsonLike[], _timeout: number, signal?: AbortSignal) =>
                        roomA.session("peer-b").call(toRpcMethodName(type), args, { timeoutMs: 1_000, signal }),
                })),
            };

            const result = await requester.requestSynchroniseToPeer("peer-b");

            expect(result.status).toBe("failed");
            if (result.status !== "failed") throw new Error("Expected failed P2P replication");
            expect(result.error).toBeInstanceOf(Error);
            expect(result.error).toMatchObject({
                message: "The setup is in progress",
            });
        } finally {
            roomA.close();
            roomB.close();
        }
    });

    it("turns a legacy malformed wire failure into an explicit local Error", () => {
        const result = fromP2PReplicationWireResult({ status: "failed", error: {} as never });

        expect(result.status).toBe("failed");
        if (result.status !== "failed") throw new Error("Expected failed P2P replication");
        expect(result.error).toBeInstanceOf(Error);
        expect(result.error).toMatchObject({
            message: "The remote peer reported a replication failure without a usable reason.",
        });
    });

    it("decomposes auxiliary setup errors before they enter successful RPC data", async () => {
        const { replicator } = createReplicator();
        replicator.setOnSetup();
        const commands = replicator.getCommands();

        const results = await Promise.all([
            commands.onProgress("peer-id"),
            commands.getAllConfig("peer-id"),
            commands.requestBroadcasting("peer-id"),
        ]);

        for (const result of results) {
            expect(JSON.parse(JSON.stringify(result))).toEqual({
                error: {
                    code: "REMOTE_ERROR",
                    message: "The setup is in progress",
                },
            });
        }
    });

    it("does not request the reverse transfer after the pull is cancelled", async () => {
        const { replicator } = createReplicator();
        vi.spyOn(replicator, "replicateFrom").mockResolvedValue({ status: "cancelled" });
        const requestSynchroniseToPeer = vi
            .spyOn(replicator, "requestSynchroniseToPeer")
            .mockResolvedValue({ status: "completed", ok: true });

        await replicator.sync("peer-id");

        expect(requestSynchroniseToPeer).not.toHaveBeenCalled();
    });

    it("reports cancellation when an outgoing synchronisation request is aborted", async () => {
        const { replicator } = createReplicator();
        let requestStarted!: () => void;
        const started = new Promise<void>((resolve) => {
            requestStarted = resolve;
        });
        const invokeRemoteFunction = vi.fn(
            (_type: string, _args: unknown[], _timeout: number, signal?: AbortSignal) =>
                new Promise((_resolve, reject) => {
                    requestStarted();
                    signal?.addEventListener("abort", () => reject({ code: "CANCELLED" }), { once: true });
                })
        );
        (replicator as any).server = {
            serverPeerId: "local-peer",
            getConnection: vi.fn(() => ({ invokeRemoteFunction })),
        };
        const controller = new AbortController();

        const result = replicator.requestSynchroniseToPeer("peer-id", controller.signal);
        await started;
        controller.abort();

        await expect(result).resolves.toEqual({ status: "cancelled" });
    });

    it("reports cancellation when an outgoing tweak check is aborted", async () => {
        const { replicator } = createReplicator();
        let requestStarted!: () => void;
        const started = new Promise<void>((resolve) => {
            requestStarted = resolve;
        });
        const invokeRemoteObjectFunction = vi.fn(
            (_type: string, _args: unknown[], _timeout: number, signal?: AbortSignal) =>
                new Promise((_resolve, reject) => {
                    requestStarted();
                    signal?.addEventListener("abort", () => reject({ code: "CANCELLED" }), { once: true });
                })
        );
        (replicator as any).server = {
            knownAdvertisements: [{ peerId: "peer-id", platform: "test" }],
            getConnection: vi.fn(() => ({ invokeRemoteObjectFunction })),
        };
        vi.spyOn(replicator, "requestAuthenticate").mockResolvedValue(true);
        const controller = new AbortController();

        const result = replicator.replicateFrom("peer-id", false, false, false, controller.signal);
        await started;
        controller.abort();

        await expect(result).resolves.toEqual({ status: "cancelled" });
    });

    it("tracks automatic synchronisation when a configured peer is discovered", async () => {
        const { replicator, runFiniteReplicationActivity } = createReplicator({
            P2P_AutoSyncPeers: "peer-a",
        });
        const sync = vi.spyOn(replicator, "sync").mockResolvedValue({ status: "completed", ok: true });

        await replicator.onNewPeer({ peerId: "peer-id", name: "peer-a", platform: "test" });

        expect(runFiniteReplicationActivity).toHaveBeenCalledWith(expect.any(Function), {
            label: "replication",
        });
        expect(sync).toHaveBeenCalledWith("peer-id");
    });

    it("starts watching a configured peer when it is discovered", async () => {
        const { replicator } = createReplicator({
            P2P_AutoWatchPeers: "peer-a",
        });
        vi.spyOn(replicator, "getRemoteIsBroadcasting").mockResolvedValue(true);
        const watchPeer = vi.spyOn(replicator, "watchPeer");

        await replicator.onNewPeer({ peerId: "peer-id", name: "peer-a", platform: "test" });

        expect(watchPeer).toHaveBeenCalledWith("peer-id");
        expect(replicator._watchingPeers).toContain("peer-id");
    });

    it("reads current automatic synchronisation and watch policy for a newly advertised peer", async () => {
        const { currentSettings, replicator } = createReplicator();
        const sync = vi.spyOn(replicator, "sync").mockResolvedValue({ status: "completed", ok: true });
        vi.spyOn(replicator, "getRemoteIsBroadcasting").mockResolvedValue(true);
        const watchPeer = vi.spyOn(replicator, "watchPeer");
        currentSettings.P2P_AutoSyncPeers = "peer-a";
        currentSettings.P2P_AutoWatchPeers = "peer-a";

        await replicator.onNewPeer({ peerId: "peer-id", name: "peer-a", platform: "test" });

        expect(sync).toHaveBeenCalledWith("peer-id");
        expect(watchPeer).toHaveBeenCalledWith("peer-id");
    });

    it("tracks a pull requested by a remote peer", async () => {
        const { replicator, runFiniteReplicationActivity } = createReplicator();
        const replicateFrom = vi
            .spyOn(replicator, "replicateFrom")
            .mockResolvedValue({ status: "completed", ok: true });

        await replicator.getCommands().reqSync("peer-id");

        expect(runFiniteReplicationActivity).toHaveBeenCalledWith(expect.any(Function), {
            label: "replication",
        });
        expect(replicateFrom).toHaveBeenCalledWith("peer-id");
    });

    it("tracks a watched pull after a peer reports progress", async () => {
        const { replicator, runFiniteReplicationActivity } = createReplicator();
        const replicateFrom = vi
            .spyOn(replicator, "replicateFrom")
            .mockResolvedValue({ status: "completed", ok: true });
        replicator._watchingPeers.add("peer-id");

        await replicator.onUpdateDatabase("peer-id");

        expect(runFiniteReplicationActivity).toHaveBeenCalledWith(expect.any(Function), {
            label: "replication",
        });
        expect(replicateFrom).toHaveBeenCalledWith("peer-id");
    });

    it("preserves direct execution when a headless host omits the activity owner", async () => {
        const { replicator } = createReplicator({
            P2P_AutoSyncPeers: "peer-a",
        });
        (replicator as any)._env.runFiniteReplicationActivity = undefined;
        const sync = vi.spyOn(replicator, "sync").mockResolvedValue({ status: "completed", ok: true });

        await replicator.onNewPeer({ peerId: "peer-id", name: "peer-a", platform: "test" });

        expect(sync).toHaveBeenCalledWith("peer-id");
    });

    it("waits for a delayed configured-target advertisement before synchronising", async () => {
        vi.useFakeTimers();
        try {
            const { events, replicator } = createReplicator({
                P2P_SyncOnReplication: "peer-a",
            });
            const server = createAdvertisementServer();
            replicator.server = server as unknown as P2PHost;
            const peer: Advertisement = { peerId: "peer-id", name: "peer-a", platform: "test" };
            const sync = vi.spyOn(replicator, "sync").mockResolvedValue({ status: "completed", ok: true });

            const resultPromise = replicator.replicateFromCommand(true);
            await vi.advanceTimersByTimeAsync(100);
            expect(sync).not.toHaveBeenCalled();

            server._knownAdvertisements.set(peer.peerId, peer);
            events.emitEvent(EVENT_ADVERTISEMENT_RECEIVED, peer);

            await expect(resultPromise).resolves.toEqual({
                status: "completed",
                targets: [{ name: "peer-a", peerId: "peer-id", status: "completed" }],
            });
            expect(sync).toHaveBeenCalledWith(peer.peerId, true, undefined);
        } finally {
            vi.useRealTimers();
        }
    });

    it("reads the current configured-target policy when unattended synchronisation starts", async () => {
        const { currentSettings, replicator } = createReplicator();
        const peer: Advertisement = { peerId: "peer-id", name: "peer-a", platform: "test" };
        replicator.server = createAdvertisementServer([peer]) as unknown as P2PHost;
        const sync = vi.spyOn(replicator, "sync").mockResolvedValue({ status: "completed", ok: true });
        currentSettings.P2P_SyncOnReplication = "peer-a";

        await expect(replicator.replicateFromCommand(true, 0)).resolves.toEqual({
            status: "completed",
            targets: [{ name: "peer-a", peerId: "peer-id", status: "completed" }],
        });
        expect(sync).toHaveBeenCalledWith(peer.peerId, true, undefined);
    });

    it.each([
        ["denied", "rejected"],
        ["undecided", "undecided"],
    ] as const)(
        "returns an explicit failure for a configured %s target without opening admission UI",
        async (_label, decision: P2PPeerAcceptance) => {
            const { replicator } = createReplicator({
                P2P_SyncOnReplication: "peer-a",
            });
            const peer: Advertisement = { peerId: "peer-id", name: "peer-a", platform: "test" };
            const confirmUserToAccept = vi.fn(async () => true);
            const server = {
                ...createAdvertisementServer([peer]),
                evaluatePeerAcceptance: vi.fn(async () => decision),
                confirmUserToAccept,
            };
            replicator.server = server as unknown as P2PHost;
            const sync = vi.spyOn(replicator, "sync").mockResolvedValue({ status: "completed", ok: true });

            const result = await replicator.replicateFromCommand(true);
            expect(sync).not.toHaveBeenCalled();
            expect(confirmUserToAccept).not.toHaveBeenCalled();
            expect(result).toEqual({
                status: "partial",
                targets: [{ name: "peer-a", peerId: "peer-id", status: decision }],
            });
        }
    );

    it("deduplicates a configured target and AutoSync request into one baseline synchronisation", async () => {
        const { replicator } = createReplicator({
            P2P_AutoSyncPeers: "peer-a",
            P2P_SyncOnReplication: "peer-a",
        });
        const peer: Advertisement = { peerId: "peer-id", name: "peer-a", platform: "test" };
        const server = createAdvertisementServer([peer]);
        replicator.server = server as unknown as P2PHost;

        let releasePull!: () => void;
        const pullGate = new Promise<void>((resolve) => {
            releasePull = resolve;
        });
        let pullStarted!: () => void;
        const pullStartedPromise = new Promise<void>((resolve) => {
            pullStarted = resolve;
        });
        const replicateFrom = vi.spyOn(replicator, "replicateFrom").mockImplementation(async () => {
            pullStarted();
            await pullGate;
            return { status: "completed", ok: true };
        });
        const requestSynchroniseToPeer = vi
            .spyOn(replicator, "requestSynchroniseToPeer")
            .mockResolvedValue({ status: "completed", ok: true });

        const configured = replicator.replicateFromCommand(true);
        await pullStartedPromise;
        const automatic = replicator.onNewPeer(peer);
        await Promise.resolve();

        expect(replicateFrom).toHaveBeenCalledOnce();

        releasePull();
        await expect(configured).resolves.toEqual({
            status: "completed",
            targets: [{ name: "peer-a", peerId: "peer-id", status: "completed" }],
        });
        await automatic;

        expect(replicateFrom).toHaveBeenCalledOnce();
        expect(requestSynchroniseToPeer).toHaveBeenCalledOnce();
    });

    it("does not pull from a peer when the host replication policy rejects it", async () => {
        const { replicator } = createReplicator();
        const canReplicate = vi.fn(async () => false);
        (replicator as any)._env.canStartOrdinaryReplication = canReplicate;
        const requestAuthenticate = vi.spyOn(replicator, "requestAuthenticate");

        const result = await replicator.replicateFrom("peer-id", true);

        expect(result).toMatchObject({ error: expect.any(Error) });
        expect(canReplicate).toHaveBeenCalledWith(true);
        expect(requestAuthenticate).not.toHaveBeenCalled();
    });

    it("does not ask a peer to pull when the host replication policy rejects it", async () => {
        const { replicator } = createReplicator();
        const canReplicate = vi.fn(async () => false);
        const invokeRemoteFunction = vi.fn();
        (replicator as any)._env.canStartOrdinaryReplication = canReplicate;
        (replicator as any).server = {
            serverPeerId: "local-peer",
            getConnection: vi.fn(() => ({ invokeRemoteFunction })),
        };

        const result = await replicator.requestSynchroniseToPeer("peer-id");

        expect(result).toMatchObject({ error: expect.any(Error) });
        expect(canReplicate).toHaveBeenCalledWith(false);
        expect(invokeRemoteFunction).not.toHaveBeenCalled();
    });

    it("keeps an explicitly confirmed rebuild pull available while ordinary replication is paused", async () => {
        const { replicator } = createReplicator();
        const canReplicate = vi.fn(async () => false);
        (replicator as any)._env.canStartOrdinaryReplication = canReplicate;
        const requestAuthenticate = vi.spyOn(replicator, "requestAuthenticate").mockResolvedValue(false);

        await replicator.replicateFrom("peer-id", true, false, true);

        expect(canReplicate).not.toHaveBeenCalled();
        expect(requestAuthenticate).toHaveBeenCalledWith("peer-id");
    });
});
