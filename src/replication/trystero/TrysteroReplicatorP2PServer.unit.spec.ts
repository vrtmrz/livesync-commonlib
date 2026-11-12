import { beforeEach, describe, expect, it, vi } from "vitest";

import { createLiveSyncEventHub } from "@lib/hub/hub";
import { EVENT_PLATFORM_UNLOADED } from "@lib/events/coreEvents";
import { DEFAULT_SETTINGS, type P2PSyncSetting } from "@lib/common/types";
import type { SimpleStore } from "@lib/common/utils";
import type { Confirm } from "@lib/interfaces/Confirm";
import type { Room } from "@trystero-p2p/nostr";

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
import type { Request } from "./types";

const createDecisionHost = (
    dialogueResult: "Accept" | "Ignore" | "Accept Temporarily" | "Ignore Temporarily" | false = false
) => {
    const storedValues = new Map<string, unknown>();
    const simpleStore: SimpleStore<unknown> = {
        db: undefined,
        get: vi.fn(async (key: string) => storedValues.get(key)),
        set: vi.fn(async (key: string, value: unknown) => {
            storedValues.set(key, value);
        }),
        delete: vi.fn(async (key: string) => {
            storedValues.delete(key);
        }),
        keys: vi.fn(async () => [...storedValues.keys()]),
    };
    const askSelectStringDialogue = vi.fn(async () => dialogueResult) as Confirm["askSelectStringDialogue"];
    const confirm: Pick<Confirm, "askSelectStringDialogue"> = { askSelectStringDialogue };
    const settings: P2PSyncSetting = {
        ...DEFAULT_SETTINGS,
        P2P_Enabled: true,
        P2P_IsHeadless: true,
    };
    const events = createLiveSyncEventHub();
    const host = new P2PHost(
        {
            events,
            simpleStore,
            settings,
            confirm,
        } as ConstructorParameters<typeof P2PHost>[0],
        "server-peer"
    );
    const dispatchConnectionStatus = vi.spyOn(host, "dispatchConnectionStatus").mockResolvedValue(undefined);
    return { host, simpleStore, storedValues, askSelectStringDialogue, events, dispatchConnectionStatus };
};

describe("P2PHost peer decisions and RPC admission", () => {
    it.each([
        ["Accept", true, false],
        ["Ignore", false, false],
        ["Accept Temporarily", true, true],
        ["Ignore Temporarily", false, true],
    ] as const)("applies the %s dialogue choice to the expected peer scope", async (choice, accepted, temporary) => {
        const { host, simpleStore, askSelectStringDialogue, dispatchConnectionStatus } = createDecisionHost(choice);
        host.onAdvertisement({ peerId: "peer-a", name: "Device A", platform: "test" }, "peer-a");
        dispatchConnectionStatus.mockClear();

        await expect(host.confirmUserToAccept("peer-a")).resolves.toBe(accepted);

        expect(askSelectStringDialogue).toHaveBeenCalledExactlyOnceWith(
            expect.stringContaining("Device A (peer-a)"),
            ["Accept", "Ignore", "Accept Temporarily", "Ignore Temporarily"],
            { title: "P2P Connection Request", defaultAction: "Ignore Temporarily", timeout: 30 }
        );
        expect(dispatchConnectionStatus).toHaveBeenCalledOnce();
        if (temporary) {
            expect(host.temporaryAcceptedPeers.get("peer-a")).toBe(accepted);
            expect(simpleStore.set).not.toHaveBeenCalled();
        } else {
            expect(host.temporaryAcceptedPeers.has("peer-a")).toBe(false);
            expect(simpleStore.set).toHaveBeenCalledExactlyOnceWith(host.acceptedPeers.addPrefix("Device A"), accepted);
        }
    });

    it("rejects a cancelled or unknown peer confirmation without changing admission state", async () => {
        const cancelled = createDecisionHost(false);
        cancelled.host.onAdvertisement({ peerId: "peer-a", name: "Device A", platform: "test" }, "peer-a");

        await expect(cancelled.host.confirmUserToAccept("peer-a")).rejects.toThrow(
            "Response prevented: User Accepting failed"
        );
        expect(cancelled.simpleStore.set).not.toHaveBeenCalled();
        expect(cancelled.host.temporaryAcceptedPeers.has("peer-a")).toBe(false);

        const unknown = createDecisionHost("Accept");
        await expect(unknown.host.confirmUserToAccept("unknown-peer")).rejects.toThrow("Unknown Peer");
        expect(unknown.askSelectStringDialogue).not.toHaveBeenCalled();
    });

    it.each([
        { decision: true, isTemporary: false },
        { decision: false, isTemporary: false },
        { decision: true, isTemporary: true },
        { decision: false, isTemporary: true },
    ])("stores and revokes the $isTemporary $decision peer decision", async ({ decision, isTemporary }) => {
        const { host, simpleStore, storedValues, dispatchConnectionStatus } = createDecisionHost();
        const peer = { peerId: "peer-a", name: "Device A", decision, isTemporary };
        const storageKey = host.acceptedPeers.addPrefix(peer.name);

        await host.makeDecision(peer);

        expect(dispatchConnectionStatus).toHaveBeenCalledOnce();
        if (isTemporary) {
            expect(host.temporaryAcceptedPeers.get(peer.peerId)).toBe(decision);
            expect(simpleStore.set).not.toHaveBeenCalled();
        } else {
            expect(simpleStore.set).toHaveBeenCalledExactlyOnceWith(storageKey, decision);
            expect(storedValues.get(storageKey)).toBe(decision);
        }

        await host.revokeDecision({ peerId: peer.peerId, name: peer.name });

        expect(host.temporaryAcceptedPeers.has(peer.peerId)).toBe(false);
        expect(simpleStore.delete).toHaveBeenCalledExactlyOnceWith(storageKey);
        await expect(host.acceptedPeers.get(peer.name)).resolves.toBeUndefined();
        expect(dispatchConnectionStatus).toHaveBeenCalledTimes(2);
    });

    it("admits accepted requests, rejects unknown peers, and routes control responses", async () => {
        const accepted = createDecisionHost();
        accepted.host.onAdvertisement({ peerId: "peer-a", name: "Device A", platform: "test" }, "peer-a");
        await accepted.host.makeDecision({
            peerId: "peer-a",
            name: "Device A",
            decision: true,
            isTemporary: true,
        });
        const acceptedRequest: Request = { type: "replicate", direction: "request", seq: 1, args: [] };
        const handleRequest = vi.spyOn(accepted.host, "__onRequest").mockResolvedValue(undefined);

        await accepted.host.processArrivedRPC(acceptedRequest, "peer-a");

        expect(handleRequest).toHaveBeenCalledExactlyOnceWith(acceptedRequest, "peer-a");

        const rejected = createDecisionHost();
        const rejectedRequest = vi.spyOn(rejected.host, "__onRequest").mockResolvedValue(undefined);
        await expect(rejected.host.processArrivedRPC(acceptedRequest, "unknown-peer")).rejects.toThrow(
            "Not acceptable peer unknown-peer"
        );
        expect(rejectedRequest).not.toHaveBeenCalled();

        const handleResponse = vi.spyOn(rejected.host, "__onResponse");
        const controlResponse = { type: "!reqAuth", direction: "response" as const, seq: 2, data: true };
        await rejected.host.processArrivedRPC(controlResponse, "unknown-peer");
        expect(handleResponse).toHaveBeenCalledExactlyOnceWith(controlResponse, "unknown-peer");
    });

    it("caches peer clients until close and rejects peers without an advertisement", async () => {
        const { host } = createDecisionHost();
        host.onAdvertisement({ peerId: "peer-a", name: "Device A", platform: "test" }, "peer-a");

        const client = host.getConnection("peer-a");

        expect(host.getConnection("peer-a")).toBe(client);
        expect(() => host.getConnection("unknown-peer")).toThrow("Unknown Peer unknown-peer");

        await host.close();
        expect(client.remoteDB).toBeUndefined();
        expect(host.knownAdvertisements).toEqual([]);
        expect(() => host.getConnection("peer-a")).toThrow("Unknown Peer peer-a");
    });

    it("forwards room peer departures through the registered callback", async () => {
        const { host, events } = createDecisionHost();
        const onPeerLeft = vi.fn();
        const peerLeftEvent = vi.fn();
        const advertisement = { peerId: "peer-a", name: "Device A", platform: "test" };
        const room = {
            makeAction: vi.fn(() => ({ send: vi.fn(async () => undefined), onMessage: null })),
            leave: vi.fn(async () => undefined),
            onPeerJoin: null as ((peerId: string) => void) | null,
            onPeerLeave: null as ((peerId: string) => void) | null,
        } as unknown as Room;
        events.onEvent(EVENT_DEVICE_LEAVED, peerLeftEvent);
        host.setSessionPeerHandlers({ onAdvertisement: vi.fn(), onPeerLeft });
        host.onAdvertisement(advertisement, advertisement.peerId);
        await host.setRoom(room);
        host.onAfterJoinRoom();

        const options = rpcRoomOptions.at(-1) as {
            transport: { onPeerLeave: (handler: (peerId: string) => void) => () => void };
        };
        const unsubscribe = options.transport.onPeerLeave(vi.fn());
        room.onPeerLeave?.(advertisement.peerId);
        await Promise.resolve();

        expect(host.knownAdvertisements).toEqual([]);
        expect(onPeerLeft).toHaveBeenCalledExactlyOnceWith(advertisement.peerId);
        expect(peerLeftEvent).toHaveBeenCalledExactlyOnceWith(advertisement.peerId);

        unsubscribe();
        await host.shutdown();
        host.dispose();
    });
});

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

    it("decomposes a deprecated RPC handler error before sending it", async () => {
        const host = new P2PHost({
            events: createLiveSyncEventHub(),
            simpleStore: {},
            settings: { P2P_Enabled: true },
        } as any);
        host.assignedFunctions.set("fail", () => {
            throw new Error("legacy failure");
        });
        const send = vi.spyOn(host, "__send").mockResolvedValue(undefined);

        await host.__onRequest({ type: "fail", direction: "request", seq: 1, args: [] }, "peer-a");

        const payload = send.mock.calls[0][0];
        expect(JSON.parse(JSON.stringify(payload.error))).toEqual({
            code: "REMOTE_ERROR",
            message: "legacy failure",
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

    it.each(["_acceptablePeers", "_shouldDenyPeers"] as const)(
        "preserves peer-pattern matching for %s",
        async (property) => {
            const host = new P2PHost({ events: createLiveSyncEventHub(), simpleStore: {}, settings: {} } as any);
            const patterns = " Device A , , ~tablet, phone. ";
            const settings = { P2P_AutoAcceptingPeers: patterns, P2P_AutoDenyingPeers: patterns } as any;
            const result = await host[property].update(settings);
            const matches = (name: string) => result.value.some((pattern) => pattern.test(name));
            expect(["device a", "old TABLET backup", "phone1"].map(matches)).toEqual([true, true, true]);
            expect(["prefix Device A", "DeviceA", "phone12", ""].map(matches)).toEqual([false, false, false, false]);
        }
    );

    it.each(["_acceptablePeers", "_shouldDenyPeers"] as const)(
        "retains empty defaults and invalid-pattern rejection for %s",
        async (property) => {
            const host = new P2PHost({ events: createLiveSyncEventHub(), simpleStore: {}, settings: {} } as any);
            expect((await host[property].update({} as any)).value).toEqual([]);
            const invalid = await host[property].update({
                P2P_AutoAcceptingPeers: "[",
                P2P_AutoDenyingPeers: "[",
            } as any);
            expect(() => invalid.value).toThrow(SyntaxError);
        }
    );

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

    it("materialises automatic acceptance without opening a dialogue", async () => {
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
                P2P_IsHeadless: false,
            },
        } as any);
        host._knownAdvertisements.set("peer-a", {
            peerId: "peer-a",
            name: "Device A",
            platform: "test",
        });
        vi.spyOn(host, "evaluatePeerAcceptance").mockResolvedValue("accepted");
        vi.spyOn(host.acceptedPeers, "get").mockResolvedValue(undefined);
        const dispatchConnectionStatus = vi.spyOn(host, "dispatchConnectionStatus").mockResolvedValue(undefined);
        const confirmUserToAccept = vi.spyOn(host, "confirmUserToAccept");

        await expect(host.isAcceptablePeer("peer-a")).resolves.toBe(true);

        expect(host.temporaryAcceptedPeers.get("peer-a")).toBe(true);
        expect(dispatchConnectionStatus).toHaveBeenCalledOnce();
        expect(confirmUserToAccept).not.toHaveBeenCalled();
    });

    it("rejects an undecided peer in a headless host without opening a dialogue", async () => {
        const host = new P2PHost({
            events: createLiveSyncEventHub(),
            simpleStore: {},
            settings: {
                P2P_Enabled: true,
                P2P_IsHeadless: true,
            },
        } as any);
        vi.spyOn(host, "evaluatePeerAcceptance").mockResolvedValue("undecided");
        const confirmUserToAccept = vi.spyOn(host, "confirmUserToAccept");

        await expect(host.isAcceptablePeer("peer-a")).resolves.toBe(false);

        expect(confirmUserToAccept).not.toHaveBeenCalled();
    });
});

describe("room-owned peer diagnostics", () => {
    it("observes validated first advertisements and departure without exposing names or repeating advertisements", async () => {
        const server = new P2PHost({
            events: createLiveSyncEventHub(),
            simpleStore: {},
            settings: { P2P_Enabled: true },
        } as any);
        vi.spyOn(server, "dispatchConnectionStatus").mockResolvedValue(undefined);
        const report = vi.fn();
        server._env.reportDiagnostic = report;
        const advertisement = { peerId: "peer", name: "private device name", platform: "test" };
        server.onAdvertisement({ ...advertisement, peerId: "spoofed" }, "peer");
        expect(report).not.toHaveBeenCalled();
        server.onAdvertisement(advertisement, "peer");
        server.onAdvertisement(advertisement, "peer");
        expect(report).toHaveBeenCalledExactlyOnceWith({
            category: "peer",
            code: "peer-advertised",
            peerId: "peer",
            timestamp: expect.any(Number),
        });
        (server as any)._onPeerLeave("peer");
        expect(server.knownAdvertisements).toEqual([]);
        expect(report.mock.calls.at(-1)?.[0]).toEqual({
            category: "peer",
            code: "peer-left",
            peerId: "peer",
            timestamp: expect.any(Number),
        });
        expect(JSON.stringify(report.mock.calls)).not.toContain("private device name");
        server.dispose();
        const finalCount = report.mock.calls.length;
        server.onAdvertisement(advertisement, "peer");
        (server as any)._onPeerLeave("peer");
        expect(report).toHaveBeenCalledTimes(finalCount);
        await Promise.resolve();
    });
});
