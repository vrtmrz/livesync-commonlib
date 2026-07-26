import { describe, expect, it, vi } from "vitest";
import { LiveSyncTrysteroReplicator } from "./LiveSyncTrysteroReplicator";
import { TrysteroReplicator } from "./TrysteroReplicator";
import { createServiceContext } from "@lib/services/base/ServiceBase";

function createDeferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((res) => {
        resolve = res;
    });
    return { promise, resolve };
}

function createLifecycleReplicator() {
    return new LiveSyncTrysteroReplicator({
        services: {
            context: createServiceContext(),
            setting: {
                currentSettings: () => ({ P2P_Enabled: true }),
            },
            keyValueDB: {
                openSimpleStore: () => ({}),
            },
        },
    } as any);
}

describe("LiveSyncTrysteroReplicator host environment", () => {
    it("forwards raw P2P activity to the shared finite-replication owner", async () => {
        const runFiniteReplicationActivity = vi.fn(async (task: () => unknown) => await task());
        const translate = vi.fn((key: string) => `translated:${key}`);
        const replicator = new LiveSyncTrysteroReplicator({
            services: {
                context: createServiceContext({ translate }),
                replicator: { runFiniteReplicationActivity },
            },
        } as any);
        const env = (replicator as any)._buildEnv();
        const task = vi.fn(() => "done");

        await expect(env.runFiniteReplicationActivity(task, { label: "replication" })).resolves.toBe("done");
        expect(env.translate("P2P.NotEnabled")).toBe("translated:P2P.NotEnabled");

        expect(runFiniteReplicationActivity).toHaveBeenCalledWith(task, { label: "replication" });
        expect(translate).toHaveBeenCalledWith("P2P.NotEnabled");
    });
});

describe("LiveSyncTrysteroReplicator manual replication", () => {
    it("runs a finite command-triggered synchronisation through the shared activity boundary", async () => {
        const replicateFromCommand = vi.fn(async () => undefined);
        const runFiniteReplicationActivity = vi.fn(async (task: () => unknown) => await task());
        const replicator = new LiveSyncTrysteroReplicator({
            services: {
                context: createServiceContext(),
                replicator: { runFiniteReplicationActivity },
            },
        } as any);
        (replicator as any)._replicator = { replicateFromCommand };

        await replicator.replicateFromCommand(true);

        expect(runFiniteReplicationActivity).toHaveBeenCalledWith(expect.any(Function), {
            label: "replication",
        });
        expect(replicateFromCommand).toHaveBeenCalledWith(true);
    });

    it("tracks a direct pull from a peer as finite remote activity", async () => {
        const replicateFrom = vi.fn(async () => ({ ok: true }));
        const runFiniteReplicationActivity = vi.fn(async (task: () => unknown) => await task());
        const replicator = new LiveSyncTrysteroReplicator({
            services: {
                context: createServiceContext(),
                replicator: { runFiniteReplicationActivity },
            },
        } as any);
        (replicator as any)._replicator = { replicateFrom };

        await expect(replicator.replicateFrom("peer-a", true)).resolves.toEqual({ ok: true });

        expect(runFiniteReplicationActivity).toHaveBeenCalledWith(expect.any(Function), {
            label: "replication",
        });
        expect(replicateFrom).toHaveBeenCalledWith("peer-a", true);
    });

    it("marks an explicit rebuild pull so the ordinary replication policy is skipped", async () => {
        const replicateFrom = vi.fn(async () => ({ ok: true }));
        const runFiniteReplicationActivity = vi.fn(async (task: () => unknown) => await task());
        const replicator = new LiveSyncTrysteroReplicator({
            services: {
                context: createServiceContext(),
                replicator: { runFiniteReplicationActivity },
            },
        } as any);
        (replicator as any)._replicator = { replicateFrom };

        await expect(replicator.replicateFrom("peer-a", true, true)).resolves.toEqual({ ok: true });

        expect(replicateFrom).toHaveBeenCalledWith("peer-a", true, false, true);
    });

    it("keeps a direct push broad without presenting it as a local delivery source", async () => {
        const requestSynchroniseToPeer = vi.fn(async () => ({ ok: true }));
        const runBoundedRemoteActivity = vi.fn(async (task: () => unknown) => await task());
        const runFiniteReplicationActivity = vi.fn(async (task: () => unknown) => await task());
        const replicator = new LiveSyncTrysteroReplicator({
            services: {
                context: createServiceContext(),
                replicator: { runBoundedRemoteActivity, runFiniteReplicationActivity },
            },
        } as any);
        (replicator as any)._replicator = { requestSynchroniseToPeer };

        await expect(replicator.requestSynchroniseToPeer("peer-a")).resolves.toEqual({ ok: true });

        expect(runBoundedRemoteActivity).toHaveBeenCalledWith(expect.any(Function), {
            label: "replication",
        });
        expect(runFiniteReplicationActivity).not.toHaveBeenCalled();
        expect(requestSynchroniseToPeer).toHaveBeenCalledWith("peer-a");
    });
});

describe("LiveSyncTrysteroReplicator transport lifecycle", () => {
    it("shares one transport while concurrent open requests are pending", async () => {
        const gate = createDeferred();
        const open = vi.spyOn(TrysteroReplicator.prototype, "open").mockImplementation(async function () {
            await gate.promise;
            (this.server as any)._room = {};
        });
        const replicator = createLifecycleReplicator();

        const first = replicator.open();
        await vi.waitFor(() => expect(open).toHaveBeenCalledOnce());
        const second = replicator.open();

        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(open).toHaveBeenCalledOnce();

        gate.resolve();
        await Promise.all([first, second]);
        expect(replicator.rawHost?.isServing).toBe(true);
    });

    it("does not leave an orphan transport serving when close is requested during open", async () => {
        const gate = createDeferred();
        let openedTransport: TrysteroReplicator | undefined;
        vi.spyOn(TrysteroReplicator.prototype, "open").mockImplementation(async function () {
            openedTransport = this;
            await gate.promise;
            (this.server as any)._room = {};
        });
        const close = vi.spyOn(TrysteroReplicator.prototype, "close").mockImplementation(async function () {
            (this.server as any)._room = undefined;
        });
        const replicator = createLifecycleReplicator();

        const opening = replicator.open();
        await vi.waitFor(() => expect(openedTransport).toBeDefined());
        const closing = replicator.close();
        gate.resolve();

        await Promise.all([opening, closing]);

        expect(close).toHaveBeenCalledOnce();
        expect(openedTransport?.server?.isServing).toBe(false);
        expect(replicator.rawReplicator).toBeUndefined();
        expect(replicator.rawHost).toBeUndefined();
    });
});
