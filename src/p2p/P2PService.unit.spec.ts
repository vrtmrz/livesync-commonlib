import { afterEach, describe, expect, it, vi } from "vitest";
import type { DiagRTCPeerConnectionMetrics } from "@lib/rpc/transports/DiagRTCPeerConnections.types";
import { createP2PService, projectP2PPeerConnectionMetrics } from "./P2PService";
import { createServiceContext } from "@lib/services/base/ServiceBase";
import { LiveSyncTrysteroReplicator } from "@lib/replication/trystero/LiveSyncTrysteroReplicator";
import { TrysteroReplicator } from "@lib/replication/trystero/TrysteroReplicator";
import { addP2PEventHandlers } from "@lib/replication/trystero/addP2PEventHandlers";

function createDeferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((res) => {
        resolve = res;
    });
    return { promise, resolve };
}

function createServiceHarness() {
    const context = createServiceContext();
    const settings: Record<string, unknown> = {
        P2P_Enabled: true,
        P2P_AutoStart: true,
        P2P_AutoBroadcast: false,
        P2P_AutoSyncPeers: "",
        P2P_AutoWatchPeers: "",
        P2P_SyncOnReplication: "",
        P2P_AutoAccepting: 0,
        P2P_AutoAcceptingPeers: "",
        P2P_AutoDenyingPeers: "",
        P2P_ActiveRemoteConfigurationId: "p2p-profile-a",
        P2P_AppID: "app-a",
        P2P_roomID: "room-a",
        P2P_passphrase: "pass-a",
        P2P_relays: "wss://relay.example.com",
        P2P_turnServers: "",
        P2P_turnUsername: "",
        P2P_turnCredential: "",
        P2P_maxWirePayloadBytes: 15_360,
        P2P_connectionPath: "automatic",
        P2P_useDiagRTC: false,
        P2P_IsHeadless: true,
    };
    const createDatabase = (name: string) => ({
        name,
        changes: vi.fn(() => {
            const feed = {
                cancel: vi.fn(),
                removeAllListeners: vi.fn(),
                on: vi.fn(),
            };
            feed.on.mockReturnValue(feed);
            return feed;
        }),
    });
    let database = createDatabase("db-a");
    const simpleStore = {
        get: vi.fn(async () => undefined),
        set: vi.fn(async () => undefined),
        delete: vi.fn(async () => undefined),
        keys: vi.fn(async () => []),
    };
    const runFiniteReplicationActivity = vi.fn(async (task: () => unknown) => await task());
    const service = createP2PService({
        services: {
            context,
            setting: { currentSettings: () => settings },
            database: {
                localDatabase: {
                    get localDatabase() {
                        return database;
                    },
                },
            },
            keyValueDB: { openSimpleStore: () => simpleStore },
            config: { getSmallConfig: () => "device-a" },
            vault: { getVaultName: () => "vault-a" },
            API: { getPlatform: () => "test", confirm: {} },
            replicator: {
                runFiniteReplicationActivity,
                runBoundedRemoteActivity: async (task: () => unknown) => await task(),
            },
            replication: {
                onCheckReplicationReady: async () => true,
                parseSynchroniseResult: async () => undefined,
            },
        },
    } as any);
    addP2PEventHandlers(service.lifecycle, context.events);
    return {
        context,
        compatibilityReplicator: service.compatibilityReplicator,
        lifecycle: service.lifecycle,
        transportLifecycle: service.views.transportLifecycle,
        targetedTransfer: service.views.targetedTransfer,
        settings,
        runFiniteReplicationActivity,
        replaceDatabase: (name: string) => {
            database = createDatabase(name);
        },
    };
}

function mockRoomTransport() {
    const lifecycle: string[] = [];
    vi.spyOn(TrysteroReplicator.prototype, "open").mockImplementation(async function () {
        lifecycle.push("open");
        (this.server as any)._room = {};
    });
    vi.spyOn(TrysteroReplicator.prototype, "close").mockImplementation(async function () {
        lifecycle.push("close");
        (this.server as any)._room = undefined;
    });
    return lifecycle;
}

afterEach(() => {
    vi.restoreAllMocks();
});

describe("P2P service diagnostics", () => {
    it("projects candidate details without exposing raw RTC reports", () => {
        const metrics: DiagRTCPeerConnectionMetrics = {
            selectedPair: { id: "pair-a" },
            selectedPairId: "pair-a",
            state: "succeeded",
            localCandidateId: "local-a",
            remoteCandidateId: "remote-a",
            currentRoundTripTime: 0.02,
            totalRoundTripTime: 0.5,
            requestsSent: 4,
            responsesReceived: 4,
            packetsDiscardedOnSend: 0,
            bytesSent: 120,
            bytesReceived: 240,
            reports: [
                {
                    id: "local-a",
                    candidateType: "host",
                    protocol: "udp",
                    relayProtocol: "unknown",
                },
                {
                    id: "remote-a",
                    candidateType: "relay",
                    protocol: "udp",
                    relayProtocol: "tls",
                },
            ],
        };

        expect(projectP2PPeerConnectionMetrics(metrics)).toEqual({
            selectedPairPresent: true,
            selectedPairId: "pair-a",
            state: "succeeded",
            currentRoundTripTime: 0.02,
            totalRoundTripTime: 0.5,
            requestsSent: 4,
            responsesReceived: 4,
            packetsDiscardedOnSend: 0,
            bytesSent: 120,
            bytesReceived: 240,
            localCandidate: {
                id: "local-a",
                candidateType: "host",
                protocol: "udp",
                relayProtocol: "unknown",
            },
            remoteCandidate: {
                id: "remote-a",
                candidateType: "relay",
                protocol: "udp",
                relayProtocol: "tls",
            },
        });
    });
});

describe("P2P service room ownership", () => {
    it("replaces the room when its connection identity changes", async () => {
        const lifecycle = mockRoomTransport();
        const { transportLifecycle, settings } = createServiceHarness();

        await transportLifecycle.connect();
        settings.P2P_roomID = "room-b";
        await transportLifecycle.connect();

        expect(lifecycle).toEqual(["open", "close", "open"]);
    });

    it("retains the room when only the selected profile or dynamic policy changes", async () => {
        const roomLifecycle = mockRoomTransport();
        const { lifecycle, transportLifecycle, settings } = createServiceHarness();

        await transportLifecycle.connect();
        settings.P2P_ActiveRemoteConfigurationId = "p2p-profile-b";
        settings.P2P_AutoStart = false;
        settings.P2P_AutoBroadcast = true;
        settings.P2P_AutoSyncPeers = "peer-a";
        settings.P2P_AutoWatchPeers = "peer-b";
        settings.P2P_SyncOnReplication = "peer-c";
        settings.P2P_AutoAccepting = 1;
        settings.P2P_AutoAcceptingPeers = "peer-d";
        settings.P2P_AutoDenyingPeers = "peer-e";
        settings.P2P_IsHeadless = false;

        await lifecycle.reconcileAutoStart(settings as never);

        expect(roomLifecycle).toEqual(["open"]);
    });

    it("retains completed automatic baselines when profile selection preserves the peer namespace", async () => {
        mockRoomTransport();
        const { compatibilityReplicator, transportLifecycle, settings } = createServiceHarness();
        settings.P2P_AutoSyncPeers = "peer-a";
        settings.P2P_AutoAccepting = 1;
        await transportLifecycle.connect();
        const publishedReplicator = compatibilityReplicator.rawReplicator;
        const sync = vi.spyOn(publishedReplicator!, "sync").mockResolvedValue({ status: "completed", ok: true });
        const peer = { peerId: "peer-id", name: "peer-a", platform: "test" };
        (compatibilityReplicator.rawHost as any)._knownAdvertisements.set(peer.peerId, peer);

        await publishedReplicator?.onNewPeer(peer);
        settings.P2P_ActiveRemoteConfigurationId = "p2p-profile-b";
        await transportLifecycle.connect();
        await publishedReplicator?.onNewPeer(peer);

        expect(compatibilityReplicator.rawReplicator).toBe(publishedReplicator);
        expect(sync).toHaveBeenCalledOnce();
    });

    it("retains the room when a transport list changes only in representation", async () => {
        const roomLifecycle = mockRoomTransport();
        const { transportLifecycle, settings } = createServiceHarness();

        await transportLifecycle.connect();
        settings.P2P_relays = " wss://relay.example.com, ";
        await transportLifecycle.connect();

        expect(roomLifecycle).toEqual(["open"]);
    });

    it("reconciles automatic broadcast on the current room without replacing it", async () => {
        const roomLifecycle = mockRoomTransport();
        const enableBroadcast = vi.spyOn(TrysteroReplicator.prototype, "enableBroadcastChanges");
        const disableBroadcast = vi.spyOn(TrysteroReplicator.prototype, "disableBroadcastChanges");
        const { lifecycle, transportLifecycle, settings } = createServiceHarness();

        await transportLifecycle.connect();
        enableBroadcast.mockClear();
        disableBroadcast.mockClear();

        settings.P2P_AutoBroadcast = true;
        await lifecycle.reconcileAutoStart(settings as never);
        settings.P2P_AutoBroadcast = false;
        await lifecycle.reconcileAutoStart(settings as never);

        expect(roomLifecycle).toEqual(["open"]);
        expect(enableBroadcast).toHaveBeenCalledOnce();
        expect(disableBroadcast).toHaveBeenCalledOnce();
    });

    it("replaces the room when the local database identity changes", async () => {
        const lifecycle = mockRoomTransport();
        const { transportLifecycle, replaceDatabase } = createServiceHarness();

        await transportLifecycle.connect();
        replaceDatabase("db-b");
        await transportLifecycle.connect();

        expect(lifecycle).toEqual(["open", "close", "open"]);
    });

    it("keeps a published room session bound to the database which created it", async () => {
        mockRoomTransport();
        const { compatibilityReplicator, transportLifecycle, replaceDatabase } = createServiceHarness();

        await transportLifecycle.connect();
        const publishedReplicator = compatibilityReplicator.rawReplicator;
        const sessionDatabase = publishedReplicator?.db;

        replaceDatabase("db-b");

        expect(publishedReplicator?.db).toBe(sessionDatabase);
    });

    it("keeps a published room session bound to the transport settings which created it", async () => {
        mockRoomTransport();
        const { compatibilityReplicator, transportLifecycle, settings } = createServiceHarness();

        await transportLifecycle.connect();
        const publishedReplicator = compatibilityReplicator.rawReplicator;

        settings.P2P_roomID = "room-b";

        expect(publishedReplicator?.settings.P2P_roomID).toBe("room-a");
    });

    it("does not publish a candidate whose binding changed while it opened", async () => {
        const gate = createDeferred();
        const open = vi.spyOn(TrysteroReplicator.prototype, "open").mockImplementation(async function () {
            await gate.promise;
            (this.server as any)._room = {};
        });
        const close = vi.spyOn(TrysteroReplicator.prototype, "close").mockImplementation(async function () {
            (this.server as any)._room = undefined;
        });
        const { compatibilityReplicator, transportLifecycle, settings } = createServiceHarness();

        const opening = transportLifecycle.connect();
        await vi.waitFor(() => expect(open).toHaveBeenCalledOnce());
        settings.P2P_roomID = "room-b";
        gate.resolve();
        await opening;

        expect(transportLifecycle.isConnected).toBe(false);
        expect(compatibilityReplicator.rawReplicator).toBeUndefined();
        expect(close).toHaveBeenCalledOnce();
    });

    it("does not publish a candidate whose database changed while it opened", async () => {
        const gate = createDeferred();
        const open = vi.spyOn(TrysteroReplicator.prototype, "open").mockImplementation(async function () {
            await gate.promise;
            (this.server as any)._room = {};
        });
        const close = vi.spyOn(TrysteroReplicator.prototype, "close").mockImplementation(async function () {
            (this.server as any)._room = undefined;
        });
        const { compatibilityReplicator, replaceDatabase, transportLifecycle } = createServiceHarness();

        const opening = transportLifecycle.connect();
        await vi.waitFor(() => expect(open).toHaveBeenCalledOnce());
        replaceDatabase("db-b");
        gate.resolve();
        await opening;

        expect(transportLifecycle.isConnected).toBe(false);
        expect(compatibilityReplicator.rawReplicator).toBeUndefined();
        expect(close).toHaveBeenCalledOnce();
    });

    it("does not route a retired session's peer event into its replacement", async () => {
        mockRoomTransport();
        const { compatibilityReplicator, transportLifecycle, settings } = createServiceHarness();

        await transportLifecycle.connect();
        const retiredHost = compatibilityReplicator.rawHost;
        settings.P2P_maxWirePayloadBytes = 800;
        await transportLifecycle.connect();
        const currentHost = compatibilityReplicator.rawHost;
        const currentReplicator = compatibilityReplicator.rawReplicator;
        const onNewPeer = vi.spyOn(currentReplicator!, "onNewPeer").mockResolvedValue(undefined);
        const onPeerLeaved = vi.spyOn(currentReplicator!, "onPeerLeaved").mockReturnValue(undefined);

        currentHost?.onAdvertisement(
            { peerId: "peer-current", name: "Current peer", platform: "test" },
            "peer-current"
        );
        await vi.waitFor(() => expect(onNewPeer).toHaveBeenCalledOnce());
        (currentHost as any)?._onPeerLeave("peer-current");
        await vi.waitFor(() => expect(onPeerLeaved).toHaveBeenCalledOnce());

        retiredHost?.onAdvertisement({ peerId: "peer-old", name: "Old peer", platform: "test" }, "peer-old");
        (retiredHost as any)?._onPeerLeave("peer-old");
        await Promise.resolve();

        expect(onNewPeer).toHaveBeenCalledOnce();
        expect(onPeerLeaved).toHaveBeenCalledOnce();
    });

    it("holds a finite-only room for the operation and releases it after settlement", async () => {
        const lifecycle = mockRoomTransport();
        const { targetedTransfer, settings } = createServiceHarness();
        settings.P2P_AutoStart = false;
        const operationSettled = createDeferred();
        const replicateFrom = vi.spyOn(TrysteroReplicator.prototype, "replicateFrom").mockImplementation(async () => {
            await operationSettled.promise;
            return { status: "completed", ok: true };
        });

        const operation = targetedTransfer.pullFromPeer("peer-a");
        await vi.waitFor(() => expect(replicateFrom).toHaveBeenCalledOnce());

        try {
            expect(lifecycle).toEqual(["open"]);

            operationSettled.resolve();
            await expect(operation).resolves.toEqual({ status: "completed", ok: true });
            await vi.waitFor(() => expect(lifecycle).toEqual(["open", "close"]));
        } finally {
            operationSettled.resolve();
            await operation.catch(() => undefined);
        }
    });

    it("does not let finite-operation release close a room retained by AutoStart policy", async () => {
        const roomLifecycle = mockRoomTransport();
        const { lifecycle, targetedTransfer, settings } = createServiceHarness();
        await lifecycle.reconcileAutoStart(settings as never);
        const operationSettled = createDeferred();
        const replicateFrom = vi.spyOn(TrysteroReplicator.prototype, "replicateFrom").mockImplementation(async () => {
            await operationSettled.promise;
            return { status: "completed", ok: true };
        });

        const operation = targetedTransfer.pullFromPeer("peer-a");
        await vi.waitFor(() => expect(replicateFrom).toHaveBeenCalledOnce());
        operationSettled.resolve();

        await expect(operation).resolves.toEqual({ status: "completed", ok: true });
        expect(roomLifecycle).toEqual(["open"]);

        settings.P2P_AutoStart = false;
        await lifecycle.reconcileAutoStart(settings as never);
        expect(roomLifecycle).toEqual(["open", "close"]);
    });

    it("does not let finite-operation release close a room retained by later AutoStart demand", async () => {
        const roomLifecycle = mockRoomTransport();
        const { lifecycle, targetedTransfer, settings } = createServiceHarness();
        settings.P2P_SyncOnReplication = "peer-a";
        const operationSettled = createDeferred();
        const replicateFromCommand = vi
            .spyOn(TrysteroReplicator.prototype, "replicateFromCommand")
            .mockImplementation(async () => {
                await operationSettled.promise;
                return { status: "completed", targets: ["peer-a"] };
            });

        const operation = targetedTransfer.synchroniseConfiguredTargets();
        await vi.waitFor(() => expect(replicateFromCommand).toHaveBeenCalledOnce());

        try {
            expect(roomLifecycle).toEqual(["open"]);

            await lifecycle.reconcileAutoStart(settings as never);
            expect(roomLifecycle).toEqual(["open"]);

            operationSettled.resolve();
            await expect(operation).resolves.toEqual({ status: "completed" });
            expect(roomLifecycle).toEqual(["open"]);

            settings.P2P_AutoStart = false;
            await lifecycle.reconcileAutoStart(settings as never);
            expect(roomLifecycle).toEqual(["open", "close"]);
        } finally {
            operationSettled.resolve();
            await operation.catch(() => undefined);
        }
    });

    it("keeps public peer transfers bound to the session admitted by the room owner", async () => {
        mockRoomTransport();
        const { targetedTransfer, transportLifecycle } = createServiceHarness();
        const completed = { status: "completed", ok: true } as const;
        const pull = vi.spyOn(TrysteroReplicator.prototype, "replicateFrom").mockResolvedValue(completed);
        const push = vi.spyOn(TrysteroReplicator.prototype, "requestSynchroniseToPeer").mockResolvedValue(completed);
        const synchronise = vi.spyOn(TrysteroReplicator.prototype, "sync").mockResolvedValue(completed);
        const compatibilityPull = vi
            .spyOn(LiveSyncTrysteroReplicator.prototype, "replicateFrom")
            .mockResolvedValue(completed);
        const compatibilityPush = vi
            .spyOn(LiveSyncTrysteroReplicator.prototype, "requestSynchroniseToPeer")
            .mockResolvedValue(completed);
        const compatibilitySynchronise = vi
            .spyOn(LiveSyncTrysteroReplicator.prototype, "sync")
            .mockResolvedValue(completed);

        await transportLifecycle.connect();
        await expect(targetedTransfer.pullFromPeer("peer-a")).resolves.toEqual(completed);
        await expect(targetedTransfer.requestPushToPeer("peer-a")).resolves.toEqual(completed);
        await expect(targetedTransfer.synchroniseWithPeer("peer-a")).resolves.toEqual(completed);

        expect(pull).toHaveBeenCalledOnce();
        expect(push).toHaveBeenCalledOnce();
        expect(synchronise).toHaveBeenCalledOnce();
        expect(compatibilityPull).not.toHaveBeenCalled();
        expect(compatibilityPush).not.toHaveBeenCalled();
        expect(compatibilitySynchronise).not.toHaveBeenCalled();
    });

    it("binds configured-target discovery to the admitted session lifetime", async () => {
        mockRoomTransport();
        const { targetedTransfer, transportLifecycle, settings } = createServiceHarness();
        settings.P2P_AutoStart = false;
        settings.P2P_SyncOnReplication = "peer-a";
        const legacyRelease = createDeferred();
        let operationSignal: AbortSignal | undefined;
        const replicateFromCommand = vi
            .spyOn(TrysteroReplicator.prototype, "replicateFromCommand")
            .mockImplementation(async (_showResult, _discoveryTimeoutMs, callerSignal) => {
                operationSignal = callerSignal;
                if (callerSignal) {
                    if (!callerSignal.aborted) {
                        await new Promise<void>((resolve) =>
                            callerSignal.addEventListener("abort", () => resolve(), { once: true })
                        );
                    }
                } else {
                    await legacyRelease.promise;
                }
                return { status: "cancelled", targets: [] };
            });

        const operation = targetedTransfer.synchroniseConfiguredTargets();
        await vi.waitFor(() => expect(replicateFromCommand).toHaveBeenCalledOnce());

        try {
            expect(operationSignal).toBeDefined();
            await transportLifecycle.disconnect();
            expect(operationSignal?.aborted).toBe(true);
            await expect(operation).resolves.toMatchObject({ status: "cancelled" });
        } finally {
            legacyRelease.resolve();
            await operation.catch(() => undefined);
        }
    });

    it("keeps direct bidirectional synchronisation within one finite activity boundary", async () => {
        mockRoomTransport();
        const { targetedTransfer, settings, runFiniteReplicationActivity } = createServiceHarness();
        settings.P2P_AutoStart = false;
        vi.spyOn(TrysteroReplicator.prototype, "sync").mockResolvedValue({ status: "completed", ok: true });

        await expect(targetedTransfer.synchroniseWithPeer("peer-a", true)).resolves.toEqual({
            status: "completed",
            ok: true,
        });

        expect(runFiniteReplicationActivity).toHaveBeenCalledOnce();
        expect(runFiniteReplicationActivity.mock.calls[0][1]).toEqual({ label: "replication" });
    });
});
