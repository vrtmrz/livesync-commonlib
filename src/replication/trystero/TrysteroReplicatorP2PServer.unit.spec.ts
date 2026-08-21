import { beforeEach, describe, expect, it, vi } from "vitest";

import { createLiveSyncEventHub } from "@lib/hub/hub";

const { rpcRoomOptions } = vi.hoisted(() => ({
    rpcRoomOptions: [] as unknown[],
}));

vi.mock("@lib/rpc", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@lib/rpc")>();
    return {
        ...actual,
        RpcRoom: class MockRpcRoom {
            constructor(options: unknown) {
                rpcRoomOptions.push(options);
            }

            close() {}

            register() {}
        },
    };
});

import { P2PHost } from "./TrysteroReplicatorP2PServer";

describe("P2PHost transport configuration and ownership", () => {
    beforeEach(() => {
        rpcRoomOptions.length = 0;
    });

    it("leaves the room without closing Trystero-owned peer connections directly", async () => {
        const closePeerConnection = vi.fn();
        const leave = vi.fn(async () => undefined);
        const host = new P2PHost({
            events: createLiveSyncEventHub(),
            simpleStore: {},
            settings: { P2P_Enabled: true },
        } as any);
        (host as any)._room = {
            getPeers: () => ({
                "peer-a": { close: closePeerConnection },
            }),
            leave,
        };

        await host.close();

        expect(leave).toHaveBeenCalledOnce();
        expect(closePeerConnection).not.toHaveBeenCalled();
        expect(host.room).toBeUndefined();
        expect(host.rpcRoom).toBeUndefined();
    });

    it("passes the configured wire-payload bound to RpcRoom", () => {
        const host = new P2PHost({
            events: createLiveSyncEventHub(),
            simpleStore: {},
            settings: {
                P2P_Enabled: true,
                P2P_maxWirePayloadBytes: 800,
            },
        } as any);
        (host as any)._room = {
            makeAction: vi.fn(() => ({
                send: vi.fn(async () => undefined),
                onMessage: null,
            })),
            onPeerJoin: null,
            onPeerLeave: null,
        };

        host.onAfterJoinRoom();

        expect(rpcRoomOptions.at(-1)).toMatchObject({
            maxWirePayloadBytes: 800,
        });
    });
});
