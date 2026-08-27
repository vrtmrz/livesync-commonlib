import { afterEach, describe, expect, it, vi } from "vitest";
import type { DiagRTCPeerConnectionMetrics } from "@lib/rpc/transports/DiagRTCPeerConnections.types";
import { LiveSyncP2PService, projectP2PPeerConnectionMetrics } from "./P2PService";
import { createServiceContext } from "@lib/services/base/ServiceBase";
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
    let database = { name: "db-a" };
    const simpleStore = {
        get: vi.fn(async () => undefined),
        set: vi.fn(async () => undefined),
        delete: vi.fn(async () => undefined),
        keys: vi.fn(async () => []),
    };
    const service = new LiveSyncP2PService({
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
                runFiniteReplicationActivity: async (task: () => unknown) => await task(),
                runBoundedRemoteActivity: async (task: () => unknown) => await task(),
            },
            replication: {
                onCheckReplicationReady: async () => true,
                parseSynchroniseResult: async () => undefined,
            },
        },
    } as any);
    addP2PEventHandlers(service, context.events);
    return {
        context,
        service,
        settings,
        replaceDatabase: (name: string) => {
            database = { name };
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
        const { service, settings } = createServiceHarness();

        await service.connect();
        settings.P2P_roomID = "room-b";
        await service.connect();

        expect(lifecycle).toEqual(["open", "close", "open"]);
    });

    it("replaces the room when the local database identity changes", async () => {
        const lifecycle = mockRoomTransport();
        const { service, replaceDatabase } = createServiceHarness();

        await service.connect();
        replaceDatabase("db-b");
        await service.connect();

        expect(lifecycle).toEqual(["open", "close", "open"]);
    });

    it("keeps a published room session bound to the database which created it", async () => {
        mockRoomTransport();
        const { service, replaceDatabase } = createServiceHarness();

        await service.connect();
        const publishedReplicator = service.compatibilityReplicator.rawReplicator;
        const sessionDatabase = publishedReplicator?.db;

        replaceDatabase("db-b");

        expect(publishedReplicator?.db).toBe(sessionDatabase);
    });

    it("keeps a published room session bound to the settings which created it", async () => {
        mockRoomTransport();
        const { service, settings } = createServiceHarness();

        await service.connect();
        const publishedReplicator = service.compatibilityReplicator.rawReplicator;

        settings.P2P_AutoSyncPeers = "peer-b";

        expect(publishedReplicator?.settings.P2P_AutoSyncPeers).toBe("");
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
        const { service, settings } = createServiceHarness();

        const opening = service.connect();
        await vi.waitFor(() => expect(open).toHaveBeenCalledOnce());
        settings.P2P_roomID = "room-b";
        gate.resolve();
        await opening;

        expect(service.isConnected).toBe(false);
        expect(service.compatibilityReplicator.rawReplicator).toBeUndefined();
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
        const { replaceDatabase, service } = createServiceHarness();

        const opening = service.connect();
        await vi.waitFor(() => expect(open).toHaveBeenCalledOnce());
        replaceDatabase("db-b");
        gate.resolve();
        await opening;

        expect(service.isConnected).toBe(false);
        expect(service.compatibilityReplicator.rawReplicator).toBeUndefined();
        expect(close).toHaveBeenCalledOnce();
    });

    it("does not route a retired session's peer event into its replacement", async () => {
        mockRoomTransport();
        const { service, settings } = createServiceHarness();

        await service.connect();
        const retiredHost = service.compatibilityReplicator.rawHost;
        settings.P2P_maxWirePayloadBytes = 800;
        await service.connect();
        const currentHost = service.compatibilityReplicator.rawHost;
        const currentReplicator = service.compatibilityReplicator.rawReplicator;
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
});
