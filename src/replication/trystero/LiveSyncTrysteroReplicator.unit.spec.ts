import { describe, expect, it, vi } from "vitest";
import { LiveSyncTrysteroReplicator } from "./LiveSyncTrysteroReplicator";
import { TrysteroReplicator } from "./TrysteroReplicator";
import { createServiceContext } from "@lib/services/base/ServiceBase";
import type { RemoteDBSettings } from "@lib/common/types";
import { P2PRoomSessionOwner } from "./P2PRoomSessionOwner";

function createDeferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((res) => {
        resolve = res;
    });
    return { promise, resolve };
}

function createLifecycleReplicator(settings: Record<string, unknown> = { P2P_Enabled: true }) {
    return new LiveSyncTrysteroReplicator({
        services: {
            context: createServiceContext(),
            setting: {
                currentSettings: () => settings,
            },
            keyValueDB: {
                openSimpleStore: () => ({}),
            },
            database: { localDatabase: { localDatabase: {} } },
            config: { getSmallConfig: () => "device-a" },
            vault: { getVaultName: () => "vault-a" },
            API: { getPlatform: () => "test", confirm: {} },
            replicator: {
                runFiniteReplicationActivity: async (task: () => unknown) => await task(),
            },
            replication: {
                onCheckReplicationReady: async () => true,
                parseSynchroniseResult: async () => undefined,
            },
        },
    } as any);
}

function createReplicatorWithSession(session: Record<string, unknown>) {
    const owner = {
        currentSession: session,
        isConnected: true,
        cancelActiveTransfers: vi.fn(() => (session.cancelActiveTransfers as (() => void) | undefined)?.()),
        open: vi.fn(async () => undefined),
        close: vi.fn(async () => undefined),
    };
    const replicator = new LiveSyncTrysteroReplicator(
        {
            services: {
                context: createServiceContext(),
                replicator: {
                    runFiniteReplicationActivity: async (task: () => unknown) => await task(),
                    runBoundedRemoteActivity: async (task: () => unknown) => await task(),
                },
            },
        } as any,
        owner as any
    );
    return { owner, replicator };
}

describe("P2PRoomSessionOwner host environment", () => {
    it("forwards raw P2P activity to the shared finite-replication owner", async () => {
        const runFiniteReplicationActivity = vi.fn(async (task: () => unknown) => await task());
        const translate = vi.fn((key: string) => `translated:${key}`);
        const env = {
            services: {
                context: createServiceContext({ translate }),
                replicator: { runFiniteReplicationActivity },
            },
        } as any;
        const owner = new P2PRoomSessionOwner(env);
        const database = {};
        const settings = {};
        const sessionEnv = (owner as any).buildSessionEnv({
            database,
            settings,
            deviceName: "device-a",
            signature: "test",
        });
        const task = vi.fn(() => "done");

        await expect(sessionEnv.runFiniteReplicationActivity(task, { label: "replication" })).resolves.toBe("done");
        expect(sessionEnv.translate("P2P.NotEnabled")).toBe("translated:P2P.NotEnabled");
        expect(sessionEnv.db).toBe(database);
        expect(sessionEnv.settings).toBe(settings);
        expect(sessionEnv.deviceName).toBe("device-a");

        expect(runFiniteReplicationActivity).toHaveBeenCalledWith(task, { label: "replication" });
        expect(translate).toHaveBeenCalledWith("P2P.NotEnabled");
    });
});

describe("LiveSyncTrysteroReplicator remote preferred tweak values", () => {
    it("reports that remote preferred values are unsupported", async () => {
        const replicator = createLifecycleReplicator();

        await expect(replicator.getRemotePreferredTweakValues({} as RemoteDBSettings)).resolves.toEqual({
            status: "unsupported",
        });
    });
});

describe("LiveSyncTrysteroReplicator manual replication", () => {
    it("requests transfer cancellation without closing the room", () => {
        const cancelActiveTransfers = vi.fn();
        const retire = vi.fn();
        const { replicator } = createReplicatorWithSession({ cancelActiveTransfers, retire });

        replicator.terminateSync();

        expect(cancelActiveTransfers).toHaveBeenCalledOnce();
        expect(retire).not.toHaveBeenCalled();
    });

    it("runs a finite command-triggered synchronisation through the shared activity boundary", async () => {
        const replicateFromCommand = vi.fn(async () => undefined);
        const runFiniteReplicationActivity = vi.fn(async (task: () => unknown) => await task());
        const { replicator } = createReplicatorWithSession({ replicator: { replicateFromCommand } });
        (replicator as any).env.services.replicator.runFiniteReplicationActivity = runFiniteReplicationActivity;

        await replicator.replicateFromCommand(true);

        expect(runFiniteReplicationActivity).toHaveBeenCalledWith(expect.any(Function), {
            label: "replication",
        });
        expect(replicateFromCommand).toHaveBeenCalledWith(true);
    });

    it("tracks a direct pull from a peer as finite remote activity", async () => {
        const replicateFrom = vi.fn(async () => ({ ok: true }));
        const runFiniteReplicationActivity = vi.fn(async (task: () => unknown) => await task());
        const { replicator } = createReplicatorWithSession({ replicator: { replicateFrom } });
        (replicator as any).env.services.replicator.runFiniteReplicationActivity = runFiniteReplicationActivity;

        await expect(replicator.replicateFrom("peer-a", true)).resolves.toEqual({ ok: true });

        expect(runFiniteReplicationActivity).toHaveBeenCalledWith(expect.any(Function), {
            label: "replication",
        });
        expect(replicateFrom).toHaveBeenCalledWith("peer-a", true);
    });

    it("marks an explicit rebuild pull so the ordinary replication policy is skipped", async () => {
        const replicateFrom = vi.fn(async () => ({ ok: true }));
        const runFiniteReplicationActivity = vi.fn(async (task: () => unknown) => await task());
        const { replicator } = createReplicatorWithSession({ replicator: { replicateFrom } });
        (replicator as any).env.services.replicator.runFiniteReplicationActivity = runFiniteReplicationActivity;

        await expect(replicator.replicateFrom("peer-a", true, true)).resolves.toEqual({ ok: true });

        expect(replicateFrom).toHaveBeenCalledWith("peer-a", true, false, true);
    });

    it("keeps a direct push broad without presenting it as a local delivery source", async () => {
        const requestSynchroniseToPeer = vi.fn(async () => ({ ok: true }));
        const runBoundedRemoteActivity = vi.fn(async (task: () => unknown) => await task());
        const runFiniteReplicationActivity = vi.fn(async (task: () => unknown) => await task());
        const { replicator } = createReplicatorWithSession({ replicator: { requestSynchroniseToPeer } });
        (replicator as any).env.services.replicator.runBoundedRemoteActivity = runBoundedRemoteActivity;
        (replicator as any).env.services.replicator.runFiniteReplicationActivity = runFiniteReplicationActivity;

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

    it.each([
        ["message-size bound", "P2P_maxWirePayloadBytes", 15_360, 800],
        ["connection path", "P2P_connectionPath", "automatic", "relay"],
    ])("replaces a serving transport when its effective %s changes", async (_label, key, initialValue, nextValue) => {
        vi.restoreAllMocks();
        const lifecycle: string[] = [];
        const settings: Record<string, unknown> = {
            P2P_Enabled: true,
            P2P_maxWirePayloadBytes: 15_360,
            P2P_connectionPath: "automatic",
            P2P_turnServers: "turn:turn.example.com:3478",
            [key]: initialValue,
        };
        vi.spyOn(TrysteroReplicator.prototype, "open").mockImplementation(async function () {
            lifecycle.push("open");
            (this.server as any)._room = {};
        });
        vi.spyOn(TrysteroReplicator.prototype, "close").mockImplementation(async function () {
            lifecycle.push("close");
            (this.server as any)._room = undefined;
        });
        const replicator = createLifecycleReplicator(settings);

        await replicator.open();
        const firstTransport = replicator.rawReplicator;
        settings[key] = nextValue;
        await replicator.open();

        expect(lifecycle).toEqual(["open", "close", "open"]);
        expect(replicator.rawReplicator).not.toBe(firstTransport);
        expect(replicator.rawHost?.isServing).toBe(true);
    });
});
