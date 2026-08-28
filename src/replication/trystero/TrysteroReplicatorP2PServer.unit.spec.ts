import { beforeEach, describe, expect, it, vi } from "vitest";

import { createLiveSyncEventHub } from "@lib/hub/hub";
import { EVENT_PLATFORM_UNLOADED } from "@lib/events/coreEvents";

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

import {
    EVENT_ADVERTISEMENT_RECEIVED,
    EVENT_DEVICE_LEAVED,
    EVENT_SERVER_STATUS,
    P2PHost,
} from "./TrysteroReplicatorP2PServer";

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

    it("keeps its platform-unload subscription across a transport shutdown", async () => {
        const events = createLiveSyncEventHub();
        const host = new P2PHost({
            events,
            simpleStore: {},
            settings: { P2P_Enabled: true },
        } as any);
        const shutdown = vi.spyOn(host, "shutdown");

        await host.shutdown();
        events.emitEvent(EVENT_PLATFORM_UNLOADED);
        await Promise.resolve();

        expect(shutdown).toHaveBeenCalledTimes(2);
    });

    it("removes its platform-unload subscription when the host is disposed", async () => {
        const events = createLiveSyncEventHub();
        const host = new P2PHost({
            events,
            simpleStore: {},
            settings: { P2P_Enabled: true },
        } as any);
        const shutdown = vi.spyOn(host, "shutdown");

        host.dispose();
        events.emitEvent(EVENT_PLATFORM_UNLOADED);
        await Promise.resolve();

        expect(shutdown).not.toHaveBeenCalled();
    });

    it("does not publish late peer or status events after disposal", async () => {
        const events = createLiveSyncEventHub();
        const advertisement = vi.fn();
        const peerLeft = vi.fn();
        const status = vi.fn();
        events.onEvent(EVENT_ADVERTISEMENT_RECEIVED, advertisement);
        events.onEvent(EVENT_DEVICE_LEAVED, peerLeft);
        events.onEvent(EVENT_SERVER_STATUS, status);
        const host = new P2PHost({
            events,
            simpleStore: {
                get: vi.fn(async () => undefined),
                set: vi.fn(async () => undefined),
                delete: vi.fn(async () => undefined),
                keys: vi.fn(async () => []),
            },
            settings: { P2P_Enabled: true },
        } as any);

        host.dispose();
        host.onAdvertisement({ peerId: "peer-a", name: "Device A", platform: "test" }, "peer-a");
        (host as any)._onPeerLeave("peer-a");
        await host.dispatchConnectionStatus();

        expect(advertisement).not.toHaveBeenCalled();
        expect(peerLeft).not.toHaveBeenCalled();
        expect(status).not.toHaveBeenCalled();
    });

    it("reports an undecided peer without opening the acceptance dialogue", async () => {
        const confirmUserToAccept = vi.fn(async () => true);
        const host = new P2PHost({
            events: createLiveSyncEventHub(),
            simpleStore: {
                get: vi.fn(async () => undefined),
                set: vi.fn(async () => undefined),
                delete: vi.fn(async () => undefined),
                keys: vi.fn(async () => []),
            },
            settings: {
                P2P_Enabled: true,
                P2P_AutoAccepting: 0,
                P2P_AutoAcceptingPeers: "",
                P2P_AutoDenyingPeers: "",
                P2P_IsHeadless: false,
            },
        } as any);
        host.onAdvertisement({ peerId: "peer-a", name: "Device A", platform: "test" }, "peer-a");
        vi.spyOn(host, "confirmUserToAccept").mockImplementation(confirmUserToAccept);

        await expect(host.evaluatePeerAcceptance("peer-a")).resolves.toBe("undecided");

        expect(confirmUserToAccept).not.toHaveBeenCalled();
    });

    it("reports persisted, temporary, automatic, denied, and unknown peer acceptance explicitly", async () => {
        const decisions = new Map<string, boolean>([["Persisted device", true]]);
        const host = new P2PHost({
            events: createLiveSyncEventHub(),
            simpleStore: {
                get: vi.fn(async (key: string) => decisions.get(key.replace(/^p2p-device-decisions-/, ""))),
                set: vi.fn(async () => undefined),
                delete: vi.fn(async () => undefined),
                keys: vi.fn(async () => []),
            },
            settings: {
                P2P_Enabled: true,
                P2P_AutoAccepting: 0,
                P2P_AutoAcceptingPeers: "Automatic device, Denied device",
                P2P_AutoDenyingPeers: "Denied device",
                P2P_IsHeadless: true,
            },
        } as any);
        const advertisements = [
            { peerId: "persisted", name: "Persisted device", platform: "test" },
            { peerId: "temporary", name: "Temporary device", platform: "test" },
            { peerId: "automatic", name: "Automatic device", platform: "test" },
            { peerId: "denied", name: "Denied device", platform: "test" },
        ];
        for (const peer of advertisements) host.onAdvertisement(peer, peer.peerId);
        host.temporaryAcceptedPeers.set("temporary", false);
        vi.spyOn(host.acceptedPeers, "get").mockImplementation(async (name) => decisions.get(name));

        await expect(host.evaluatePeerAcceptance("persisted")).resolves.toBe("accepted");
        await expect(host.evaluatePeerAcceptance("temporary")).resolves.toBe("rejected");
        await expect(host.evaluatePeerAcceptance("automatic")).resolves.toBe("accepted");
        await expect(host.evaluatePeerAcceptance("denied")).resolves.toBe("rejected");
        await expect(host.evaluatePeerAcceptance("unknown")).resolves.toBe("unknown");
    });

    it("reads current automatic admission policy without replacing the host", async () => {
        const sessionSettings = {
            P2P_Enabled: true,
            P2P_AutoAccepting: 0,
            P2P_AutoAcceptingPeers: "",
            P2P_AutoDenyingPeers: "",
            P2P_IsHeadless: true,
        };
        const currentSettings = { ...sessionSettings };
        const host = new P2PHost({
            events: createLiveSyncEventHub(),
            simpleStore: {
                get: vi.fn(async () => undefined),
                set: vi.fn(async () => undefined),
                delete: vi.fn(async () => undefined),
                keys: vi.fn(async () => []),
            },
            settings: sessionSettings,
            currentSettings: () => currentSettings,
        } as any);
        host.onAdvertisement({ peerId: "peer-a", name: "Device A", platform: "test" }, "peer-a");

        await expect(host.evaluatePeerAcceptance("peer-a")).resolves.toBe("undecided");
        currentSettings.P2P_AutoAcceptingPeers = "Device A";
        await expect(host.evaluatePeerAcceptance("peer-a")).resolves.toBe("accepted");
        currentSettings.P2P_AutoDenyingPeers = "Device A";
        await expect(host.evaluatePeerAcceptance("peer-a")).resolves.toBe("rejected");
    });
});
