import { describe, expect, it, vi } from "vitest";
import { RpcRoom, type RpcWireMessage, type TransportAdapter } from "@lib/rpc";
import { createLiveSyncEventHub } from "@lib/hub/hub";
import { TrysteroReplicator } from "./TrysteroReplicator";
import { TrysteroReplicatorP2PClient } from "./TrysteroReplicatorP2PClient";

function notificationPair(accept: () => boolean) {
    let receive: ((message: RpcWireMessage, peerId: string) => void) | undefined;
    const source = new RpcRoom({
        transport: {
            send: (message) => receive?.(message, "source"),
            onMessage: () => () => {},
        },
    });
    const target = new RpcRoom({
        transport: {
            send: () => {},
            onMessage: (handler) => {
                receive = handler;
                return () => {
                    receive = undefined;
                };
            },
        } satisfies TransportAdapter,
        canAcceptRequest: accept,
    });
    const settings = { P2P_Enabled: true, P2P_AutoSyncPeers: "", P2P_AutoWatchPeers: "" };
    const server = {
        rpcRoom: source,
        serverPeerId: "source",
        knownAdvertisements: [{ peerId: "target", name: "target", platform: "test" }],
        isAcceptablePeer: vi.fn(async () => true),
        getConnection: (_peerId: string) => new TrysteroReplicatorP2PClient(server as any, "target"),
    };
    const replicator = new TrysteroReplicator(
        {
            events: createLiveSyncEventHub(),
            translate: (key: string) => key,
            settings,
            currentSettings: () => settings,
            db: {},
            simpleStore: {},
            deviceName: "source",
            platform: "test",
            confirm: {},
            processReplicatedDocs: vi.fn(),
        } as any,
        server as any
    );
    replicator._isBroadcasting = true;
    return { source, target, server, replicator };
}

describe("P2P best-effort change notifications", () => {
    it("delivers a later notification after the first notification is rejected", async () => {
        let accepted = false;
        const admission = vi.fn(() => accepted);
        const pair = notificationPair(admission);
        const received = vi.fn();
        pair.target.register("legacy/onProgress", received);
        try {
            await pair.replicator.notifyProgress();
            await vi.waitFor(() => expect(admission).toHaveBeenCalledTimes(1));
            expect(received).not.toHaveBeenCalled();
            accepted = true;
            await pair.replicator.notifyProgress();
            await vi.waitFor(() => expect(received).toHaveBeenCalledExactlyOnceWith("source", "source"), {
                timeout: 250,
            });
        } finally {
            pair.source.close();
            pair.target.close();
        }
    });

    it("sends another notification while a previous remote handler is still running", async () => {
        const pair = notificationPair(() => true);
        let finish!: () => void;
        const held = new Promise<void>((resolve) => {
            finish = resolve;
        });
        let started = 0;
        pair.target.register("legacy/onProgress", async () => {
            started++;
            if (started === 1) {
                await held;
            }
        });
        try {
            await pair.replicator.notifyProgress();
            await vi.waitFor(() => expect(started).toBe(1));
            await pair.replicator.notifyProgress();
            await vi.waitFor(() => expect(started).toBe(2), { timeout: 250 });
        } finally {
            finish();
            pair.source.close();
            pair.target.close();
        }
    });

    it.each(["broadcast", "room"] as const)("does not send after %s changes during admission", async (change) => {
        const pair = notificationPair(() => true);
        let admit!: (accepted: boolean) => void;
        pair.server.isAcceptablePeer.mockImplementation(
            () =>
                new Promise<boolean>((resolve) => {
                    admit = resolve;
                })
        );
        const received = vi.fn();
        pair.target.register("legacy/onProgress", received);
        const replacement = new RpcRoom({ transport: { send: () => {}, onMessage: () => () => {} } });
        try {
            await pair.replicator.notifyProgress();
            await vi.waitFor(() => expect(admit).toBeTypeOf("function"));
            if (change === "broadcast") {
                pair.replicator._isBroadcasting = false;
            } else {
                pair.server.rpcRoom = replacement;
            }
            admit(true);
            await new Promise<void>((resolve) => setImmediate(resolve));
            expect(received).not.toHaveBeenCalled();
        } finally {
            pair.source.close();
            pair.target.close();
            replacement.close();
        }
    });
});
