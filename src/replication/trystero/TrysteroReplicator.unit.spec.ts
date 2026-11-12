import { describe, expect, it, vi } from "vitest";
import { TrysteroReplicator, type TrysteroReplicatorOptions } from "./TrysteroReplicator";
import type { Confirm } from "@lib/interfaces/Confirm";
import { P2PLogCollector } from "./P2PLogCollector";
import { createLiveSyncEventHub } from "@lib/hub/hub";
import { defaultLogger, LOG_LEVEL_NOTICE, setGlobalLogFunction } from "@lib/common/logger";
import {
    EVENT_ADVERTISEMENT_RECEIVED,
    EVENT_P2P_REPLICATOR_STATUS,
    EVENT_P2P_REPLICATOR_PROGRESS,
    type P2PPeerAcceptance,
    type P2PHost,
} from "./TrysteroReplicatorP2PServer";
import type { Advertisement } from "./types";
import { RpcRoom, type JsonLike, type RpcWireMessage, type TransportAdapter } from "@lib/rpc";
import { toRpcMethodName } from "./rpcCompat";
import { fromP2PReplicationWireResult } from "./P2PReplicationWire";
import { TrysteroReplicatorP2PClient } from "./TrysteroReplicatorP2PClient";
import { VERSIONING_DOCID } from "@lib/common/models/db.const.ts";
import { NFC_PATH_IDENTITY_FEATURE } from "@lib/pouchdb/remoteFeatureCompatibility.ts";
import { decryptWithEphemeralSalt, encryptWithEphemeralSalt } from "octagonal-wheels/encryption/hkdf";

function createRpcRoomPair() {
    let receiveA: ((message: RpcWireMessage, peerId: string) => void) | undefined;
    let receiveB: ((message: RpcWireMessage, peerId: string) => void) | undefined;
    const transportA: TransportAdapter = {
        send: (message) => receiveB?.(message, "peer-a"),
        onMessage: (handler) => {
            receiveA = handler;
            return () => {
                if (receiveA === handler) receiveA = undefined;
            };
        },
    };
    const transportB: TransportAdapter = {
        send: (message) => receiveA?.(message, "peer-b"),
        onMessage: (handler) => {
            receiveB = handler;
            return () => {
                if (receiveB === handler) receiveB = undefined;
            };
        },
    };
    return {
        roomA: new RpcRoom({ transport: transportA }),
        roomB: new RpcRoom({ transport: transportB }),
    };
}

function createReplicator(settings: Record<string, unknown> = {}, options: TrysteroReplicatorOptions = {}) {
    const runFiniteReplicationActivity = vi.fn(async (task: () => unknown) => await task());
    const events = createLiveSyncEventHub();
    const sessionSettings = {
        P2P_Enabled: true,
        P2P_AutoSyncPeers: "",
        P2P_AutoWatchPeers: "",
        P2P_SyncOnReplication: "",
        ...settings,
    };
    const currentSettings = { ...sessionSettings };
    const askYesNoDialog = vi.fn<Confirm["askYesNoDialog"]>(async () => "no");
    const server = {
        _knownAdvertisements: new Map(),
        evaluatePeerAcceptance: vi.fn(async () => "accepted"),
        isServing: false,
    };
    const replicator = new TrysteroReplicator(
        {
            events,
            translate: (key: string) => key,
            settings: sessionSettings,
            currentSettings: () => currentSettings,
            db: {},
            simpleStore: {},
            deviceName: "device-a",
            platform: "test",
            confirm: { askYesNoDialog },
            processReplicatedDocs: vi.fn(),
            runFiniteReplicationActivity,
        } as any,
        server as any,
        undefined,
        options
    );
    return { currentSettings, events, replicator, runFiniteReplicationActivity, askYesNoDialog, server };
}

function installControlOnlyPathIdentityDatabase(replicator: TrysteroReplicator, initialVersion?: number) {
    let versionInfo: Record<string, unknown> | undefined =
        initialVersion === undefined
            ? undefined
            : { _id: VERSIONING_DOCID, type: "versioninfo", version: initialVersion };
    const missing = () => Object.assign(new Error("missing"), { status: 404, name: "not_found", reason: "missing" });
    const database = {
        info: vi.fn(async () => ({ db_name: "control-only-db", update_seq: 0, doc_count: versionInfo ? 2 : 1 })),
        get: vi.fn(async (id: string) => {
            if (id === VERSIONING_DOCID && versionInfo) return versionInfo;
            throw missing();
        }),
        allDocs: vi.fn(async () => ({
            rows: [{ id: "nodeinfo", doc: { _id: "nodeinfo", type: "nodeinfo" } }],
        })),
        put: vi.fn(async (doc: Record<string, unknown> & { _id: string }) => {
            if (doc._id === VERSIONING_DOCID) versionInfo = doc;
            return { ok: true, id: doc._id, rev: "1-new" };
        }),
        changes: vi.fn(async () => ({ results: [], last_seq: 0, pending: 0 })),
        revsDiff: vi.fn(async () => ({})),
        bulkGet: vi.fn(async ({ docs }: { docs: Array<{ id: string }> }) => ({
            results: docs.map(({ id }) => ({
                id,
                docs:
                    id === VERSIONING_DOCID && versionInfo
                        ? [{ ok: versionInfo }]
                        : [{ error: "not_found", reason: "missing", status: 404 }],
            })),
        })),
        bulkDocs: vi.fn(async () => []),
    };
    (replicator as any)._env.db = database;
    return database;
}

function createAdvertisementServer(advertisements: Advertisement[] = []) {
    const knownAdvertisements = new Map(advertisements.map((advertisement) => [advertisement.peerId, advertisement]));
    return {
        _knownAdvertisements: knownAdvertisements,
        get knownAdvertisements() {
            return [...knownAdvertisements.values()];
        },
        evaluatePeerAcceptance: vi.fn(async () => "accepted" as const),
    };
}

function captureGlobalLogs() {
    const entries: Array<{ message: unknown; level?: number; key?: string }> = [];
    setGlobalLogFunction((message, level, key) => entries.push({ message, level, key }));
    return {
        entries,
        restore: () => setGlobalLogFunction(defaultLogger),
    };
}

function hasNotice(entries: Array<{ level?: number }>): boolean {
    return entries.some((entry) => entry.level === LOG_LEVEL_NOTICE);
}

describe("TrysteroReplicator host commands", () => {
    it("uses injected relay controls and retains the public stop operation", () => {
        const order: string[] = [];
        const relayControl = {
            getSockets: vi.fn(() => ({
                relay: {
                    close: () => {
                        order.push("close");
                    },
                },
            })),
            pauseReconnection: vi.fn(() => {
                order.push("pause");
            }),
            resumeReconnection: vi.fn(() => {
                order.push("resume");
            }),
        };
        const { replicator } = createReplicator({}, { relayControl });
        const stop = vi.spyOn(replicator, "pauseServe").mockImplementation(async () => {
            order.push("stop");
        });
        try {
            replicator.disconnectFromServer();
            replicator.allowReconnection();
            expect(order).toEqual(["pause", "close", "stop", "resume"]);
            expect(relayControl.getSockets).toHaveBeenCalledOnce();
            expect(stop).toHaveBeenCalledOnce();
        } finally {
            stop.mockRestore();
        }
    });

    it.each([true, false])("opens only when the host is not serving: %s", async (isServing) => {
        const { replicator, server } = createReplicator();
        server.isServing = isServing;
        const open = vi.spyOn(replicator, "open").mockResolvedValue(undefined);
        try {
            await replicator.makeSureOpened();
            expect(open).toHaveBeenCalledTimes(isServing ? 0 : 1);
        } finally {
            open.mockRestore();
        }
    });

    it("delegates opening without a bound host and propagates opening failures", async () => {
        const { replicator } = createReplicator();
        replicator.server = undefined;
        const failure = new Error("The room could not be opened");
        const open = vi.spyOn(replicator, "open").mockRejectedValue(failure);
        try {
            await expect(replicator.makeSureOpened()).rejects.toBe(failure);
            expect(open).toHaveBeenCalledOnce();
        } finally {
            open.mockRestore();
        }
    });

    it.each(["yes", "no"] as const)("requests broadcast only after approval: %s", async (answer) => {
        const { replicator, askYesNoDialog } = createReplicator();
        askYesNoDialog.mockResolvedValue(answer);
        const enable = vi.spyOn(replicator, "enableBroadcastChanges").mockImplementation(() => undefined);
        try {
            expect(await replicator.getCommands().requestBroadcasting("requesting-peer")).toBeUndefined();
            expect(askYesNoDialog).toHaveBeenCalledExactlyOnceWith(
                "The remote peer requested to broadcast the changes. Do you want to allow it?",
                { defaultOption: "No" }
            );
            expect(enable).toHaveBeenCalledTimes(answer === "yes" ? 1 : 0);
        } finally {
            enable.mockRestore();
        }
    });
});

describe("TrysteroReplicator configuration import", () => {
    async function importConfiguration(configuration: Record<string, unknown>) {
        const { replicator } = createReplicator();
        const encrypted = await encryptWithEphemeralSalt(JSON.stringify(configuration), "transfer-passphrase", true);
        replicator._env.confirm.askString = vi.fn(async () => "transfer-passphrase");
        replicator.server = {
            serverPeerId: "local-peer",
            getConnection: () => ({ invokeRemoteFunction: async () => encrypted }),
        } as unknown as P2PHost;
        return replicator.getRemoteConfig("remote-peer");
    }

    it("completes a legacy configuration without inheriting the receiving device's ID key", async () => {
        const imported = await importConfiguration({ encrypt: true, usePathObfuscation: true, passphrase: "e2ee" });
        expect(imported).not.toBe(false);
        const receivingSettings = { idDerivationVersion: 1, idDerivationKey: "ab".repeat(32) };
        expect({ ...receivingSettings, ...imported }).toMatchObject({ idDerivationVersion: 0, idDerivationKey: "" });
    });

    it("imports the saved ID key without deriving it again", async () => {
        const configuration = { idDerivationVersion: 1, idDerivationKey: "ab".repeat(32) };
        expect(await importConfiguration(configuration)).toMatchObject(configuration);
    });

    it.each([
        { idDerivationVersion: 1 },
        { idDerivationVersion: 1, idDerivationKey: "invalid" },
        { idDerivationVersion: 2, idDerivationKey: "ab".repeat(32) },
    ])("rejects an incomplete or unsupported imported ID configuration (%o)", async (configuration) => {
        expect(await importConfiguration(configuration)).toBe(false);
    });
});

describe("TrysteroReplicator tweak compatibility", () => {
    const legacyVersionInfo = { _id: VERSIONING_DOCID, type: "versioninfo", version: 13, used_features: [] };
    const versionInfoResponse = (documentResult: unknown) => ({
        results: [{ id: VERSIONING_DOCID, docs: [documentResult] }],
    });

    it.each([
        ["a current document", versionInfoResponse({ ok: legacyVersionInfo }), true],
        ["a flat missing error", versionInfoResponse({ error: "not_found", status: 404 }), true],
        ["a nested missing error", versionInfoResponse({ error: { status: 404 } }), true],
        ["a missing error without status", versionInfoResponse({ error: "not_found" }), true],
        ["a nested missing name", versionInfoResponse({ error: { name: "not_found" } }), true],
        ["a nested missing code", versionInfoResponse({ error: { error: "not_found" } }), true],
        [
            "a null-prototype result",
            versionInfoResponse(Object.assign(Object.create(null), { ok: legacyVersionInfo })),
            true,
        ],
        ["an overridden hasOwnProperty", versionInfoResponse({ ok: legacyVersionInfo, hasOwnProperty: null }), true],
        ["an inherited document", versionInfoResponse(Object.create({ ok: legacyVersionInfo })), false],
        ["an inherited missing error", versionInfoResponse(Object.create({ error: "not_found", status: 404 })), false],
        ["an unreadable document", versionInfoResponse({ error: "not_found", status: 403 }), false],
        [
            "an invalid success with a missing error",
            versionInfoResponse({ ok: null, error: "not_found", status: 404 }),
            false,
        ],
        ["a different document", versionInfoResponse({ ok: { ...legacyVersionInfo, _id: "another-id" } }), false],
        ["a null document result", versionInfoResponse(null), false],
        ["an empty result list", { results: [] }, false],
        ["an empty document list", { results: [{ id: VERSIONING_DOCID, docs: [] }] }, false],
        ["a wrong result ID", { results: [{ id: "another-id", docs: [{ ok: legacyVersionInfo }] }] }, false],
    ] as const)("handles %s before starting metadata transfer", async (_case, response, canReplicate) => {
        const { replicator } = createReplicator({ pathNormalizationVersion: 0 });
        const localDB = installControlOnlyPathIdentityDatabase(replicator, 13);
        await localDB.put(legacyVersionInfo);
        const { replicator: remote } = createReplicator();
        const remoteDB = installControlOnlyPathIdentityDatabase(remote, 13);
        remoteDB.bulkGet.mockResolvedValue(response as any);
        vi.spyOn(replicator, "requestAuthenticate").mockResolvedValue(true);
        vi.spyOn(replicator, "checkTweakValues").mockResolvedValue(true);
        (replicator as any).server = {
            knownAdvertisements: [],
            serverPeerId: "local-peer",
            getConnection: vi.fn(() => ({
                invokeRemoteFunction: vi.fn(async () => undefined),
                getRemoteDB: vi.fn(() => remoteDB),
            })),
        };

        const result = await replicator.replicateFrom("peer-id");

        expect(result.status).toBe(canReplicate ? "completed" : "failed");
        expect(remoteDB.bulkGet).toHaveBeenCalledWith({ docs: [{ id: VERSIONING_DOCID }] });
        if (canReplicate) {
            expect(remoteDB.changes).toHaveBeenCalledOnce();
        } else {
            expect(result).toMatchObject({
                error: expect.objectContaining({ message: expect.stringContaining("P2P remote versioninfo") }),
            });
            expect(remoteDB.changes).not.toHaveBeenCalled();
            expect(remoteDB.info).not.toHaveBeenCalled();
        }
    });

    it("reports an absent path identity setting as legacy mode", async () => {
        const { replicator } = createReplicator({ encrypt: false, usePathObfuscation: false });

        await expect(replicator.getTweakSettings("challenge")).resolves.toMatchObject({
            pathNormalizationVersion: 0,
        });
    });

    it.each([
        [0, 1],
        [1, 0],
        [1, undefined],
    ] as const)(
        "hard rejects path identity mismatch %s vs %s with encryption disabled",
        async (localVersion, peerVersion) => {
            const { replicator } = createReplicator({
                encrypt: false,
                usePathObfuscation: false,
                pathNormalizationVersion: localVersion,
                passphrase: "same",
            });
            const { replicator: remote } = createReplicator({
                encrypt: false,
                usePathObfuscation: false,
                ...(peerVersion === undefined ? {} : { pathNormalizationVersion: peerVersion }),
                passphrase: "same",
            });
            if (localVersion === 1) installControlOnlyPathIdentityDatabase(replicator);
            if (peerVersion === 1) installControlOnlyPathIdentityDatabase(remote);
            (replicator as any).server = {
                knownAdvertisements: [{ peerId: "peer-id", platform: "test" }],
                serverPeerId: "local-peer",
                getConnection: vi.fn(() => ({
                    invokeRemoteObjectFunction: vi.fn(async (_name: string, args: string[]) =>
                        remote.getTweakSettings(args[0])
                    ),
                })),
            };

            await expect(replicator.checkTweakValues("peer-id")).resolves.toBe(false);
        }
    );

    it("checks path identity before the pseudo-replicator compatibility bypass", async () => {
        const { replicator } = createReplicator({
            encrypt: false,
            usePathObfuscation: false,
            pathNormalizationVersion: 0,
            passphrase: "same",
        });
        const { replicator: remote } = createReplicator({
            encrypt: false,
            usePathObfuscation: false,
            pathNormalizationVersion: 1,
            passphrase: "same",
        });
        installControlOnlyPathIdentityDatabase(remote);
        (replicator as any)._env.platform = "pseudo-replicator";
        (replicator as any).server = {
            knownAdvertisements: [{ peerId: "peer-id", platform: "test" }],
            serverPeerId: "local-peer",
            getConnection: vi.fn(() => ({
                invokeRemoteObjectFunction: vi.fn(async (_name: string, args: string[]) =>
                    remote.getTweakSettings(args[0])
                ),
            })),
        };

        await expect(replicator.checkTweakValues("peer-id")).resolves.toBe(false);
    });

    it.each([
        ["local", 2, 0],
        ["peer", 0, 2],
    ] as const)("rejects an unsupported %s path identity version", async (_side, localVersion, peerVersion) => {
        const { replicator } = createReplicator({
            encrypt: false,
            usePathObfuscation: false,
            pathNormalizationVersion: localVersion,
            passphrase: "same",
        });
        const { replicator: remote } = createReplicator({
            encrypt: false,
            usePathObfuscation: false,
            pathNormalizationVersion: peerVersion,
            passphrase: "same",
        });
        (replicator as any).server = {
            knownAdvertisements: [{ peerId: "peer-id", platform: "test" }],
            serverPeerId: "local-peer",
            getConnection: vi.fn(() => ({
                invokeRemoteObjectFunction: vi.fn(async (_name: string, args: string[]) =>
                    remote.getTweakSettings(args[0])
                ),
            })),
        };

        await expect(replicator.checkTweakValues("peer-id")).rejects.toThrow(
            "Unsupported path normalisation version: 2"
        );
    });

    it("rejects a peer using a different independent ID key without sending the key", async () => {
        const key = "ab".repeat(32);
        const { replicator } = createReplicator({
            encrypt: true,
            usePathObfuscation: true,
            passphrase: "same",
            idDerivationVersion: 1,
            idDerivationKey: key,
        });
        const { replicator: remote } = createReplicator({
            encrypt: true,
            usePathObfuscation: true,
            passphrase: "same",
            idDerivationVersion: 1,
            idDerivationKey: "cd".repeat(32),
        });
        const localTweak = await replicator.getTweakSettings("challenge");
        expect(JSON.stringify(localTweak)).not.toContain(key);
        (replicator as any).server = {
            knownAdvertisements: [{ peerId: "peer-id", platform: "test" }],
            serverPeerId: "local-peer",
            getConnection: vi.fn(() => ({
                invokeRemoteObjectFunction: vi.fn(async (_name: string, args: string[]) =>
                    remote.getTweakSettings(args[0])
                ),
            })),
        };
        await expect(replicator.checkTweakValues("peer-id")).resolves.toBe(false);
    });

    it("allows different ID keys when both peers use only keyed Chunk IDs", async () => {
        const { replicator } = createReplicator({
            encrypt: true,
            usePathObfuscation: false,
            passphrase: "same",
            idDerivationVersion: 1,
            idDerivationKey: "ab".repeat(32),
        });
        const { replicator: remote } = createReplicator({
            encrypt: true,
            usePathObfuscation: false,
            passphrase: "same",
            idDerivationVersion: 1,
            idDerivationKey: "cd".repeat(32),
        });
        (replicator as any).server = {
            knownAdvertisements: [{ peerId: "peer-id", platform: "test" }],
            serverPeerId: "local-peer",
            getConnection: vi.fn(() => ({
                invokeRemoteObjectFunction: vi.fn(async (_name: string, args: string[]) =>
                    remote.getTweakSettings(args[0])
                ),
            })),
        };
        await expect(replicator.checkTweakValues("peer-id")).resolves.toBe(true);
    });

    it.each([
        [false, "matched"],
        [true, "mismatched"],
    ] as const)(
        "warns and continues for an explicit filename-case value when the peer omits it (%s, %s)",
        async (handleFilenameCaseSensitive) => {
            const { replicator } = createReplicator();
            vi.spyOn(replicator, "getTweakSettings").mockResolvedValue({
                passphrase: "same",
                handleFilenameCaseSensitive,
            } as never);
            (replicator as any).server = {
                knownAdvertisements: [{ peerId: "peer-id", platform: "test" }],
                serverPeerId: "local-peer",
                getConnection: vi.fn(() => ({
                    invokeRemoteObjectFunction: vi.fn(async () => ({ passphrase: "same" })),
                })),
            };
            const logs = captureGlobalLogs();
            try {
                await expect(replicator.checkTweakValues("peer-id")).resolves.toBe(true);
                expect(hasNotice(logs.entries)).toBe(true);
            } finally {
                logs.restore();
            }
        }
    );

    it("continues to reject a passphrase hash mismatch", async () => {
        const { replicator } = createReplicator();
        vi.spyOn(replicator, "getTweakSettings").mockResolvedValue({ passphrase: "local" } as never);
        (replicator as any).server = {
            knownAdvertisements: [{ peerId: "peer-id", platform: "test" }],
            serverPeerId: "local-peer",
            getConnection: vi.fn(() => ({
                invokeRemoteObjectFunction: vi.fn(async () => ({ passphrase: "remote" })),
            })),
        };

        await expect(replicator.checkTweakValues("peer-id")).resolves.toBe(false);
    });
});

describe("TrysteroReplicator path identity database compatibility", () => {
    it.each([
        ["local", 0, true, false],
        ["peer", 0, false, true],
    ] as const)(
        "rejects an incompatible %s versioninfo identity before metadata transfer in mode %s",
        async (_side, pathVersion, localUsesNfc, peerUsesNfc) => {
            const versionInfo = (usesNfc: boolean) => ({
                _id: VERSIONING_DOCID,
                type: "versioninfo",
                version: 13,
                used_features: usesNfc ? [NFC_PATH_IDENTITY_FEATURE] : [],
            });
            const createDatabase = (name: string, identity: ReturnType<typeof versionInfo>) => {
                const missing = () => new Error("missing");
                const db = {
                    info: vi.fn(async () => ({ db_name: name, update_seq: 0, doc_count: 1 })),
                    get: vi.fn(async (id: string) => {
                        if (id === VERSIONING_DOCID) return identity;
                        throw missing();
                    }),
                    allDocs: vi.fn(async () => ({ rows: [{ id: "metadata", doc: { type: "plain" } }] })),
                    put: vi.fn(async (doc: { _id: string }) => ({ ok: true, id: doc._id, rev: "1-new" })),
                    changes: vi.fn(async () => ({ results: [], last_seq: 0, pending: 0 })),
                    revsDiff: vi.fn(async () => ({})),
                    bulkGet: vi.fn(async ({ docs }: { docs: Array<{ id: string }> }) => ({
                        results: docs.map(({ id }) => ({
                            id,
                            docs: id === VERSIONING_DOCID ? [{ ok: identity }] : [{ error: "not_found", status: 404 }],
                        })),
                    })),
                    bulkDocs: vi.fn(async () => []),
                };
                return db;
            };
            const localDB = createDatabase("local-db", versionInfo(localUsesNfc));
            const remoteDB = createDatabase("peer-db", versionInfo(peerUsesNfc));
            const { replicator } = createReplicator({
                encrypt: false,
                usePathObfuscation: false,
                pathNormalizationVersion: pathVersion,
                passphrase: "same",
            });
            const { replicator: remote } = createReplicator({
                encrypt: false,
                usePathObfuscation: false,
                pathNormalizationVersion: pathVersion,
                passphrase: "same",
            });
            (replicator as any)._env.db = localDB;
            vi.spyOn(replicator, "requestAuthenticate").mockResolvedValue(true);
            (replicator as any).server = {
                knownAdvertisements: [{ peerId: "peer-id", platform: "test" }],
                serverPeerId: "local-peer",
                getConnection: vi.fn(() => ({
                    invokeRemoteFunction: vi.fn(async () => undefined),
                    invokeRemoteObjectFunction: vi.fn(async (_name: string, args: string[]) =>
                        remote.getTweakSettings(args[0])
                    ),
                    getRemoteDB: vi.fn(() => remoteDB),
                })),
            };

            const result = await replicator.replicateFrom("peer-id");

            expect(result.status).toBe("failed");
            expect(localDB.get).toHaveBeenCalledWith(VERSIONING_DOCID);
            expect(remoteDB.bulkGet).toHaveBeenCalledWith({ docs: [{ id: VERSIONING_DOCID }] });
            expect(remoteDB.get).not.toHaveBeenCalledWith(VERSIONING_DOCID);
            expect(remoteDB.changes).not.toHaveBeenCalled();
        }
    );

    it.each(["local", "peer"] as const)(
        "rejects populated NFC-mode %s databases whose versioninfo does not declare NFC before metadata transfer",
        async (mismatchSide) => {
            const versionInfo = (usesNfc: boolean) => ({
                _id: VERSIONING_DOCID,
                type: "versioninfo",
                version: 13,
                used_features: usesNfc ? [NFC_PATH_IDENTITY_FEATURE] : [],
            });
            const createDatabase = (name: string, usesNfc: boolean, hasVersionInfo: boolean) => ({
                info: vi.fn(async () => ({ db_name: name, update_seq: 0, doc_count: 2 })),
                get: vi.fn(async (id: string) => {
                    if (id === VERSIONING_DOCID && hasVersionInfo) return versionInfo(usesNfc);
                    throw Object.assign(new Error("missing"), { status: 404, name: "not_found", reason: "missing" });
                }),
                allDocs: vi.fn(async () => ({ rows: [{ id: "metadata", doc: { type: "plain" } }] })),
                put: vi.fn(async (doc: { _id: string }) => ({ ok: true, id: doc._id, rev: "1-new" })),
                changes: vi.fn(async () => ({ results: [], last_seq: 0, pending: 0 })),
                revsDiff: vi.fn(async () => ({})),
                bulkGet: vi.fn(async ({ docs }: { docs: Array<{ id: string }> }) => ({
                    results: docs.map(({ id }) => ({
                        id,
                        docs:
                            id === VERSIONING_DOCID && hasVersionInfo
                                ? [{ ok: versionInfo(usesNfc) }]
                                : [{ error: "not_found", reason: "missing", status: 404 }],
                    })),
                })),
                bulkDocs: vi.fn(async () => []),
            });
            const localDB = createDatabase("local-db", true, mismatchSide !== "local");
            const remoteDB = createDatabase("peer-db", true, mismatchSide !== "peer");
            const { replicator } = createReplicator({
                encrypt: false,
                usePathObfuscation: false,
                pathNormalizationVersion: 1,
                passphrase: "same",
            });
            const { replicator: remote } = createReplicator({
                encrypt: false,
                usePathObfuscation: false,
                pathNormalizationVersion: 1,
                passphrase: "same",
            });
            (replicator as any)._env.db = localDB;
            (remote as any)._env.db = remoteDB;
            vi.spyOn(replicator, "requestAuthenticate").mockResolvedValue(true);
            (replicator as any).server = {
                knownAdvertisements: [{ peerId: "peer-id", platform: "test" }],
                serverPeerId: "local-peer",
                getConnection: vi.fn(() => ({
                    invokeRemoteFunction: vi.fn(async () => undefined),
                    invokeRemoteObjectFunction: vi.fn(async (_name: string, args: string[]) =>
                        remote.getTweakSettings(args[0])
                    ),
                    getRemoteDB: vi.fn(() => remoteDB),
                })),
            };

            await expect(replicator.replicateFrom("peer-id")).rejects.toThrow(
                "The database and settings use different path identity versions."
            );
            const mismatchedDatabase = mismatchSide === "local" ? localDB : remoteDB;
            expect(mismatchedDatabase.get).toHaveBeenCalledWith(VERSIONING_DOCID);
            expect(mismatchedDatabase.allDocs).toHaveBeenCalledOnce();
            expect(remoteDB.changes).not.toHaveBeenCalled();
        }
    );

    it.each([
        ["missing local", "missing", "current"],
        ["missing peer", "current", "missing"],
        ["older local", "older", "current"],
        ["older peer", "current", "older"],
    ] as const)(
        "preserves legacy path identity for a %s versioninfo document in mode 0",
        async (_case, localState, peerState) => {
            const missing = () =>
                Object.assign(new Error("missing"), { status: 404, name: "not_found", reason: "missing" });
            const versionInfo = {
                _id: VERSIONING_DOCID,
                type: "versioninfo",
                version: 13,
                used_features: [],
            };
            const olderVersionInfo = {
                _id: VERSIONING_DOCID,
                type: "versioninfo",
                version: 11,
            };
            const createDatabase = (name: string, state: "missing" | "current" | "older") => ({
                info: vi.fn(async () => ({ db_name: name, update_seq: 0, doc_count: 1 })),
                get: vi.fn(async (id: string) => {
                    if (id !== VERSIONING_DOCID) throw missing();
                    if (state === "missing") throw missing();
                    return state === "older" ? olderVersionInfo : versionInfo;
                }),
                put: vi.fn(async (doc: { _id: string }) => ({ ok: true, id: doc._id, rev: "1-new" })),
                changes: vi.fn(async () => ({ results: [], last_seq: 0, pending: 0 })),
                revsDiff: vi.fn(async () => ({})),
                bulkGet: vi.fn(async ({ docs }: { docs: Array<{ id: string }> }) => ({
                    results: docs.map(({ id }) => ({
                        id,
                        docs:
                            id === VERSIONING_DOCID && state !== "missing"
                                ? [{ ok: state === "older" ? olderVersionInfo : versionInfo }]
                                : [{ error: "not_found", reason: "missing", status: 404 }],
                    })),
                })),
                bulkDocs: vi.fn(async () => []),
            });
            const localDB = createDatabase("local-db", localState);
            const remoteDB = createDatabase("peer-db", peerState);
            const { replicator } = createReplicator({
                encrypt: false,
                usePathObfuscation: false,
                pathNormalizationVersion: 0,
                passphrase: "same",
            });
            const { replicator: remote } = createReplicator({
                encrypt: false,
                usePathObfuscation: false,
                pathNormalizationVersion: 0,
                passphrase: "same",
            });
            (replicator as any)._env.db = localDB;
            vi.spyOn(replicator, "requestAuthenticate").mockResolvedValue(true);
            (replicator as any).server = {
                knownAdvertisements: [{ peerId: "peer-id", platform: "test" }],
                serverPeerId: "local-peer",
                getConnection: vi.fn(() => ({
                    invokeRemoteFunction: vi.fn(async () => undefined),
                    invokeRemoteObjectFunction: vi.fn(async (_name: string, args: string[]) =>
                        remote.getTweakSettings(args[0])
                    ),
                    getRemoteDB: vi.fn(() => remoteDB),
                })),
            };

            const result = await replicator.replicateFrom("peer-id");

            expect(result.status).toBe("completed");
            expect(localDB.get).toHaveBeenCalledWith(VERSIONING_DOCID);
            expect(remoteDB.bulkGet).toHaveBeenCalledWith({ docs: [{ id: VERSIONING_DOCID }] });
            expect(remoteDB.get).not.toHaveBeenCalledWith(VERSIONING_DOCID);
            expect(remoteDB.changes).toHaveBeenCalledOnce();
        }
    );

    it("accepts a missing peer versioninfo as legacy mode across the P2P RPC boundary", async () => {
        const { roomA, roomB } = createRpcRoomPair();
        try {
            const localDocuments = new Map<string, Record<string, unknown>>([
                [VERSIONING_DOCID, { _id: VERSIONING_DOCID, type: "versioninfo", version: 13, used_features: [] }],
            ]);
            const localDB = {
                info: vi.fn(async () => ({ db_name: "local-db", update_seq: 0, doc_count: localDocuments.size })),
                get: vi.fn(async (id: string) => {
                    const document = localDocuments.get(id);
                    if (document) return document;
                    throw Object.assign(new Error("missing"), {
                        status: 404,
                        name: "not_found",
                        reason: "missing",
                    });
                }),
                put: vi.fn(async (document: Record<string, unknown> & { _id: string }) => {
                    localDocuments.set(document._id, document);
                    return { ok: true, id: document._id, rev: "1-new" };
                }),
                changes: vi.fn(async () => ({ results: [], last_seq: 0, pending: 0 })),
                revsDiff: vi.fn(async () => ({})),
                bulkGet: vi.fn(async () => ({ results: [] })),
                bulkDocs: vi.fn(async () => []),
            };

            const remoteDocuments = new Map<string, Record<string, unknown>>();
            const remoteBulkGet = vi.fn(async (options: { docs: Array<{ id: string }> }) => ({
                results: options.docs.map(({ id }) => ({
                    id,
                    docs: [
                        {
                            error: "not_found",
                            reason: "missing",
                            status: 404,
                        },
                    ],
                })),
            }));
            roomB.register("db.info", () => ({ db_name: "peer-db", update_seq: 0, doc_count: remoteDocuments.size }));
            roomB.register("db.get", (_peerId, id) => {
                const document = remoteDocuments.get(String(id));
                if (document) return document;
                throw new Error("missing");
            });
            roomB.register("db.bulkGet", (_peerId, options) =>
                remoteBulkGet(options as { docs: Array<{ id: string }> })
            );
            roomB.register("db.put", (_peerId, document) => {
                const doc = document as Record<string, unknown> & { _id: string };
                remoteDocuments.set(doc._id, doc);
                return { ok: true, id: doc._id, rev: "1-new" };
            });
            roomB.register("db.changes", () => ({ results: [], last_seq: 0, pending: 0 }));
            roomB.register("db.revsDiff", () => ({}));
            roomB.register("db.bulkDocs", () => []);

            const remoteClient = new TrysteroReplicatorP2PClient({ rpcRoom: roomA } as any, "peer-b");
            const remoteDB = remoteClient.getRemoteDB();
            const { replicator } = createReplicator({
                encrypt: false,
                usePathObfuscation: false,
                pathNormalizationVersion: 0,
                passphrase: "same",
            });
            (replicator as any)._env.db = localDB;
            vi.spyOn(replicator, "requestAuthenticate").mockResolvedValue(true);
            vi.spyOn(replicator, "checkTweakValues").mockResolvedValue(true);
            (replicator as any).server = {
                knownAdvertisements: [{ peerId: "peer-id", platform: "test" }],
                serverPeerId: "local-peer",
                getConnection: vi.fn(() => ({
                    invokeRemoteFunction: vi.fn(async () => undefined),
                    getRemoteDB: vi.fn(() => remoteDB),
                })),
            };

            const result = await replicator.replicateFrom("peer-id");

            expect(result.status).toBe("completed");
            expect(remoteBulkGet).toHaveBeenCalledWith({ docs: [{ id: VERSIONING_DOCID }] });
            expect(remoteDocuments.has(VERSIONING_DOCID)).toBe(false);
        } finally {
            roomA.close();
            roomB.close();
        }
    });

    it.each([
        ["missing versioninfo", undefined],
        ["generation-12 versioninfo", 12],
    ] as const)("declares NFC identity for fresh control-only databases with %s", async (_baseline, version) => {
        const { replicator } = createReplicator({
            encrypt: false,
            usePathObfuscation: false,
            pathNormalizationVersion: 1,
            passphrase: "same",
        });
        const { replicator: remote } = createReplicator({
            encrypt: false,
            usePathObfuscation: false,
            pathNormalizationVersion: 1,
            passphrase: "same",
        });
        const localDB = installControlOnlyPathIdentityDatabase(replicator, version);
        const remoteDB = installControlOnlyPathIdentityDatabase(remote, version);
        vi.spyOn(replicator, "requestAuthenticate").mockResolvedValue(true);
        (replicator as any).server = {
            knownAdvertisements: [{ peerId: "peer-id", platform: "test" }],
            serverPeerId: "local-peer",
            getConnection: vi.fn(() => ({
                invokeRemoteFunction: vi.fn(async () => undefined),
                invokeRemoteObjectFunction: vi.fn(async (_name: string, args: string[]) =>
                    remote.getTweakSettings(args[0])
                ),
                getRemoteDB: vi.fn(() => remoteDB),
            })),
        };

        const result = await replicator.replicateFrom("peer-id");

        expect(result.status).toBe("completed");
        expect(localDB.put).toHaveBeenCalledWith(
            expect.objectContaining({
                _id: VERSIONING_DOCID,
                version: 13,
                used_features: [NFC_PATH_IDENTITY_FEATURE],
            })
        );
        expect(remoteDB.put).toHaveBeenCalledWith(
            expect.objectContaining({
                _id: VERSIONING_DOCID,
                version: 13,
                used_features: [NFC_PATH_IDENTITY_FEATURE],
            })
        );
        expect(localDB.allDocs).toHaveBeenCalledOnce();
        expect(remoteDB.allDocs).toHaveBeenCalledOnce();
        expect(remoteDB.changes).toHaveBeenCalledOnce();
    });
});

describe("TrysteroReplicator replication failure boundaries", () => {
    it.each([
        ["authentication", false],
        ["authentication", true],
        ["tweak check", false],
        ["tweak check", true],
    ] as const)("preserves a rejected %s with cancellation=%s", async (stage, abort) => {
        const { replicator } = createReplicator();
        const controller = new AbortController();
        const failure = new Error(`${stage} failed`);
        const reject = async () => {
            if (abort) controller.abort();
            throw failure;
        };
        const authenticate = vi.spyOn(replicator, "requestAuthenticate").mockResolvedValue(true);
        const checkTweaks = vi.spyOn(replicator, "checkTweakValues").mockResolvedValue(true);
        const getConnection = vi.fn();
        replicator.server!.getConnection = getConnection;
        const dispatchStatus = vi.spyOn(replicator, "dispatchStatus");
        if (stage === "authentication") authenticate.mockImplementation(reject);
        else checkTweaks.mockImplementation(reject);

        const result = replicator.replicateFrom("peer-id", false, false, false, controller.signal);

        if (stage === "tweak check" && abort) {
            await expect(result).resolves.toEqual({ status: "cancelled" });
        } else {
            await expect(result).rejects.toBe(failure);
        }
        if (stage === "authentication") expect(checkTweaks).not.toHaveBeenCalled();
        expect(getConnection).not.toHaveBeenCalled();
        expect(dispatchStatus).not.toHaveBeenCalled();
        expect(replicator._replicateFromPeers.size).toBe(0);
    });

    it.each(["authentication", "tweak check"] as const)(
        "preserves cancellation when %s returns false",
        async (stage) => {
            const { replicator } = createReplicator();
            const controller = new AbortController();
            const reject = async () => {
                controller.abort();
                return false;
            };
            const authenticate = vi.spyOn(replicator, "requestAuthenticate").mockResolvedValue(true);
            const checkTweaks = vi.spyOn(replicator, "checkTweakValues").mockResolvedValue(true);
            if (stage === "authentication") authenticate.mockImplementation(reject);
            else checkTweaks.mockImplementation(reject);

            await expect(replicator.replicateFrom("peer-id", false, false, false, controller.signal)).resolves.toEqual({
                status: "cancelled",
            });
            if (stage === "authentication") expect(checkTweaks).not.toHaveBeenCalled();
            expect(replicator._replicateFromPeers.size).toBe(0);
        }
    );

    it.each([false, true])("releases peer ownership after a transfer failure with cancellation=%s", async (abort) => {
        const { replicator } = createReplicator();
        const controller = new AbortController();
        const failure = new Error("Remote database is unavailable");
        const order: string[] = [];
        vi.spyOn(replicator, "requestAuthenticate").mockImplementation(async () => {
            order.push("authentication");
            return true;
        });
        vi.spyOn(replicator, "checkTweakValues").mockImplementation(async () => {
            order.push("tweaks");
            return true;
        });
        vi.spyOn(replicator, "dispatchStatus").mockImplementation(() => {
            order.push(replicator._replicateFromPeers.has("peer-id") ? "active" : "released");
        });
        replicator.server!.getConnection = vi.fn(() => ({
            getRemoteDB: (signal: AbortSignal) => {
                expect(signal).toBe(controller.signal);
                order.push("database");
                if (abort) controller.abort();
                throw failure;
            },
        })) as never;

        const result = await replicator.replicateFrom("peer-id", false, false, false, controller.signal);

        expect(result).toEqual(abort ? { status: "cancelled" } : { status: "failed", error: failure });
        expect(order).toEqual(["authentication", "tweaks", "active", "database", "released"]);
        expect(replicator._replicateFromPeers.size).toBe(0);
    });
});

describe("TrysteroReplicator automatic remote activity", () => {
    it.each([
        [false, false],
        [true, true],
    ] as const)("uses the call authority for a no-target command (%s)", async (showResult, expectNotice) => {
        const { replicator } = createReplicator();
        const logs = captureGlobalLogs();
        try {
            await expect(replicator.replicateFromCommand(showResult, 0)).resolves.toEqual({
                status: "blocked",
                reason: "no-targets",
                targets: [],
            });

            expect(hasNotice(logs.entries)).toBe(expectNotice);
        } finally {
            logs.restore();
        }
    });

    it.each([
        [false, false],
        [true, true],
    ] as const)("uses the call authority for an authentication settlement (%s)", async (showNotice, expectNotice) => {
        const { replicator } = createReplicator();
        vi.spyOn(replicator, "requestAuthenticate").mockResolvedValue(false);
        const logs = captureGlobalLogs();
        try {
            await expect(replicator.replicateFrom("peer-id", showNotice)).resolves.toMatchObject({
                status: "failed",
                error: expect.any(Error),
            });

            expect(hasNotice(logs.entries)).toBe(expectNotice);
        } finally {
            logs.restore();
        }
    });

    it.each([
        [false, false],
        [true, true],
    ] as const)("uses the call authority for a tweak settlement (%s)", async (showNotice, expectNotice) => {
        const { replicator } = createReplicator();
        vi.spyOn(replicator, "requestAuthenticate").mockResolvedValue(true);
        vi.spyOn(replicator, "checkTweakValues").mockResolvedValue(false);
        const logs = captureGlobalLogs();
        try {
            await expect(replicator.replicateFrom("peer-id", showNotice)).resolves.toMatchObject({
                status: "failed",
                error: expect.any(Error),
            });

            expect(hasNotice(logs.entries)).toBe(expectNotice);
        } finally {
            logs.restore();
        }
    });

    it.each([
        [false, false],
        [true, true],
    ] as const)("propagates call authority through a real tweak mismatch (%s)", async (showNotice, expectNotice) => {
        const { replicator } = createReplicator();
        vi.spyOn(replicator, "requestAuthenticate").mockResolvedValue(true);
        vi.spyOn(replicator, "getTweakSettings").mockResolvedValue({ passphrase: "local" } as never);
        (replicator as any).server = {
            knownAdvertisements: [{ peerId: "peer-id", platform: "test" }],
            serverPeerId: "local-peer",
            getConnection: vi.fn(() => ({
                invokeRemoteObjectFunction: vi.fn(async () => ({ passphrase: "remote" })),
            })),
        };
        const logs = captureGlobalLogs();
        try {
            await expect(replicator.replicateFrom("peer-id", showNotice)).resolves.toMatchObject({
                status: "failed",
                error: expect.any(Error),
            });

            expect(hasNotice(logs.entries)).toBe(expectNotice);
        } finally {
            logs.restore();
        }
    });

    it.each([
        [false, false],
        [true, true],
    ] as const)("uses the call authority for an overlap settlement (%s)", async (showNotice, expectNotice) => {
        const { replicator } = createReplicator();
        vi.spyOn(replicator, "requestAuthenticate").mockResolvedValue(true);
        vi.spyOn(replicator, "checkTweakValues").mockResolvedValue(true);
        replicator._replicateFromPeers.add("peer-id");
        const logs = captureGlobalLogs();
        try {
            await expect(replicator.replicateFrom("peer-id", showNotice)).resolves.toMatchObject({
                status: "failed",
                error: expect.any(Error),
            });

            expect(hasNotice(logs.entries)).toBe(expectNotice);
        } finally {
            logs.restore();
        }
    });

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

    it("preserves a failed synchronisation reason through the RpcRoom JSON boundary", async () => {
        const { roomA, roomB } = createRpcRoomPair();
        try {
            const { replicator: source } = createReplicator();
            source.setOnSetup();
            (source as any).server = {
                start: vi.fn(async (_bindings: unknown[], beforeAdvertisement?: () => void) => beforeAdvertisement?.()),
                serveCancellationAwareFunction: vi.fn(
                    (
                        type: string,
                        handler: (
                            context: { signal: AbortSignal },
                            peerId: string,
                            fromPeerId: string
                        ) => Promise<unknown>
                    ) => roomB.registerCancellable(toRpcMethodName(type), handler as any)
                ),
            };
            await source.open();

            const { replicator: requester } = createReplicator();
            (requester as any).server = {
                serverPeerId: "peer-a",
                getConnection: vi.fn(() => ({
                    invokeRemoteFunction: (type: string, args: JsonLike[], _timeout: number, signal?: AbortSignal) =>
                        roomA.session("peer-b").call(toRpcMethodName(type), args, { timeoutMs: 1_000, signal }),
                })),
            };

            const result = await requester.requestSynchroniseToPeer("peer-b");

            expect(result.status).toBe("failed");
            if (result.status !== "failed") throw new Error("Expected failed P2P replication");
            expect(result.error).toBeInstanceOf(Error);
            expect(result.error).toMatchObject({
                message: "The setup is in progress",
            });
        } finally {
            roomA.close();
            roomB.close();
        }
    });

    it("turns a legacy malformed wire failure into an explicit local Error", () => {
        const result = fromP2PReplicationWireResult({ status: "failed", error: {} as never });

        expect(result.status).toBe("failed");
        if (result.status !== "failed") throw new Error("Expected failed P2P replication");
        expect(result.error).toBeInstanceOf(Error);
        expect(result.error).toMatchObject({
            message: "The remote peer reported a replication failure without a usable reason.",
        });
    });

    it("decomposes auxiliary setup errors before they enter successful RPC data", async () => {
        const { replicator } = createReplicator();
        replicator.setOnSetup();
        const commands = replicator.getCommands();

        const results = await Promise.all([
            commands.onProgress("peer-id"),
            commands.getAllConfig("peer-id"),
            commands.requestBroadcasting("peer-id"),
        ]);

        for (const result of results) {
            expect(JSON.parse(JSON.stringify(result))).toEqual({
                error: {
                    code: "REMOTE_ERROR",
                    message: "The setup is in progress",
                },
            });
        }
    });

    it("excludes runtime ICE and duplicate managed projections from shared configuration", async () => {
        const profileURI = "sls+p2p://room?managedType=CF&managedId=key-id&token=profile-token";
        const { replicator } = createReplicator({
            P2P_managedType: "CF",
            P2P_managedId: "key-id",
            P2P_managedToken: "top-level-token",
            P2P_iceServers: [{ urls: "turn:turn.example.com", credential: "issued-secret" }],
            P2P_iceServersExpiresAt: 123_456,
            remoteConfigurations: {
                p2p: { id: "p2p", name: "Managed P2P", uri: profileURI, isEncrypted: false },
            },
        });
        (replicator as any)._env.confirm.askString = vi.fn(async () => "share-pass");

        const encrypted = await replicator.getCommands().getAllConfig("peer-id");
        const shared = JSON.parse(await decryptWithEphemeralSalt(encrypted as string, "share-pass"));

        expect(shared).not.toHaveProperty("P2P_managedType");
        expect(shared).not.toHaveProperty("P2P_managedId");
        expect(shared).not.toHaveProperty("P2P_managedToken");
        expect(shared).not.toHaveProperty("P2P_iceServers");
        expect(shared).not.toHaveProperty("P2P_iceServersExpiresAt");
        expect(shared.remoteConfigurations.p2p.uri).toBe(profileURI);
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

    it.each(["autoSyncPeers", "autoWatchPeers"] as const)("preserves peer-pattern matching for %s", (property) => {
        const patterns = " Device A , , ~tablet, phone. ";
        const { replicator } = createReplicator({ P2P_AutoSyncPeers: patterns, P2P_AutoWatchPeers: patterns });
        const matches = (name: string) => replicator[property].some((pattern) => pattern.test(name));
        expect(["device a", "old TABLET backup", "phone1"].map(matches)).toEqual([true, true, true]);
        expect(["prefix Device A", "DeviceA", "phone12", ""].map(matches)).toEqual([false, false, false, false]);
    });

    it.each(["autoSyncPeers", "autoWatchPeers"] as const)("propagates invalid patterns from %s", (property) => {
        const { replicator } = createReplicator({ P2P_AutoSyncPeers: "[", P2P_AutoWatchPeers: "[" });
        expect(() => replicator[property]).toThrow(SyntaxError);
    });

    it("tracks automatic synchronisation when a configured peer is discovered", async () => {
        const { replicator, runFiniteReplicationActivity } = createReplicator({
            P2P_AutoSyncPeers: "peer-a",
        });
        const sync = vi.spyOn(replicator, "sync").mockResolvedValue({ status: "completed", ok: true });

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
        vi.spyOn(replicator, "getRemoteIsBroadcasting").mockResolvedValue(true);
        const watchPeer = vi.spyOn(replicator, "watchPeer");

        await replicator.onNewPeer({ peerId: "peer-id", name: "peer-a", platform: "test" });

        expect(watchPeer).toHaveBeenCalledWith("peer-id");
        expect(replicator._watchingPeers).toContain("peer-id");
    });

    it("reads current automatic synchronisation and watch policy for a newly advertised peer", async () => {
        const { currentSettings, replicator } = createReplicator();
        const sync = vi.spyOn(replicator, "sync").mockResolvedValue({ status: "completed", ok: true });
        vi.spyOn(replicator, "getRemoteIsBroadcasting").mockResolvedValue(true);
        const watchPeer = vi.spyOn(replicator, "watchPeer");
        currentSettings.P2P_AutoSyncPeers = "peer-a";
        currentSettings.P2P_AutoWatchPeers = "peer-a";

        await replicator.onNewPeer({ peerId: "peer-id", name: "peer-a", platform: "test" });

        expect(sync).toHaveBeenCalledWith("peer-id");
        expect(watchPeer).toHaveBeenCalledWith("peer-id");
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
        const sync = vi.spyOn(replicator, "sync").mockResolvedValue({ status: "completed", ok: true });

        await replicator.onNewPeer({ peerId: "peer-id", name: "peer-a", platform: "test" });

        expect(sync).toHaveBeenCalledWith("peer-id");
    });

    it("waits for a delayed configured-target advertisement before synchronising", async () => {
        vi.useFakeTimers();
        try {
            const { events, replicator } = createReplicator({
                P2P_SyncOnReplication: "peer-a",
            });
            const server = createAdvertisementServer();
            replicator.server = server as unknown as P2PHost;
            const peer: Advertisement = { peerId: "peer-id", name: "peer-a", platform: "test" };
            const sync = vi.spyOn(replicator, "sync").mockResolvedValue({ status: "completed", ok: true });

            const resultPromise = replicator.replicateFromCommand(true);
            await vi.advanceTimersByTimeAsync(100);
            expect(sync).not.toHaveBeenCalled();

            server._knownAdvertisements.set(peer.peerId, peer);
            events.emitEvent(EVENT_ADVERTISEMENT_RECEIVED, peer);

            await expect(resultPromise).resolves.toEqual({
                status: "completed",
                targets: [{ name: "peer-a", peerId: "peer-id", status: "completed" }],
            });
            expect(sync).toHaveBeenCalledWith(peer.peerId, true, undefined);
        } finally {
            vi.useRealTimers();
        }
    });

    it("reads the current configured-target policy when unattended synchronisation starts", async () => {
        const { currentSettings, replicator } = createReplicator();
        const peer: Advertisement = { peerId: "peer-id", name: "peer-a", platform: "test" };
        replicator.server = createAdvertisementServer([peer]) as unknown as P2PHost;
        const sync = vi.spyOn(replicator, "sync").mockResolvedValue({ status: "completed", ok: true });
        currentSettings.P2P_SyncOnReplication = "peer-a";

        await expect(replicator.replicateFromCommand(true, 0)).resolves.toEqual({
            status: "completed",
            targets: [{ name: "peer-a", peerId: "peer-id", status: "completed" }],
        });
        expect(sync).toHaveBeenCalledWith(peer.peerId, true, undefined);
    });

    it.each([
        ["denied", "rejected"],
        ["undecided", "undecided"],
    ] as const)(
        "returns an explicit failure for a configured %s target without opening admission UI",
        async (_label, decision: P2PPeerAcceptance) => {
            const { replicator } = createReplicator({
                P2P_SyncOnReplication: "peer-a",
            });
            const peer: Advertisement = { peerId: "peer-id", name: "peer-a", platform: "test" };
            const confirmUserToAccept = vi.fn(async () => true);
            const server = {
                ...createAdvertisementServer([peer]),
                evaluatePeerAcceptance: vi.fn(async () => decision),
                confirmUserToAccept,
            };
            replicator.server = server as unknown as P2PHost;
            const sync = vi.spyOn(replicator, "sync").mockResolvedValue({ status: "completed", ok: true });

            const result = await replicator.replicateFromCommand(true);
            expect(sync).not.toHaveBeenCalled();
            expect(confirmUserToAccept).not.toHaveBeenCalled();
            expect(result).toEqual({
                status: "partial",
                targets: [{ name: "peer-a", peerId: "peer-id", status: decision }],
            });
        }
    );

    it("deduplicates a configured target and AutoSync request into one baseline synchronisation", async () => {
        const { replicator } = createReplicator({
            P2P_AutoSyncPeers: "peer-a",
            P2P_SyncOnReplication: "peer-a",
        });
        const peer: Advertisement = { peerId: "peer-id", name: "peer-a", platform: "test" };
        const server = createAdvertisementServer([peer]);
        replicator.server = server as unknown as P2PHost;

        let releasePull!: () => void;
        const pullGate = new Promise<void>((resolve) => {
            releasePull = resolve;
        });
        let pullStarted!: () => void;
        const pullStartedPromise = new Promise<void>((resolve) => {
            pullStarted = resolve;
        });
        const replicateFrom = vi.spyOn(replicator, "replicateFrom").mockImplementation(async () => {
            pullStarted();
            await pullGate;
            return { status: "completed", ok: true };
        });
        const requestSynchroniseToPeer = vi
            .spyOn(replicator, "requestSynchroniseToPeer")
            .mockResolvedValue({ status: "completed", ok: true });

        const configured = replicator.replicateFromCommand(true);
        await pullStartedPromise;
        const automatic = replicator.onNewPeer(peer);
        await Promise.resolve();

        expect(replicateFrom).toHaveBeenCalledOnce();

        releasePull();
        await expect(configured).resolves.toEqual({
            status: "completed",
            targets: [{ name: "peer-a", peerId: "peer-id", status: "completed" }],
        });
        await automatic;

        expect(replicateFrom).toHaveBeenCalledOnce();
        expect(requestSynchroniseToPeer).toHaveBeenCalledOnce();
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

describe("P2P transfer statistics lifecycle", () => {
    it.each(["completed", "cancelled", "failed"] as const)(
        "reports start and terminal cleanup for a zero-transfer %s attempt",
        async (status) => {
            const { replicator, events } = createReplicator();
            const local = installControlOnlyPathIdentityDatabase(replicator, 12);
            const { replicator: peer } = createReplicator();
            const remote = installControlOnlyPathIdentityDatabase(peer, 12);
            remote.info.mockResolvedValue({ db_name: "remote-control", update_seq: 0, doc_count: 2 });
            const controller = new AbortController();
            if (status === "failed") remote.changes.mockRejectedValueOnce(new Error("changes unavailable"));
            if (status === "cancelled")
                remote.changes.mockImplementationOnce(async () => {
                    controller.abort();
                    return { results: [], last_seq: 0, pending: 0 };
                });
            const invokeRemoteFunction = vi.fn(async () => undefined);
            replicator.server = {
                serverPeerId: "local-peer",
                _knownAdvertisements: new Map(),
                getConnection: () => ({ getRemoteDB: () => remote, invokeRemoteFunction }),
            } as unknown as P2PHost;
            vi.spyOn(replicator as any, "canStartOrdinaryReplication").mockResolvedValue(true);
            vi.spyOn(replicator, "requestAuthenticate").mockResolvedValue(true);
            vi.spyOn(replicator, "checkTweakValues").mockResolvedValue(true);
            const reports: any[] = [];
            events.onEvent(EVENT_P2P_REPLICATOR_PROGRESS, (report) => reports.push(report));

            const outcome = await replicator.replicateFrom("remote-peer", false, false, false, controller.signal);

            expect(outcome.status).toBe(status);
            expect(reports.filter((report) => report.fetching).map((report) => report.fetching.isActive)).toEqual([
                true,
                false,
            ]);
            expect(reports[0].fetching.statistics).toEqual({ documents: 0, checkedChanges: 0 });
            const acknowledgements = invokeRemoteFunction.mock.calls.filter(
                ([method]) => method === "onProgressAcknowledged"
            );
            expect(acknowledgements[0][1][1].statistics).toEqual({ documents: 0, checkedChanges: 0 });
            expect(acknowledgements.at(-1)?.[1][1]).toBeUndefined();
            expect(local.bulkDocs).not.toHaveBeenCalled();
            expect(replicator._env.processReplicatedDocs).not.toHaveBeenCalled();
        }
    );

    it("accepts legacy sequence acknowledgements without inventing observed zero statistics", () => {
        const { replicator, events } = createReplicator();
        const reports: any[] = [];
        events.onEvent(EVENT_P2P_REPLICATOR_PROGRESS, (report) => reports.push(report));
        replicator.onProgressAcknowledged("peer", { lastSeq: 50, maxSeqInBatch: 75 });
        expect(reports[0].sending).toEqual({ current: 50, max: 75, isActive: true });
        replicator.onProgressAcknowledged("peer", {
            lastSeq: 75,
            maxSeqInBatch: 75,
            statistics: { documents: 0, checkedChanges: 20 },
        } as any);
        expect(reports[1].sending.statistics).toEqual({ documents: 0, checkedChanges: 20 });
    });
});

describe("P2P acknowledgement attempt fencing", () => {
    it("ignores replaced attempts, reordered batches, and updates after a terminal marker", () => {
        const { replicator, events } = createReplicator();
        const reports: any[] = [];
        events.onEvent(EVENT_P2P_REPLICATOR_PROGRESS, (report) => reports.push(report));
        const acknowledge = replicator.onProgressAcknowledged.bind(replicator) as any;
        const info = (documents: number, checkedChanges: number) => ({
            lastSeq: checkedChanges,
            maxSeqInBatch: 100,
            statistics: { documents, checkedChanges },
        });
        acknowledge("peer", info(2, 5), { attempt: 2 });
        acknowledge("peer", info(1, 3), { attempt: 1 });
        acknowledge("peer", undefined, { attempt: 1 });
        acknowledge("peer", info(1, 2), { attempt: 2 });
        expect(reports).toHaveLength(1);
        acknowledge("peer", undefined, { attempt: 2 });
        expect(reports.at(-1).sending.isActive).toBe(false);
        acknowledge("peer", info(3, 7), { attempt: 2 });
        expect(reports).toHaveLength(2);
        acknowledge("peer", info(0, 0), { attempt: 3 });
        expect(reports.at(-1).sending.statistics).toEqual({ documents: 0, checkedChanges: 0 });
        expect(reports.at(-1).sending.isActive).toBe(true);
    });
});

describe("P2P terminal acknowledgement wire compatibility", () => {
    it("retains final counts and sequences when a JSON terminal overtakes every batch acknowledgement", async () => {
        const { replicator, events } = createReplicator();
        const collector = new P2PLogCollector(events);
        const terminal = JSON.parse(
            JSON.stringify([
                "peer",
                undefined,
                {
                    attempt: 20,
                    finalProgress: { lastSeq: 80, maxSeqInBatch: 100, statistics: { documents: 2, checkedChanges: 7 } },
                },
            ])
        );
        await replicator.getCommands().onProgressAcknowledged(...(terminal as [string, any, any]));
        expect(collector.p2pReplicationStats.value[0].sending).toEqual({
            current: 80,
            max: 100,
            isActive: false,
            statistics: { documents: 2, checkedChanges: 7 },
        });
        replicator.onProgressAcknowledged(
            "peer",
            {
                lastSeq: 40,
                maxSeqInBatch: 100,
                statistics: { documents: 1, checkedChanges: 3 },
            },
            { attempt: 20 }
        );
        expect(collector.p2pReplicationStats.value[0].sending.statistics).toEqual({ documents: 2, checkedChanges: 7 });
        expect(collector.p2pReplicationStats.value[0].sending.isActive).toBe(false);
        collector.dispose();
    });
});

describe("P2P diagnostic observations preserve control flow", () => {
    it.each([
        { result: false, error: undefined, code: "auth-refused", reason: "authentication-refused" },
        { result: true, error: undefined, code: "auth-accepted", reason: undefined },
        { result: undefined, error: undefined, code: "auth-error", reason: "authentication-unobserved" },
        { result: null, error: undefined, code: "auth-error", reason: "authentication-unobserved" },
        { result: 0, error: undefined, code: "auth-error", reason: "authentication-unobserved" },
        {
            result: { ok: true, message: "secret malformed response" },
            error: undefined,
            code: "auth-error",
            reason: "authentication-unobserved",
        },
        {
            result: false,
            error: { code: "TIMEOUT", message: "secret timeout details" },
            code: "auth-timeout",
            reason: "rpc-timeout",
        },
        {
            result: false,
            error: { code: "CANCELLED", message: "secret cancelled details" },
            code: "auth-cancelled",
            reason: "rpc-cancelled",
        },
        { result: false, error: new Error("secret failure details"), code: "auth-error", reason: "rpc-error" },
    ])("distinguishes $code while retaining authentication results", async ({ result, error, code, reason }) => {
        const { replicator } = createReplicator();
        const report = vi.fn();
        (replicator._env as any).reportDiagnostic = report;
        const invoke = vi.fn(async () => {
            if (error) throw error;
            return result;
        });
        replicator.server = {
            serverPeerId: "local-peer",
            getConnection: () => ({ invokeRemoteObjectFunction: invoke }),
        } as any;
        await expect(replicator.requestAuthenticate("remote-peer")).resolves.toBe(result);
        expect(invoke).toHaveBeenCalledExactlyOnceWith("!reqAuth", ["local-peer"], 20000, undefined);
        expect(report).toHaveBeenCalledExactlyOnceWith({
            category: "peer",
            code,
            peerId: "remote-peer",
            timestamp: expect.any(Number),
            ...(reason ? { reason } : {}),
        });
        expect(JSON.stringify(report.mock.calls)).not.toContain("secret");
    });

    it.each(["completed", "failed", "cancelled"] as const)(
        "observes a finite %s pull without changing its result",
        async (status) => {
            const { replicator } = createReplicator();
            const report = vi.fn();
            (replicator._env as any).reportDiagnostic = report;
            vi.spyOn(replicator, "requestAuthenticate").mockResolvedValue(true);
            vi.spyOn(replicator, "checkTweakValues").mockResolvedValue(true);
            const local = installControlOnlyPathIdentityDatabase(replicator);
            const remote = {
                ...local,
                info: vi.fn(async () => ({ ...(await local.info()), db_name: "remote-control-only-db" })),
            };
            const controller = new AbortController();
            const failure = new Error("private details");
            const getRemoteDB = vi.fn(() => {
                if (status !== "completed") {
                    if (status === "cancelled") {
                        controller.abort();
                    }
                    throw failure;
                }
                return remote;
            });
            replicator.server!.getConnection = vi.fn(() => ({
                getRemoteDB,
                invokeRemoteFunction: vi.fn(async () => undefined),
            })) as never;

            const result = await replicator.replicateFrom("remote-peer", false, false, false, controller.signal);
            expect(getRemoteDB).toHaveBeenCalledOnce();
            if (status === "failed") {
                expect(result).toEqual({ status, error: failure });
                if (result.status === "failed") {
                    expect(result.error).toBe(failure);
                }
            } else {
                expect(result).toEqual(status === "completed" ? { status, ok: true } : { status });
            }
            expect(report.mock.calls.map(([event]) => event.code)).toEqual(["pull-started", `pull-${status}`]);
            expect(JSON.stringify(report.mock.calls)).not.toContain("private details");
        }
    );

    it("observes ignored change notifications without starting a pull, and contains reporter failures", async () => {
        const { replicator } = createReplicator();
        const report = vi.fn();
        (replicator._env as any).reportDiagnostic = report;
        const pull = vi.spyOn(replicator, "replicateFrom");
        await expect(replicator.onUpdateDatabase("peer")).resolves.toBe(false);
        expect(pull).not.toHaveBeenCalled();
        expect(report).toHaveBeenCalledExactlyOnceWith({
            category: "sync",
            code: "change-notification-ignored",
            reason: "not-watching",
            peerId: "peer",
            timestamp: expect.any(Number),
        });
        report.mockImplementation(() => {
            throw new Error("observer unavailable");
        });
        expect(() => replicator.watchPeer("peer")).not.toThrow();
        expect(replicator._watchingPeers.has("peer")).toBe(true);
    });
});

describe("P2P watch diagnostic boundaries", () => {
    it("observes watch decisions without changing notification admission", async () => {
        const { replicator } = createReplicator({ P2P_AutoWatchPeers: "Device" });
        const report = vi.fn();
        replicator._env.reportDiagnostic = report;
        vi.spyOn(replicator, "getRemoteIsBroadcasting").mockResolvedValue(false);
        await replicator.onNewPeer({ peerId: "peer", name: "Device", platform: "test" });
        expect(report).toHaveBeenLastCalledWith({
            category: "sync",
            code: "watch-skipped",
            peerId: "peer",
            reason: "peer-not-broadcasting",
            timestamp: expect.any(Number),
        });
        replicator.watchPeer("peer");
        replicator.watchPeer("peer");
        expect(report.mock.calls.filter(([event]) => event.code === "watch-enabled")).toHaveLength(1);
        const result = { status: "completed", ok: true } as const;
        const pull = vi.spyOn(replicator, "replicateFrom").mockResolvedValue(result);
        await expect(replicator.onUpdateDatabase("peer")).resolves.toBe(result);
        expect(pull).toHaveBeenCalledExactlyOnceWith("peer");
        expect(report.mock.calls.at(-1)?.[0].code).toBe("change-notification-received");
        replicator.unwatchPeer("peer");
        expect(report.mock.calls.at(-1)?.[0].code).toBe("watch-disabled");
    });
});

describe("P2P diagnostic observation accuracy", () => {
    it("keeps an unavailable broadcast status distinct from an explicit false result", async () => {
        const { replicator } = createReplicator({ P2P_AutoWatchPeers: "Device" });
        const report = vi.fn();
        replicator._env.reportDiagnostic = report;
        vi.spyOn(replicator, "getRemoteIsBroadcasting").mockResolvedValue(undefined);
        await replicator.onNewPeer({ peerId: "peer", name: "Device", platform: "test" });
        expect(replicator._watchingPeers.has("peer")).toBe(false);
        expect(report).toHaveBeenLastCalledWith({
            category: "sync",
            code: "watch-skipped",
            peerId: "peer",
            reason: "peer-broadcast-unobserved",
            timestamp: expect.any(Number),
        });
    });

    it("does not claim an active broadcast feed when its creation throws", () => {
        const { replicator } = createReplicator();
        const report = vi.fn();
        replicator._env.reportDiagnostic = report;
        (replicator._env as any).db = {
            changes: () => {
                throw new Error("feed creation unavailable");
            },
        };
        expect(() => replicator.enableBroadcastChanges()).toThrow("feed creation unavailable");
        expect(report).not.toHaveBeenCalled();
    });

    it("observes an unexpected feed failure without exposing the error or repeating a later completion", () => {
        const { replicator } = createReplicator();
        const report = vi.fn();
        const callbacks = new Map<string, (reason?: unknown) => void>();
        const feed = {
            cancel: vi.fn(),
            removeAllListeners: vi.fn(),
            on: vi.fn((event: string, callback: (reason?: unknown) => void) => {
                callbacks.set(event, callback);
                return feed;
            }),
        };
        replicator._env.reportDiagnostic = report;
        (replicator._env as any).db = { changes: () => feed };
        vi.spyOn(replicator, "notifyProgress").mockResolvedValue(undefined);
        replicator.enableBroadcastChanges();
        callbacks.get("error")?.(new Error("secret feed failure"));
        callbacks.get("complete")?.();
        expect(report.mock.calls.map(([event]) => event.code)).toEqual(["broadcast-enabled", "broadcast-disabled"]);
        expect(report.mock.calls.at(-1)?.[0].reason).toBe("replication-error");
        expect(JSON.stringify(report.mock.calls)).not.toContain("secret feed failure");
        expect(replicator._isBroadcasting).toBe(false);
    });
});
