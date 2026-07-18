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
});
