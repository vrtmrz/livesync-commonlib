import { describe, expect, it, vi } from "vitest";
import { LiveSyncTrysteroReplicator } from "./LiveSyncTrysteroReplicator";

describe("LiveSyncTrysteroReplicator host environment", () => {
    it("forwards raw P2P activity to the shared bounded-activity owner", async () => {
        const runBoundedRemoteActivity = vi.fn(async (task: () => unknown) => await task());
        const replicator = new LiveSyncTrysteroReplicator({
            services: {
                replicator: { runBoundedRemoteActivity },
            },
        } as any);
        const env = (replicator as any)._buildEnv();
        const task = vi.fn(() => "done");

        await expect(env.runBoundedRemoteActivity(task, { label: "replication" })).resolves.toBe("done");

        expect(runBoundedRemoteActivity).toHaveBeenCalledWith(task, { label: "replication" });
    });
});

describe("LiveSyncTrysteroReplicator manual replication", () => {
    it("runs a finite command-triggered synchronisation through the shared activity boundary", async () => {
        const replicateFromCommand = vi.fn(async () => undefined);
        const runBoundedRemoteActivity = vi.fn(async (task: () => unknown) => await task());
        const replicator = new LiveSyncTrysteroReplicator({
            services: {
                replicator: { runBoundedRemoteActivity },
            },
        } as any);
        (replicator as any)._replicator = { replicateFromCommand };

        await replicator.replicateFromCommand(true);

        expect(runBoundedRemoteActivity).toHaveBeenCalledWith(expect.any(Function), {
            label: "replication",
        });
        expect(replicateFromCommand).toHaveBeenCalledWith(true);
    });

    it("tracks a direct pull from a peer as finite remote activity", async () => {
        const replicateFrom = vi.fn(async () => ({ ok: true }));
        const runBoundedRemoteActivity = vi.fn(async (task: () => unknown) => await task());
        const replicator = new LiveSyncTrysteroReplicator({
            services: {
                replicator: { runBoundedRemoteActivity },
            },
        } as any);
        (replicator as any)._replicator = { replicateFrom };

        await expect(replicator.replicateFrom("peer-a", true)).resolves.toEqual({ ok: true });

        expect(runBoundedRemoteActivity).toHaveBeenCalledWith(expect.any(Function), {
            label: "replication",
        });
        expect(replicateFrom).toHaveBeenCalledWith("peer-a", true);
    });

    it("tracks a direct push to a peer as finite remote activity", async () => {
        const requestSynchroniseToPeer = vi.fn(async () => ({ ok: true }));
        const runBoundedRemoteActivity = vi.fn(async (task: () => unknown) => await task());
        const replicator = new LiveSyncTrysteroReplicator({
            services: {
                replicator: { runBoundedRemoteActivity },
            },
        } as any);
        (replicator as any)._replicator = { requestSynchroniseToPeer };

        await expect(replicator.requestSynchroniseToPeer("peer-a")).resolves.toEqual({ ok: true });

        expect(runBoundedRemoteActivity).toHaveBeenCalledWith(expect.any(Function), {
            label: "replication",
        });
        expect(requestSynchroniseToPeer).toHaveBeenCalledWith("peer-a");
    });
});
