import { describe, expect, it, vi } from "vitest";
import { TrysteroReplicator } from "./TrysteroReplicator";
import { createLiveSyncEventHub } from "@lib/hub/hub";

function createReplicator(settings: Record<string, unknown> = {}) {
    const runFiniteReplicationActivity = vi.fn(async (task: () => unknown) => await task());
    const replicator = new TrysteroReplicator(
        {
            events: createLiveSyncEventHub(),
            translate: (key: string) => key,
            settings: {
                P2P_AutoSyncPeers: "",
                P2P_AutoWatchPeers: "",
                ...settings,
            },
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
        } as any
    );
    return { replicator, runFiniteReplicationActivity };
}

describe("TrysteroReplicator automatic remote activity", () => {
    it("tracks automatic synchronisation when a configured peer is discovered", async () => {
        const { replicator, runFiniteReplicationActivity } = createReplicator({
            P2P_AutoSyncPeers: "peer-a",
        });
        const sync = vi.spyOn(replicator, "sync").mockResolvedValue(undefined);

        await replicator.onNewPeer({ peerId: "peer-id", name: "peer-a", platform: "test" });

        expect(runFiniteReplicationActivity).toHaveBeenCalledWith(expect.any(Function), {
            label: "replication",
        });
        expect(sync).toHaveBeenCalledWith("peer-id");
    });

    it("tracks a pull requested by a remote peer", async () => {
        const { replicator, runFiniteReplicationActivity } = createReplicator();
        const replicateFrom = vi.spyOn(replicator, "replicateFrom").mockResolvedValue({ ok: true });

        await replicator.getCommands().reqSync("peer-id");

        expect(runFiniteReplicationActivity).toHaveBeenCalledWith(expect.any(Function), {
            label: "replication",
        });
        expect(replicateFrom).toHaveBeenCalledWith("peer-id");
    });

    it("tracks a watched pull after a peer reports progress", async () => {
        const { replicator, runFiniteReplicationActivity } = createReplicator();
        const replicateFrom = vi.spyOn(replicator, "replicateFrom").mockResolvedValue({ ok: true });
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
        const sync = vi.spyOn(replicator, "sync").mockResolvedValue(undefined);

        await replicator.onNewPeer({ peerId: "peer-id", name: "peer-a", platform: "test" });

        expect(sync).toHaveBeenCalledWith("peer-id");
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
