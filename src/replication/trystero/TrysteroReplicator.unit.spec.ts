import { describe, expect, it, vi } from "vitest";
import { TrysteroReplicator } from "./TrysteroReplicator";
import { createLiveSyncEventHub } from "@lib/hub/hub";
import { EVENT_P2P_REPLICATOR_STATUS } from "./TrysteroReplicatorP2PServer";

function createReplicator(settings: Record<string, unknown> = {}) {
    const runFiniteReplicationActivity = vi.fn(async (task: () => unknown) => await task());
    const events = createLiveSyncEventHub();
    const replicator = new TrysteroReplicator(
        {
            events,
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
    return { events, replicator, runFiniteReplicationActivity };
}

describe("TrysteroReplicator automatic remote activity", () => {
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
        const sync = vi.spyOn(replicator, "sync").mockResolvedValue(undefined);

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
        const watchPeer = vi.spyOn(replicator, "watchPeer");

        await replicator.onNewPeer({ peerId: "peer-id", name: "peer-a", platform: "test" });

        expect(watchPeer).toHaveBeenCalledWith("peer-id");
        expect(replicator._watchingPeers).toContain("peer-id");
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
