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
import { ResponsePreventedError, type Payload, type Request, type Response } from "./types";

const createDecisionHost = (
    dialogueResult: "Accept" | "Ignore" | "Accept Temporarily" | "Ignore Temporarily" | false = false,
    settingsOverrides: Partial<P2PSyncSetting> = {}
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
        ...settingsOverrides,
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

const decidePeer = async (host: P2PHost, decision: boolean, peerId = "peer-a", name = "Device A") => {
    host.onAdvertisement({ peerId, name, platform: "test" }, peerId);
    await host.makeDecision({ peerId, name, decision, isTemporary: true });
};

const disposeTestHost = async (host: P2PHost) => {
    await host.close();
    host.dispose();
    vi.restoreAllMocks();
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

describe("P2PHost deprecated Payload RPC compatibility", () => {
    it("forwards an enabled legacy send to its configured sender for an accepted peer", async () => {
        const { host } = createDecisionHost();
        const payload: Response = { type: "legacy", direction: "response", seq: 3, data: "result" };
        const sender = vi.fn<NonNullable<P2PHost["___send"]>>(async () => undefined);
        host.___send = sender;

        try {
            await decidePeer(host, true);
            await host.__send(payload, "peer-a");

            expect(sender).toHaveBeenCalledExactlyOnceWith(payload, "peer-a");
        } finally {
            await disposeTestHost(host);
        }
    });

    it("skips legacy send and peer admission when P2P is disabled", async () => {
        const { host } = createDecisionHost(undefined, { P2P_Enabled: false });
        const sender = vi.fn<NonNullable<P2PHost["___send"]>>(async () => undefined);
        const checkAdmission = vi.spyOn(host, "isAcceptablePeer");
        host.___send = sender;
        const payload: Response = { type: "legacy", direction: "response", seq: 4, data: "result" };

        try {
            await host.__send(payload, "peer-a");

            expect(checkAdmission).not.toHaveBeenCalled();
            expect(sender).not.toHaveBeenCalled();
        } finally {
            await disposeTestHost(host);
        }
    });

    it("does not send a legacy payload to a peer whose decision is denied", async () => {
        const { host } = createDecisionHost();
        const sender = vi.fn<NonNullable<P2PHost["___send"]>>(async () => undefined);
        host.___send = sender;
        const payload: Response = { type: "legacy", direction: "response", seq: 5, data: "result" };

        try {
            await decidePeer(host, false);
            await host.__send(payload, "peer-a");

            expect(sender).not.toHaveBeenCalled();
        } finally {
            await disposeTestHost(host);
        }
    });

    it("completes without a transport sender when sending a legacy payload", async () => {
        const { host } = createDecisionHost();
        const payload: Response = { type: "legacy", direction: "response", seq: 6, data: "result" };

        try {
            await decidePeer(host, true);

            expect(host.___send).toBeUndefined();
            await expect(host.__send(payload, "peer-a")).resolves.toBeUndefined();
        } finally {
            await disposeTestHost(host);
        }
    });

    it("ignores an arrived legacy RPC when P2P is disabled", async () => {
        const { host } = createDecisionHost(undefined, { P2P_Enabled: false });
        const request: Request = { type: "legacy", direction: "request", seq: 7, args: [] };
        const checkAdmission = vi.spyOn(host, "isAcceptablePeer");
        const handleRequest = vi.spyOn(host, "__onRequest");

        try {
            await host.processArrivedRPC(request, "peer-a");

            expect(checkAdmission).not.toHaveBeenCalled();
            expect(handleRequest).not.toHaveBeenCalled();
        } finally {
            await disposeTestHost(host);
        }
    });

    it("rejects an arrived legacy payload with an invalid direction", async () => {
        const { host } = createDecisionHost();
        const invalidPayload = {
            type: "legacy",
            direction: "notification",
            seq: 8,
            args: [],
        } as unknown as Payload; // Deliberately malformed wire input for the protocol rejection branch.
        const handleRequest = vi.spyOn(host, "__onRequest");
        const handleResponse = vi.spyOn(host, "__onResponse");

        try {
            await decidePeer(host, true);
            await expect(host.processArrivedRPC(invalidPayload, "peer-a")).rejects.toThrow(
                "Invalid Message from peer-a"
            );

            expect(handleRequest).not.toHaveBeenCalled();
            expect(handleResponse).not.toHaveBeenCalled();
        } finally {
            await disposeTestHost(host);
        }
    });

    it("routes a legacy response to the cached client for its peer", async () => {
        const { host } = createDecisionHost();
        const response: Response = { type: "legacy", direction: "response", seq: 9, data: "result" };

        try {
            await decidePeer(host, true);
            await decidePeer(host, true, "peer-b", "Device B");
            const client = host.getConnection("peer-a");
            const otherClient = host.getConnection("peer-b");
            const handleClientResponse = vi.spyOn(client, "__onResponse");
            const handleOtherResponse = vi.spyOn(otherClient, "__onResponse");

            await host.processArrivedRPC(response, "peer-a");

            expect(handleClientResponse).toHaveBeenCalledExactlyOnceWith(response);
            expect(handleOtherResponse).not.toHaveBeenCalled();
        } finally {
            await disposeTestHost(host);
        }
    });

    it("sends a legacy error response when the requested function is missing", async () => {
        const { host } = createDecisionHost();
        const sender = vi.fn<NonNullable<P2PHost["___send"]>>(async () => undefined);
        host.___send = sender;
        const request: Request = { type: "missing", direction: "request", seq: 10, args: [] };

        try {
            await decidePeer(host, true);
            await host.__onRequest(request, "peer-a");

            expect(sender).toHaveBeenCalledExactlyOnceWith(
                {
                    type: "missing",
                    seq: 10,
                    direction: "response",
                    data: undefined,
                    error: {
                        code: "REMOTE_ERROR",
                        message: "Cannot serve function missing, no function provided or I am only a client",
                    },
                },
                "peer-a"
            );
        } finally {
            await disposeTestHost(host);
        }
    });

    it("does not send a legacy response when its handler prevents the response", async () => {
        const { host } = createDecisionHost();
        const sender = vi.fn<NonNullable<P2PHost["___send"]>>(async () => undefined);
        host.___send = sender;
        const preventResponse = vi.fn(() => {
            throw new ResponsePreventedError("request cancelled");
        });
        host.assignedFunctions.set("cancelled", preventResponse);
        const request: Request = { type: "cancelled", direction: "request", seq: 11, args: [] };

        try {
            await decidePeer(host, true);
            await host.__onRequest(request, "peer-a");

            expect(preventResponse).toHaveBeenCalledExactlyOnceWith();
            expect(sender).not.toHaveBeenCalled();
        } finally {
            await disposeTestHost(host);
        }
    });

    it("serialises a non-Error legacy handler throw before sending its response", async () => {
        const { host } = createDecisionHost();
        const sender = vi.fn<NonNullable<P2PHost["___send"]>>(async () => undefined);
        host.___send = sender;
        host.assignedFunctions.set("legacyThrow", () => {
            // eslint-disable-next-line no-throw-literal -- Legacy handlers may throw arbitrary values.
            throw "legacy failure";
        });
        const request: Request = { type: "legacyThrow", direction: "request", seq: 12, args: [] };

        try {
            await decidePeer(host, true);
            await host.__onRequest(request, "peer-a");

            expect(sender).toHaveBeenCalledExactlyOnceWith(
                {
                    type: "legacyThrow",
                    seq: 12,
                    direction: "response",
                    data: undefined,
                    error: { code: "REMOTE_ERROR", message: "Unknown remote error" },
                },
                "peer-a"
            );
            expect(JSON.parse(JSON.stringify(sender.mock.calls[0][0]))).toEqual({
                type: "legacyThrow",
                seq: 12,
                direction: "response",
                error: { code: "REMOTE_ERROR", message: "Unknown remote error" },
            });
        } finally {
            await disposeTestHost(host);
        }
    });

    it("sends a successful legacy request result through the configured sender", async () => {
        const { host } = createDecisionHost();
        const sender = vi.fn<NonNullable<P2PHost["___send"]>>(async () => undefined);
        host.___send = sender;
        host.assignedFunctions.set("legacyEcho", (value: string) => `echo:${value}`);
        const request: Request = { type: "legacyEcho", direction: "request", seq: 13, args: ["value"] };

        try {
            await decidePeer(host, true);
            await host.processArrivedRPC(request, "peer-a");

            expect(sender).toHaveBeenCalledExactlyOnceWith(
                {
                    type: "legacyEcho",
                    seq: 13,
                    direction: "response",
                    data: "echo:value",
                },
                "peer-a"
            );
        } finally {
            await disposeTestHost(host);
        }
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
        const { host } = createDecisionHost();
        host.assignedFunctions.set("fail", () => {
            throw new Error("legacy failure");
        });
        const sender = vi.fn<NonNullable<P2PHost["___send"]>>(async () => undefined);
        host.___send = sender;

        try {
            await decidePeer(host, true);
            await host.__onRequest({ type: "fail", direction: "request", seq: 1, args: [] }, "peer-a");

            expect(sender).toHaveBeenCalledExactlyOnceWith(
                {
                    type: "fail",
                    seq: 1,
                    direction: "response",
                    data: undefined,
                    error: { code: "REMOTE_ERROR", message: "legacy failure" },
                },
                "peer-a"
            );
            expect(JSON.parse(JSON.stringify(sender.mock.calls[0][0]))).toEqual({
                type: "fail",
                seq: 1,
                direction: "response",
                error: { code: "REMOTE_ERROR", message: "legacy failure" },
            });
        } finally {
            await disposeTestHost(host);
        }
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
