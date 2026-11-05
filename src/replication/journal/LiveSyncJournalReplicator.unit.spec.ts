import { afterEach, describe, expect, it, vi } from "vitest";
import {
    DEFAULT_SETTINGS,
    DEVICE_ID_PREFERRED,
    type EntryMilestoneInfo,
    type RemoteDBSettings,
} from "@lib/common/types.ts";
import { LiveSyncJournalReplicator, isLiveSyncJournalReplicator } from "./LiveSyncJournalReplicator.ts";
import { ensureRemoteIsCompatible } from "@lib/pouchdb/LiveSyncDBFunctions.ts";
import { MinioStorageAdapter } from "./objectstore/MinioStorageAdapter.ts";
import { JournalSyncCore } from "./JournalSyncCore.ts";
import { JournalStorageReadStatuses } from "./objectstore/JournalStorageAdapter.ts";
import { createServiceContext } from "@lib/services/base/ServiceBase.ts";
import { defaultLogger, setGlobalLogFunction } from "@lib/common/logger.ts";
import { decryptString } from "@lib/encryption/stringEncryption.ts";
import { computeKeyedId } from "@lib/common/idDerivation.ts";
import {
    CENTRAL_COMPATIBILITY_REJECTION_REASONS,
    centralCompatibilityRejected,
} from "@lib/replication/CentralCompatibility.ts";

afterEach(() => {
    vi.restoreAllMocks();
});

describe("LiveSyncJournalReplicator initialisation", () => {
    it("throws synchronously before reconfiguring a client with an unsupported version", () => {
        const replicator = new LiveSyncJournalReplicator({} as never);
        const applyNewConfig = vi.fn();
        (replicator as any)._client = { applyNewConfig };
        const settings = { ...DEFAULT_SETTINGS, pathNormalizationVersion: 2 };

        expect(() => replicator.setupJournalSyncClient(settings)).toThrow("Unsupported path normalisation version: 2");
        expect(applyNewConfig).not.toHaveBeenCalled();
    });

    it("rejects an unsupported reset before stopping replication", async () => {
        const replicator = new LiveSyncJournalReplicator({} as never);
        const close = vi.spyOn(replicator, "closeReplication").mockImplementation(() => undefined);

        await expect(
            replicator.tryResetRemoteDatabase({ ...DEFAULT_SETTINGS, pathNormalizationVersion: 2 })
        ).rejects.toThrow("Unsupported path normalisation version: 2");
        expect(close).not.toHaveBeenCalled();
    });

    it("keeps a connection check failure as false without contacting storage", async () => {
        const replicator = new LiveSyncJournalReplicator({} as never);
        const listFiles = vi.spyOn(MinioStorageAdapter.prototype, "listFiles").mockResolvedValue([]);

        await expect(
            replicator.tryConnectRemote({ ...DEFAULT_SETTINGS, pathNormalizationVersion: 2 }, false)
        ).resolves.toBe(false);
        expect(listFiles).not.toHaveBeenCalled();
    });

    it("does not access the local database while constructing a remote-only replicator", () => {
        const getLocalDatabase = vi.fn(() => {
            throw new Error("Local database is not ready yet.");
        });
        const env = {
            services: {
                database: {
                    get localDatabase() {
                        return getLocalDatabase();
                    },
                },
            },
        } as unknown as ConstructorParameters<typeof LiveSyncJournalReplicator>[0];

        expect(() => new LiveSyncJournalReplicator(env)).not.toThrow();
        expect(getLocalDatabase).not.toHaveBeenCalled();
    });

    it("binds a Security Seed read to the supplied Object Storage settings snapshot", async () => {
        const currentSettings = {
            ...DEFAULT_SETTINGS,
            endpoint: "https://current.example.test",
            bucket: "current-vault",
        };
        const trialSettings = {
            ...DEFAULT_SETTINGS,
            endpoint: "https://trial.example.test",
            bucket: "trial-vault",
        };
        const currentSettingsReader = vi.fn(() => currentSettings);
        const replicator = new LiveSyncJournalReplicator({
            services: {
                setting: { currentSettings: currentSettingsReader },
                keyValueDB: { simpleStore: {} },
                replication: { parseSynchroniseResult: vi.fn() },
            },
        } as never);
        let observedSettings: Pick<RemoteDBSettings, "endpoint" | "bucket"> | undefined;
        vi.spyOn(JournalSyncCore.prototype, "getReplicationPBKDF2Salt").mockImplementation(async function () {
            observedSettings = { endpoint: this._settings.endpoint, bucket: this._settings.bucket };
            return new Uint8Array([1]);
        });

        const seed = await replicator.getReplicationPBKDF2Salt(trialSettings);

        expect(seed).toEqual(new Uint8Array([1]));
        expect(observedSettings).toEqual({ endpoint: trialSettings.endpoint, bucket: trialSettings.bucket });
        expect(currentSettingsReader).not.toHaveBeenCalled();
    });
});

describe("LiveSyncJournalReplicator replication outcomes", () => {
    it("does not report an incomplete journal transfer as completed", async () => {
        const replicator = Object.create(LiveSyncJournalReplicator.prototype) as LiveSyncJournalReplicator;
        const sync = vi.fn().mockResolvedValue(false);
        vi.spyOn(replicator, "checkReplicationConnectivity").mockResolvedValue(true);
        vi.spyOn(replicator, "setupJournalSyncClient").mockReturnValue({
            sync,
            resetAllCaches: vi.fn(),
        } as never);

        await expect(replicator.openReplication(DEFAULT_SETTINGS, false, false)).resolves.toBe(false);
        expect(sync).toHaveBeenCalledWith(false);
    });

    it("discards prepared parameters after a failed Journal transfer", async () => {
        const replicator = Object.create(LiveSyncJournalReplicator.prototype) as LiveSyncJournalReplicator;
        const client = {
            resetAllCaches: vi.fn(),
            sync: vi.fn(async () => {
                throw new Error("transfer failed");
            }),
        };
        vi.spyOn(replicator, "setupJournalSyncClient").mockReturnValue(client as never);
        vi.spyOn(replicator, "checkReplicationConnectivity").mockResolvedValue(true);

        await expect(replicator.openReplication(DEFAULT_SETTINGS, false, false)).rejects.toThrow("transfer failed");

        expect(client.resetAllCaches).toHaveBeenCalledOnce();
    });

    it("projects this attempt's compatibility rejection into its failed outcome", async () => {
        const replicator = Object.create(LiveSyncJournalReplicator.prototype) as LiveSyncJournalReplicator;
        vi.spyOn(replicator, "openReplication").mockImplementation(async (...args) => {
            args[4]?.(centralCompatibilityRejected(CENTRAL_COMPATIBILITY_REJECTION_REASONS.NODE_LOCKED));
            return false;
        });

        await expect(replicator.openOneShotReplicationWithOutcome(DEFAULT_SETTINGS, false)).resolves.toEqual({
            status: "failed",
            error: expect.any(Error),
            recoveryHint: {
                reason: "node-locked",
            },
        });
    });

    it("retains exact compatibility outcomes for both directional transfers", async () => {
        const replicator = Object.create(LiveSyncJournalReplicator.prototype) as LiveSyncJournalReplicator;
        const sendLocalJournal = vi.fn(async () => true);
        const receiveRemoteJournal = vi.fn(async () => true);
        vi.spyOn(replicator, "setupJournalSyncClient").mockReturnValue({
            sendLocalJournal,
            receiveRemoteJournal,
            resetAllCaches: vi.fn(),
        } as never);
        vi.spyOn(replicator, "checkReplicationConnectivity").mockImplementation(async (...args) => {
            args[5]?.(centralCompatibilityRejected(CENTRAL_COMPATIBILITY_REJECTION_REASONS.NODE_LOCKED));
            return false;
        });

        await expect(replicator.replicateAllToServerWithOutcome(DEFAULT_SETTINGS, false)).resolves.toMatchObject({
            status: "failed",
            recoveryHint: { reason: CENTRAL_COMPATIBILITY_REJECTION_REASONS.NODE_LOCKED },
        });
        await expect(replicator.replicateAllFromServerWithOutcome(DEFAULT_SETTINGS, false)).resolves.toMatchObject({
            status: "failed",
            recoveryHint: { reason: CENTRAL_COMPATIBILITY_REJECTION_REASONS.NODE_LOCKED },
        });
        expect(sendLocalJournal).not.toHaveBeenCalled();
        expect(receiveRemoteJournal).not.toHaveBeenCalled();
    });
});

describe("LiveSyncJournalReplicator replication compatibility state", () => {
    function createConnectivityReplicator() {
        const setting = { ...DEFAULT_SETTINGS };
        const replicator = new LiveSyncJournalReplicator({
            services: {
                API: {
                    getAppVersion: () => "app-version",
                    getPluginVersion: () => "plugin-version",
                    getPlatform: () => "test-platform",
                },
                context: createServiceContext(),
                database: { localNodeIdentity: { nodeId: "device-node" } },
                keyValueDB: { simpleStore: {} },
                replication: { parseSynchroniseResult: vi.fn() },
                setting: { currentSettings: () => setting },
                vault: {
                    getVaultName: () => "device-name",
                    vaultName: () => "vault-name",
                },
            },
        } as never);
        const client = {
            applyNewConfig: vi.fn(),
            downloadJsonWithResult: vi.fn(async () => ({ status: "not-found" })),
            ensureCheckpointCachesAreFresh: vi.fn(async () => undefined),
            getCheckpointInfo: vi.fn(async () => ({ receivedFiles: new Set<string>() })),
            hasRemoteJournals: vi.fn(async () => false),
            isAvailable: vi.fn(async () => true),
            resetAllCaches: vi.fn(),
            sync: vi.fn(async () => true),
            uploadJson: vi.fn(async () => true),
        };
        replicator._client = client as never;
        return { client, replicator, setting };
    }

    it("reads the current stopped Journal without creating or rebinding a client", () => {
        const { client, replicator } = createConnectivityReplicator();
        const stopped = Object.freeze({ key: "001-stopped.jsonl.gz", stage: "parse" as const });
        const getStoppedJournal = vi.fn(() => stopped);
        Object.assign(client, { getStoppedJournal });
        expect(replicator.getStoppedJournal()).toBe(stopped);
        expect(client.applyNewConfig).not.toHaveBeenCalled();
        replicator._client = undefined;
        expect(replicator.getStoppedJournal()).toBeUndefined();
    });

    it.each([true, false])("gates a single skip on compatibility result %s", async (compatible) => {
        const { client, replicator, setting } = createConnectivityReplicator();
        const stopped = Object.freeze({ key: "001-stopped.jsonl.gz", stage: "chunk-write" as const });
        const skipStoppedJournalAndResume = vi.fn(async () => false);
        Object.assign(client, { skipStoppedJournalAndResume });
        const connectivity = vi.spyOn(replicator, "checkReplicationConnectivity").mockResolvedValue(compatible);
        await expect(replicator.skipStoppedJournalAndResume(setting, stopped, true)).resolves.toBe(false);
        expect(connectivity).toHaveBeenCalledWith(false, false, true, setting, client, undefined);
        if (compatible) expect(skipStoppedJournalAndResume).toHaveBeenCalledWith(stopped, true);
        else expect(skipStoppedJournalAndResume).not.toHaveBeenCalled();
        expect(client.resetAllCaches).toHaveBeenCalledOnce();
    });

    it("does not skip after Stop crosses the recovery connectivity check", async () => {
        const { client, replicator, setting } = createConnectivityReplicator();
        const stopped = Object.freeze({ key: "001-stopped.jsonl.gz", stage: "chunk-write" as const });
        const skipStoppedJournalAndResume = vi.fn(async () => true);
        Object.assign(client, { skipStoppedJournalAndResume, requestStop: vi.fn() });
        vi.spyOn(replicator, "checkReplicationConnectivity").mockImplementation(async () => {
            void replicator.terminateSync();
            return true;
        });
        await expect(replicator.skipStoppedJournalAndResume(setting, stopped)).resolves.toBe(false);
        expect(skipStoppedJournalAndResume).not.toHaveBeenCalled();
    });

    it("passes one captured Journal client through compatibility assessment and transfer", async () => {
        const { client, replicator, setting } = createConnectivityReplicator();

        await expect(replicator.openReplication(setting, false, false)).resolves.toBe(true);

        expect(replicator._client).toBe(client);
        expect(client.isAvailable).toHaveBeenCalledOnce();
        expect(client.downloadJsonWithResult).toHaveBeenCalledWith("_00000000-milestone.json");
        expect(client.getCheckpointInfo).toHaveBeenCalledOnce();
        expect(client.sync).toHaveBeenCalledOnce();
    });

    it("clears the preferred tweak value when a later full assessment succeeds", async () => {
        const { replicator } = createConnectivityReplicator();
        const preferred = { customChunkSize: 60 };
        vi.spyOn(replicator, "ensureBucketIsCompatible")
            .mockResolvedValueOnce(["MISMATCHED", preferred] as never)
            .mockResolvedValueOnce("OK");

        await expect(replicator.checkReplicationConnectivity(false)).resolves.toBe(false);
        expect(replicator.tweakSettingsMismatched).toBe(true);
        expect(replicator.preferredTweakValue).toBe(preferred);

        await expect(replicator.checkReplicationConnectivity(false)).resolves.toBe(true);
        expect(replicator.tweakSettingsMismatched).toBe(false);
        expect(replicator.preferredTweakValue).toBeUndefined();
    });

    it("rejects a keyed Journal from legacy mode even when tweak checks are disabled", async () => {
        const { client, replicator, setting } = createConnectivityReplicator();
        setting.disableCheckingConfigMismatch = true;
        replicator.nodeid = "legacy-node";
        const milestone = {
            _id: "_00000000-milestone.json",
            type: "milestoneinfo",
            created: Date.now(),
            locked: false,
            accepted_nodes: ["keyed-node"],
            node_chunk_info: { "keyed-node": { min: 3, max: 3, current: 3 } },
            node_info: {},
            tweak_values: { [DEVICE_ID_PREFERRED]: { idDerivationVersion: 1 } },
        } as EntryMilestoneInfo;
        client.downloadJsonWithResult.mockImplementation(
            async () => ({ status: "available", value: milestone }) as never
        );

        await expect(
            replicator.checkReplicationConnectivity(false, false, false, setting, client as never)
        ).resolves.toBe(false);
    });

    it.each([0, 1] as const)(
        "refuses to initialise compatibility over journals with a missing milestone in mode %s",
        async (pathVersion) => {
            const { client, replicator, setting } = createConnectivityReplicator();
            setting.pathNormalizationVersion = pathVersion;
            client.hasRemoteJournals.mockResolvedValue(true);

            await expect(
                replicator.checkReplicationConnectivity(false, false, false, setting, client as never)
            ).rejects.toThrow(/milestone/i);
            expect(client.uploadJson).not.toHaveBeenCalled();
            expect(client.getCheckpointInfo).not.toHaveBeenCalled();
        }
    );

    it.each([0, 1] as const)(
        "uses the compatibility range even after preferred tweaks have been cleared: %s",
        async (localVersion) => {
            const { client, replicator, setting } = createConnectivityReplicator();
            setting.pathNormalizationVersion = localVersion;
            setting.disableCheckingConfigMismatch = true;
            setting.ignoreVersionCheck = true;
            client.downloadJsonWithResult.mockResolvedValue({
                status: "available",
                value: {
                    _id: "_00000000-milestone.json",
                    type: "milestoneinfo",
                    created: 1,
                    locked: false,
                    accepted_nodes: ["remote"],
                    node_chunk_info: {
                        remote: localVersion === 0 ? { min: 4, max: 4, current: 4 } : { min: 0, max: 2, current: 2 },
                    },
                    node_info: {},
                    tweak_values: {},
                },
            } as never);

            await expect(
                replicator.checkReplicationConnectivity(false, false, false, setting, client as never)
            ).resolves.toBe(false);
            expect(client.uploadJson).not.toHaveBeenCalled();
        }
    );

    it("admits NFC Journal identity using its distinct compatibility range", async () => {
        const { client, replicator, setting } = createConnectivityReplicator();
        setting.pathNormalizationVersion = 1;
        replicator.nodeid = "nfc-node";

        await expect(replicator.openReplication(setting, false, false)).resolves.toBe(true);

        expect(client.isAvailable).toHaveBeenCalledOnce();
        expect(client.sync).toHaveBeenCalledOnce();
        expect(client.uploadJson.mock.calls[0][1]).toMatchObject({
            node_chunk_info: { "nfc-node": { min: 4, max: 4, current: 4 } },
            tweak_values: { [DEVICE_ID_PREFERRED]: { pathNormalizationVersion: 1 } },
        });
    });

    it.each([0, 1] as const)(
        "rejects a Journal with the other path identity even when warnings and version checks are disabled: %s",
        async (localVersion) => {
            const { client, replicator, setting } = createConnectivityReplicator();
            setting.pathNormalizationVersion = localVersion;
            setting.disableCheckingConfigMismatch = true;
            setting.ignoreVersionCheck = true;
            const remoteVersion = localVersion === 0 ? 1 : 0;
            client.downloadJsonWithResult.mockResolvedValue({
                status: "available",
                value: {
                    _id: "_00000000-milestone.json",
                    type: "milestoneinfo",
                    created: 1,
                    locked: false,
                    accepted_nodes: ["remote"],
                    node_chunk_info: {
                        remote: remoteVersion === 1 ? { min: 4, max: 4, current: 4 } : { min: 0, max: 2, current: 2 },
                    },
                    node_info: {},
                    tweak_values: {
                        [DEVICE_ID_PREFERRED]: { ...DEFAULT_SETTINGS, pathNormalizationVersion: remoteVersion },
                    },
                },
            } as never);

            await expect(
                replicator.checkReplicationConnectivity(false, false, false, setting, client as never)
            ).resolves.toBe(false);
            expect(client.uploadJson).not.toHaveBeenCalled();
            expect(client.sync).not.toHaveBeenCalled();
        }
    );
});

describe("LiveSyncJournalReplicator compatibility milestone", () => {
    const compatibilityVersionRange = { min: 0, max: 2, current: 2 };

    function createReplicator(readResult: unknown, uploadResult = true) {
        const currentSettings = { ...DEFAULT_SETTINGS };
        const replicator = new LiveSyncJournalReplicator({
            services: {
                API: {
                    getAppVersion: vi.fn(() => "app-version"),
                    getPluginVersion: vi.fn(() => "plugin-version"),
                    getPlatform: vi.fn(() => "test-platform"),
                },
                vault: {
                    getVaultName: vi.fn(() => "device-name"),
                    vaultName: vi.fn(() => "vault-name"),
                },
                setting: { currentSettings: vi.fn(() => currentSettings) },
                keyValueDB: { simpleStore: {} },
                replication: { parseSynchroniseResult: vi.fn() },
            },
        } as never);
        const downloadJson = vi.fn(async () => false);
        const downloadJsonWithResult = vi.fn(async () => readResult);
        const getCheckpointInfo = vi.fn(async () => ({ receivedFiles: new Set<string>() }));
        const uploadJson = vi.fn(async () => uploadResult);
        vi.spyOn(replicator, "setupJournalSyncClient").mockReturnValue({
            downloadJson,
            downloadJsonWithResult,
            getCheckpointInfo,
            uploadJson,
            hasRemoteJournals: vi.fn(async () => false),
        } as never);
        return { downloadJson, downloadJsonWithResult, getCheckpointInfo, replicator, uploadJson };
    }

    it("initialises and writes a compatibility milestone after a not-found read", async () => {
        const { downloadJsonWithResult, replicator, uploadJson } = createReplicator({ status: "not-found" });

        await expect(replicator.ensureBucketIsCompatible("device-node", compatibilityVersionRange)).resolves.toBe("OK");

        expect(downloadJsonWithResult).toHaveBeenCalledWith("_00000000-milestone.json");
        expect(uploadJson).toHaveBeenCalledOnce();
    });

    async function createKeyedJournalWithClearedTweaks(pathNormalizationVersion: 0 | 1) {
        const keyed = {
            ...DEFAULT_SETTINGS,
            pathNormalizationVersion,
            encrypt: true,
            passphrase: "content-passphrase",
            usePathObfuscation: true,
            idDerivationVersion: 1,
            idDerivationKey: "ab".repeat(32),
        } as RemoteDBSettings;
        const keyedRange =
            pathNormalizationVersion === 1 ? { min: 4, max: 4, current: 4 } : { min: 3, max: 3, current: 3 };
        const initial = createReplicator({ status: "not-found" });
        Object.assign(initial.replicator.setupJournalSyncClient(), {
            hasRemoteJournals: vi.fn(async () => false),
        });
        await expect(initial.replicator.ensureBucketIsCompatible("keyed", keyedRange, keyed)).resolves.toBe("OK");
        const milestone = initial.uploadJson.mock.calls[0][1] as EntryMilestoneInfo;
        expect(milestone.encrypted_id_derivation_proof).toBeTruthy();
        initial.downloadJson.mockResolvedValue(milestone as never);
        await initial.replicator.resetRemoteTweakSettings(keyed);
        expect(milestone.tweak_values).toEqual({});
        expect(milestone.encrypted_id_derivation_proof).toBeTruthy();
        return { keyed, milestone };
    }

    it.each([
        [0, false],
        [0, true],
        [1, false],
        [1, true],
    ] as const)(
        "rejects unkeyed document IDs after clearing Tweaks (path %s, warnings disabled %s)",
        async (pathNormalizationVersion, disableCheckingConfigMismatch) => {
            const { keyed, milestone } = await createKeyedJournalWithClearedTweaks(pathNormalizationVersion);
            const incoming = createReplicator({ status: "available", value: milestone });
            const unkeyed = {
                ...keyed,
                idDerivationVersion: 0,
                idDerivationKey: "",
                disableCheckingConfigMismatch,
            } as RemoteDBSettings;
            const unkeyedRange =
                pathNormalizationVersion === 1 ? { min: 4, max: 4, current: 4 } : { min: 0, max: 2, current: 2 };
            const result = await incoming.replicator.ensureBucketIsCompatible("unkeyed", unkeyedRange, unkeyed);
            expect(result).not.toBe("OK");
            expect(incoming.uploadJson).not.toHaveBeenCalled();
        }
    );

    it.each(["inspect", "resolve", "lock", "unlock"] as const)(
        "rejects incompatible document IDs before Journal %s",
        async (operation) => {
            const { keyed, milestone } = await createKeyedJournalWithClearedTweaks(1);
            const before = structuredClone(milestone);
            const unkeyed = { ...keyed, idDerivationVersion: 0, idDerivationKey: "" } as RemoteDBSettings;
            const incoming = createReplicator({ status: "available", value: milestone });
            incoming.replicator.nodeid = "unkeyed";
            const attempt =
                operation === "inspect"
                    ? incoming.replicator.assertRemotePathIdentity(unkeyed)
                    : operation === "resolve"
                      ? incoming.replicator.markRemoteResolved(unkeyed)
                      : incoming.replicator.markRemoteLocked(unkeyed, operation === "lock", false);
            await expect(attempt).rejects.toThrow(/ID derivation/i);
            expect(incoming.uploadJson).not.toHaveBeenCalled();
            expect(incoming.getCheckpointInfo).not.toHaveBeenCalled();
            expect(milestone).toEqual(before);
        }
    );

    it("encrypts the first ID proof and rejects a different key on the next connection", async () => {
        const key = "ab".repeat(32);
        const setting = {
            ...DEFAULT_SETTINGS,
            encrypt: true,
            passphrase: "content-passphrase",
            usePathObfuscation: true,
            idDerivationVersion: 1,
            idDerivationKey: key,
        } as RemoteDBSettings;
        const first = createReplicator({ status: "not-found" });
        await expect(
            first.replicator.ensureBucketIsCompatible("first-node", { min: 3, max: 3, current: 3 }, setting)
        ).resolves.toBe("OK");
        const milestone = first.uploadJson.mock.calls[0][1] as EntryMilestoneInfo;
        expect(milestone.encrypted_id_derivation_proof).toBeTruthy();
        expect(JSON.stringify(milestone)).not.toContain(key);
        expect(await decryptString(milestone.encrypted_id_derivation_proof!, setting.passphrase)).toBe(
            await computeKeyedId(key, "remote-agreement", "journal-milestone-v1")
        );

        const second = createReplicator({ status: "available", value: milestone });
        await expect(
            second.replicator.ensureBucketIsCompatible(
                "second-node",
                { min: 3, max: 3, current: 3 },
                {
                    ...setting,
                    idDerivationKey: "cd".repeat(32),
                }
            )
        ).resolves.toBe("ID_KEY_MISMATCH");
        expect(second.uploadJson).not.toHaveBeenCalled();
    });

    it("preserves a keyed Journal when setup resolves the remote before the first transfer", async () => {
        const setting = {
            ...DEFAULT_SETTINGS,
            encrypt: true,
            passphrase: "content-passphrase",
            usePathObfuscation: true,
            idDerivationVersion: 1,
            idDerivationKey: "ab".repeat(32),
        } as RemoteDBSettings;
        const { downloadJsonWithResult, replicator, uploadJson } = createReplicator({ status: "not-found" });
        let milestone: EntryMilestoneInfo | undefined;
        downloadJsonWithResult.mockImplementation(async () =>
            milestone ? { status: "available", value: milestone } : { status: "not-found" }
        );
        uploadJson.mockImplementation(async (_, value: EntryMilestoneInfo) => {
            milestone = value;
            return true;
        });
        replicator.nodeid = "device-node";

        await replicator.markRemoteResolved(setting);

        expect(milestone?.encrypted_id_derivation_proof).toEqual(expect.any(String));
        await expect(
            replicator.ensureBucketIsCompatible("device-node", { min: 3, max: 3, current: 3 }, setting)
        ).resolves.toBe("OK");
    });

    it("includes the encrypted ID proof when creating a locked keyed Journal", async () => {
        const setting = {
            ...DEFAULT_SETTINGS,
            encrypt: true,
            passphrase: "content-passphrase",
            usePathObfuscation: true,
            idDerivationVersion: 1,
            idDerivationKey: "ab".repeat(32),
        } as RemoteDBSettings;
        const { replicator, uploadJson } = createReplicator({ status: "not-found" });
        replicator.nodeid = "device-node";

        await replicator.markRemoteLocked(setting, true, true);

        const milestone = uploadJson.mock.calls[0][1] as EntryMilestoneInfo;
        expect(milestone.encrypted_id_derivation_proof).toEqual(expect.any(String));
        expect(await decryptString(milestone.encrypted_id_derivation_proof!, setting.passphrase)).toBe(
            await computeKeyedId(setting.idDerivationKey, "remote-agreement", "journal-milestone-v1")
        );
    });

    it("keeps the legacy Journal range and omits an ID proof for Chunk-only key differences", async () => {
        const setting = {
            ...DEFAULT_SETTINGS,
            encrypt: true,
            passphrase: "content-passphrase",
            usePathObfuscation: false,
            idDerivationVersion: 1,
            idDerivationKey: "ab".repeat(32),
        } as RemoteDBSettings;
        const first = createReplicator({ status: "not-found" });
        first.replicator.nodeid = "first-node";

        await first.replicator.markRemoteLocked(setting, true, false);
        const lockedMilestone = first.uploadJson.mock.calls[0][1] as EntryMilestoneInfo;
        expect(lockedMilestone.node_chunk_info["first-node"]).toEqual(compatibilityVersionRange);

        const second = createReplicator({ status: "not-found" });
        await expect(
            second.replicator.ensureBucketIsCompatible("second-node", compatibilityVersionRange, setting)
        ).resolves.toBe("OK");
        const milestone = second.uploadJson.mock.calls[0][1] as EntryMilestoneInfo;
        expect(milestone.encrypted_id_derivation_proof).toBeUndefined();

        const third = createReplicator({ status: "available", value: milestone });
        await expect(
            third.replicator.ensureBucketIsCompatible("third-node", compatibilityVersionRange, {
                ...setting,
                idDerivationKey: "cd".repeat(32),
            })
        ).resolves.toBe("OK");
    });

    it("does not admit an existing obfuscated Journal without an ID proof through bypass settings", async () => {
        const milestone = {
            _id: "_00000000-milestone.json",
            type: "milestoneinfo",
            created: Date.now(),
            locked: false,
            accepted_nodes: ["legacy-node"],
            node_chunk_info: { "legacy-node": compatibilityVersionRange },
            node_info: {},
            tweak_values: { [DEVICE_ID_PREFERRED]: { idDerivationVersion: 0, usePathObfuscation: true } },
        } as EntryMilestoneInfo;
        const { replicator, uploadJson } = createReplicator({ status: "available", value: milestone });
        const setting = {
            ...DEFAULT_SETTINGS,
            encrypt: true,
            passphrase: "content-passphrase",
            usePathObfuscation: true,
            idDerivationVersion: 1,
            idDerivationKey: "ab".repeat(32),
            disableCheckingConfigMismatch: true,
            ignoreVersionCheck: true,
        } as RemoteDBSettings;

        await expect(
            replicator.ensureBucketIsCompatible("new-node", { min: 3, max: 3, current: 3 }, setting)
        ).resolves.toBe("ID_KEY_MISMATCH");
        expect(uploadJson).not.toHaveBeenCalled();
    });

    it("does not rewrite an existing legacy milestone when the new ID mode is incompatible", async () => {
        const milestone = {
            _id: "_00000000-milestone.json",
            type: "milestoneinfo",
            created: Date.now(),
            locked: false,
            accepted_nodes: ["legacy-node"],
            node_chunk_info: { "legacy-node": compatibilityVersionRange },
            node_info: {},
            tweak_values: { [DEVICE_ID_PREFERRED]: { idDerivationVersion: 0 } },
        } as EntryMilestoneInfo;
        const { replicator, uploadJson } = createReplicator({ status: "available", value: milestone });
        const setting = {
            ...DEFAULT_SETTINGS,
            encrypt: true,
            passphrase: "content-passphrase",
            usePathObfuscation: true,
            idDerivationVersion: 1,
            idDerivationKey: "ab".repeat(32),
        } as RemoteDBSettings;

        await expect(
            replicator.ensureBucketIsCompatible("new-node", { min: 3, max: 3, current: 3 }, setting)
        ).resolves.toBe("ID_KEY_MISMATCH");
        expect(uploadJson).not.toHaveBeenCalled();
    });

    it("does not initialise or write a compatibility milestone after an unavailable read", async () => {
        const failure = new Error("compatibility milestone unavailable");
        const { replicator, uploadJson } = createReplicator({ status: "unavailable", error: failure });

        await expect(replicator.ensureBucketIsCompatible("device-node", compatibilityVersionRange)).rejects.toBe(
            failure
        );

        expect(uploadJson).not.toHaveBeenCalled();
    });

    it("rejects when the required compatibility milestone upload returns false", async () => {
        const { replicator, uploadJson } = createReplicator({ status: "not-found" }, false);

        await expect(replicator.ensureBucketIsCompatible("device-node", compatibilityVersionRange)).rejects.toThrow(
            "Could not upload remote milestone"
        );

        expect(uploadJson).toHaveBeenCalledOnce();
    });
});

describe("LiveSyncJournalReplicator remote mutation outcomes", () => {
    it("initialises a remote lock milestone only after an explicit not-found result", async () => {
        const replicator = new LiveSyncJournalReplicator({
            services: {
                database: { localNodeIdentity: { nodeId: "local-node" } },
            },
        } as never);
        replicator.nodeid = "local-node";
        const downloadJsonWithResult = vi.fn().mockResolvedValue({
            status: JournalStorageReadStatuses.NOT_FOUND,
        });
        const uploadJson = vi.fn().mockResolvedValue(true);
        vi.spyOn(replicator, "setupJournalSyncClient").mockReturnValue({
            downloadJsonWithResult,
            uploadJson,
            hasRemoteJournals: vi.fn(async () => false),
        } as never);

        await expect(replicator.markRemoteLocked(DEFAULT_SETTINGS, true, false)).resolves.toBeUndefined();

        expect(uploadJson).toHaveBeenCalledWith(
            "_00000000-milestone.json",
            expect.objectContaining({
                _id: "_00000000-milestone.json",
                accepted_nodes: ["local-node"],
                locked: true,
            })
        );
    });

    it.each([
        [
            "markRemoteLocked",
            (replicator: LiveSyncJournalReplicator) => replicator.markRemoteLocked(DEFAULT_SETTINGS, true, false),
        ],
        [
            "markRemoteResolved",
            (replicator: LiveSyncJournalReplicator) => replicator.markRemoteResolved(DEFAULT_SETTINGS),
        ],
    ] as const)(
        "rejects %s when the typed milestone read is unavailable without uploading a replacement",
        async (_operation, run) => {
            const failure = new Error("remote milestone unavailable");
            const replicator = new LiveSyncJournalReplicator({
                services: {
                    database: { localNodeIdentity: { nodeId: "local-node" } },
                },
            } as never);
            const downloadJsonWithResult = vi.fn().mockResolvedValue({
                status: JournalStorageReadStatuses.UNAVAILABLE,
                error: failure,
            });
            const downloadJson = vi.fn().mockResolvedValue(false);
            const uploadJson = vi.fn().mockResolvedValue(true);
            vi.spyOn(replicator, "setupJournalSyncClient").mockReturnValue({
                downloadJson,
                downloadJsonWithResult,
                uploadJson,
            } as never);

            await expect(run(replicator)).rejects.toBe(failure);

            expect(downloadJsonWithResult).toHaveBeenCalledWith("_00000000-milestone.json");
            expect(downloadJson).not.toHaveBeenCalled();
            expect(uploadJson).not.toHaveBeenCalled();
        }
    );

    it("rejects an incomplete remote reset without recreating the remote database", async () => {
        const replicator = new LiveSyncJournalReplicator({} as never);
        const resetBucket = vi.fn().mockResolvedValue(false);
        vi.spyOn(replicator, "setupJournalSyncClient").mockReturnValue({ resetBucket } as never);
        vi.spyOn(replicator, "closeReplication").mockImplementation(() => undefined);
        const recreate = vi.spyOn(replicator, "tryCreateRemoteDatabase").mockResolvedValue(undefined);

        await expect(replicator.tryResetRemoteDatabase(DEFAULT_SETTINGS)).rejects.toBeDefined();

        expect(resetBucket).toHaveBeenCalledOnce();
        expect(recreate).not.toHaveBeenCalled();
    });

    it("rejects a remote lock when its milestone upload returns false", async () => {
        const replicator = new LiveSyncJournalReplicator({
            services: {
                database: { localNodeIdentity: { nodeId: "local-node" } },
            },
        } as never);
        const downloadJsonWithResult = vi.fn().mockResolvedValue({
            status: JournalStorageReadStatuses.AVAILABLE,
            value: { tweak_values: {} },
        });
        const uploadJson = vi.fn().mockResolvedValue(false);
        vi.spyOn(replicator, "setupJournalSyncClient").mockReturnValue({
            downloadJsonWithResult,
            uploadJson,
            hasRemoteJournals: vi.fn(async () => false),
        } as never);

        await expect(replicator.markRemoteLocked(DEFAULT_SETTINGS, true, false)).rejects.toBeDefined();

        expect(downloadJsonWithResult).toHaveBeenCalledOnce();
        expect(uploadJson).toHaveBeenCalledOnce();
    });
});

describe("LiveSyncJournalReplicator finite resource ownership", () => {
    it.each([
        ["successful", () => Promise.resolve([]), true],
        ["failed", () => Promise.reject(new Error("bucket unavailable")), false],
    ] as const)("disposes the Object Storage connection probe after a %s request", async (_case, run, expected) => {
        vi.spyOn(MinioStorageAdapter.prototype, "listFiles").mockImplementation(run);
        const dispose = vi.spyOn(MinioStorageAdapter.prototype, "dispose");
        const replicator = new LiveSyncJournalReplicator({} as never);

        await expect(replicator.tryConnectRemote(DEFAULT_SETTINGS, false)).resolves.toBe(expected);

        expect(dispose).toHaveBeenCalledOnce();
    });

    it("probes an NFC Object Storage connection and releases its adapter", async () => {
        const setting = { ...DEFAULT_SETTINGS, pathNormalizationVersion: 1 as const };
        const listFiles = vi.spyOn(MinioStorageAdapter.prototype, "listFiles").mockResolvedValue([]);
        const dispose = vi.spyOn(MinioStorageAdapter.prototype, "dispose");
        const replicator = new LiveSyncJournalReplicator({} as never);

        await expect(replicator.tryConnectRemote(setting, false)).resolves.toBe(true);

        expect(listFiles).toHaveBeenCalledOnce();
        expect(dispose).toHaveBeenCalledOnce();
    });

    it("does not construct a Journal client merely to close an unused Replicator", () => {
        const replicator = new LiveSyncJournalReplicator({} as never);
        replicator.updateInfo = vi.fn();
        const setupJournalSyncClient = vi
            .spyOn(replicator, "setupJournalSyncClient")
            .mockReturnValue({ requestStop: vi.fn() } as never);

        replicator.closeReplication();

        expect(setupJournalSyncClient).not.toHaveBeenCalled();
    });

    it("does not construct a Journal client merely to stop an unused Replicator", () => {
        const replicator = new LiveSyncJournalReplicator({} as never);
        const setupJournalSyncClient = vi
            .spyOn(replicator, "setupJournalSyncClient")
            .mockReturnValue({ requestStop: vi.fn() } as never);

        replicator.terminateSync();

        expect(setupJournalSyncClient).not.toHaveBeenCalled();
    });

    it("requests Stop from an existing Journal client", () => {
        const replicator = new LiveSyncJournalReplicator({} as never);
        const requestStop = vi.fn();
        replicator._client = { requestStop } as never;

        replicator.terminateSync();

        expect(requestStop).toHaveBeenCalledOnce();
    });

    it("does not settle Stop before an active Journal transfer has finished", async () => {
        let markTransferStarted!: () => void;
        const transferStarted = new Promise<void>((resolve) => {
            markTransferStarted = resolve;
        });
        let releaseTransfer!: () => void;
        const transferGate = new Promise<void>((resolve) => {
            releaseTransfer = resolve;
        });
        const sync = vi.fn(async () => {
            markTransferStarted();
            await transferGate;
            return true;
        });
        const sendLocalJournal = vi.fn(async () => true);
        const requestStop = vi.fn();
        const client = { requestStop, resetAllCaches: vi.fn(), sendLocalJournal, sync };
        const replicator = new LiveSyncJournalReplicator({} as never);
        replicator._client = client as never;
        vi.spyOn(replicator, "setupJournalSyncClient").mockReturnValue(client as never);
        vi.spyOn(replicator, "checkReplicationConnectivity").mockResolvedValue(true);

        const transfer = replicator.openReplication(DEFAULT_SETTINGS, false, false);
        await transferStarted;
        let stopSettled = false;
        const firstStop = replicator.terminateSync();
        const repeatedStop = replicator.terminateSync();
        expect(repeatedStop).toBe(firstStop);
        const stop = Promise.resolve(firstStop).then(() => {
            stopSettled = true;
        });
        const nextTransfer = replicator.replicateAllToServer(DEFAULT_SETTINGS, false);
        await Promise.resolve();

        try {
            expect(requestStop).toHaveBeenCalledTimes(2);
            expect(stopSettled).toBe(false);
            expect(sendLocalJournal).not.toHaveBeenCalled();
        } finally {
            releaseTransfer();
        }

        await expect(transfer).resolves.toBe(true);
        await stop;
        await expect(nextTransfer).resolves.toBe(true);
        expect(stopSettled).toBe(true);
        expect(sendLocalJournal).toHaveBeenCalledOnce();
    });

    it("registers transfer settlement before setup can re-enter Stop", async () => {
        let releaseConnectivity!: () => void;
        const connectivityGate = new Promise<void>((resolve) => {
            releaseConnectivity = resolve;
        });
        const requestStop = vi.fn();
        const client = { requestStop, resetAllCaches: vi.fn(), sync: vi.fn(async () => true) };
        const replicator = new LiveSyncJournalReplicator({} as never);
        replicator._client = client as never;
        let reentrantStop: Promise<void> | undefined;
        vi.spyOn(replicator, "setupJournalSyncClient").mockImplementation(() => {
            reentrantStop = replicator.terminateSync();
            return client as never;
        });
        vi.spyOn(replicator, "checkReplicationConnectivity").mockImplementation(async () => {
            await connectivityGate;
            return true;
        });

        const transfer = replicator.openReplication(DEFAULT_SETTINGS, false, false);
        expect(reentrantStop).toBeDefined();
        let stopSettled = false;
        const stop = reentrantStop?.then(() => {
            stopSettled = true;
        });
        await Promise.resolve();

        try {
            expect(requestStop).toHaveBeenCalledOnce();
            expect(stopSettled).toBe(false);
        } finally {
            releaseConnectivity();
        }

        await expect(transfer).resolves.toBe(true);
        await stop;
        expect(stopSettled).toBe(true);
    });

    it("does not start Journal sync after Stop while connectivity preflight is pending", async () => {
        let markPreflightStarted!: () => void;
        const preflightStarted = new Promise<void>((resolve) => {
            markPreflightStarted = resolve;
        });
        let releasePreflight!: (result: boolean) => void;
        const preflight = new Promise<boolean>((resolve) => {
            releasePreflight = resolve;
        });
        const sync = vi.fn(async () => true);
        const requestStop = vi.fn();
        const client = { requestStop, resetAllCaches: vi.fn(), sync };
        const replicator = new LiveSyncJournalReplicator({} as never);
        replicator._client = client as never;
        vi.spyOn(replicator, "setupJournalSyncClient").mockReturnValue(client as never);
        vi.spyOn(replicator, "checkReplicationConnectivity").mockImplementation(async () => {
            markPreflightStarted();
            return await preflight;
        });

        // Stop must cover the admitted transfer even though setup has not yet
        // crossed the preflight boundary into the Journal client's sync call.
        const transfer = replicator.openReplication(DEFAULT_SETTINGS, false, false);
        await preflightStarted;
        let stopSettled = false;
        const stop = replicator.terminateSync().then(() => {
            stopSettled = true;
        });

        expect(requestStop).toHaveBeenCalledOnce();
        expect(stopSettled).toBe(false);
        releasePreflight(true);

        await expect(transfer).resolves.toBe(false);
        await stop;
        expect(stopSettled).toBe(true);
        expect(sync).not.toHaveBeenCalled();
    });

    it("does not report replication closed when disposing a resource-only Replicator", () => {
        const replicator = new LiveSyncJournalReplicator({} as never);
        const dispose = vi.fn();
        replicator._client = { dispose } as never;
        replicator.updateInfo = vi.fn();
        const logs: Array<{ message: unknown; level?: number }> = [];
        setGlobalLogFunction((message, level) => logs.push({ message, level }));

        try {
            replicator.closeReplication();

            expect(dispose).toHaveBeenCalledOnce();
            expect(logs.some(({ message }) => message === "Replication closed")).toBe(false);
        } finally {
            setGlobalLogFunction(defaultLogger);
        }
    });

    it("reports replication closed after entering a Journal transfer", async () => {
        const replicator = new LiveSyncJournalReplicator({} as never);
        const client = { dispose: vi.fn(), resetAllCaches: vi.fn(), sync: vi.fn(async () => true) };
        replicator._client = client as never;
        replicator.updateInfo = vi.fn();
        vi.spyOn(replicator, "setupJournalSyncClient").mockReturnValue(client as never);
        vi.spyOn(replicator, "checkReplicationConnectivity").mockResolvedValue(true);
        const logs: Array<{ message: unknown; level?: number }> = [];
        setGlobalLogFunction((message, level) => logs.push({ message, level }));

        try {
            await replicator.openReplication({} as never, false, false);
            replicator.closeReplication();

            expect(logs.some(({ message }) => message === "Replication closed")).toBe(true);
        } finally {
            setGlobalLogFunction(defaultLogger);
        }
    });

    it("disposes an existing Journal client when replication closes", () => {
        const replicator = new LiveSyncJournalReplicator({} as never);
        const dispose = vi.fn();
        const client = {
            applyNewConfig: vi.fn(),
            dispose,
            requestStop: vi.fn(),
        };
        replicator._client = client as never;
        replicator.updateInfo = vi.fn();
        vi.spyOn(replicator, "setupJournalSyncClient").mockReturnValue(client as never);

        replicator.closeReplication();

        expect(dispose).toHaveBeenCalledOnce();
    });

    it("releases a disposed Journal client so later remote work cannot reuse it", () => {
        const replicator = new LiveSyncJournalReplicator({} as never);
        const dispose = vi.fn();
        replicator._client = { dispose } as never;
        replicator.updateInfo = vi.fn();

        replicator.closeReplication();

        expect(dispose).toHaveBeenCalledOnce();
        expect(replicator._client).toBeUndefined();
    });

    it.each([
        ["successful", () => Promise.resolve({ estimatedSize: 12 }), { estimatedSize: 12 }],
        ["failed", () => Promise.reject(new Error("status unavailable")), undefined],
    ] as const)("disposes the Object Storage status adapter after a %s request", async (_case, run, expected) => {
        vi.spyOn(MinioStorageAdapter.prototype, "getUsage").mockImplementation(run);
        const dispose = vi.spyOn(MinioStorageAdapter.prototype, "dispose");
        const replicator = new LiveSyncJournalReplicator({} as never);

        const operation = replicator.getRemoteStatus(DEFAULT_SETTINGS);
        if (expected === undefined) {
            await expect(operation).rejects.toThrow("status unavailable");
        } else {
            await expect(operation).resolves.toEqual(expected);
        }

        expect(dispose).toHaveBeenCalledOnce();
    });
});

describe("LiveSyncJournalReplicator remote preferred tweak values", () => {
    function createReplicator(result: unknown) {
        const replicator = new LiveSyncJournalReplicator({
            services: {
                keyValueDB: { simpleStore: {} },
                replication: { parseSynchroniseResult: vi.fn() },
            },
        } as never);
        vi.spyOn(JournalSyncCore.prototype, "downloadJsonWithResult").mockResolvedValue(result as never);
        return replicator;
    }

    it("distinguishes a missing milestone from an unavailable object store", async () => {
        const replicator = createReplicator({ status: "not-found" });

        await expect(replicator.getRemotePreferredTweakValues({} as RemoteDBSettings)).resolves.toEqual({
            status: "not-configured",
            reason: "milestone-missing",
        });
    });

    it("reports an object-store read failure as unavailable", async () => {
        const failure = new Error("network failed");
        const replicator = createReplicator({ status: "unavailable", error: failure });

        await expect(replicator.getRemotePreferredTweakValues({} as RemoteDBSettings)).resolves.toEqual({
            status: "unavailable",
            error: failure,
        });
    });

    it("distinguishes a milestone without preferred values", async () => {
        const replicator = createReplicator({ status: "available", value: { tweak_values: {} } });

        await expect(replicator.getRemotePreferredTweakValues({} as RemoteDBSettings)).resolves.toEqual({
            status: "not-configured",
            reason: "preferred-values-missing",
        });
    });

    it("returns available preferred values explicitly", async () => {
        const values = { encrypt: true };
        const replicator = createReplicator({
            status: "available",
            value: { tweak_values: { PREFERRED: values } },
        });

        await expect(replicator.getRemotePreferredTweakValues({} as RemoteDBSettings)).resolves.toEqual({
            status: "available",
            values,
        });
    });

    it("binds a preferred-tweak read to the supplied settings and disposes its trial client", async () => {
        const currentSettings = {
            ...DEFAULT_SETTINGS,
            endpoint: "https://current.example.test",
        };
        const trialSettings = {
            ...DEFAULT_SETTINGS,
            endpoint: "https://trial.example.test",
        };
        const currentSettingsReader = vi.fn(() => currentSettings);
        const replicator = new LiveSyncJournalReplicator({
            services: {
                setting: { currentSettings: currentSettingsReader },
                keyValueDB: { simpleStore: {} },
                replication: { parseSynchroniseResult: vi.fn() },
            },
        } as never);
        let observedEndpoint: string | undefined;
        vi.spyOn(JournalSyncCore.prototype, "downloadJsonWithResult").mockImplementation(async function () {
            observedEndpoint = this._settings.endpoint;
            return { status: "not-found" };
        });
        const dispose = vi.spyOn(JournalSyncCore.prototype, "dispose");

        await expect(replicator.getRemotePreferredTweakValues(trialSettings)).resolves.toEqual({
            status: "not-configured",
            reason: "milestone-missing",
        });

        expect(observedEndpoint).toBe(trialSettings.endpoint);
        expect(currentSettingsReader).not.toHaveBeenCalled();
        expect(dispose).toHaveBeenCalledOnce();
    });

    it("disposes the trial client when a preferred-tweak read rejects", async () => {
        const error = new Error("preferred values unavailable");
        const replicator = new LiveSyncJournalReplicator({
            services: {
                keyValueDB: { simpleStore: {} },
                replication: { parseSynchroniseResult: vi.fn() },
            },
        } as never);
        vi.spyOn(JournalSyncCore.prototype, "downloadJsonWithResult").mockRejectedValue(error);
        const dispose = vi.spyOn(JournalSyncCore.prototype, "dispose");

        await expect(replicator.getRemotePreferredTweakValues(DEFAULT_SETTINGS)).rejects.toBe(error);

        expect(dispose).toHaveBeenCalledOnce();
    });
});

describe("LiveSyncJournalReplicator preferred tweak writes", () => {
    function createReplicator(currentSettings: RemoteDBSettings) {
        vi.spyOn(JournalSyncCore.prototype, "hasRemoteJournals").mockResolvedValue(false);
        const currentSettingsReader = vi.fn(() => currentSettings);
        const replicator = new LiveSyncJournalReplicator({
            services: {
                setting: { currentSettings: currentSettingsReader },
                keyValueDB: { simpleStore: {} },
                replication: { parseSynchroniseResult: vi.fn() },
            },
        } as never);
        return { currentSettingsReader, replicator };
    }

    it("binds the write to the supplied settings snapshot and disposes its trial client", async () => {
        const currentSettings = { ...DEFAULT_SETTINGS, endpoint: "https://current.example.test" };
        const trialSettings = { ...DEFAULT_SETTINGS, endpoint: "https://trial.example.test" };
        const { currentSettingsReader, replicator } = createReplicator(currentSettings);
        let observedEndpoint: string | undefined;
        const milestone: EntryMilestoneInfo = { tweak_values: {} } as EntryMilestoneInfo;
        vi.spyOn(JournalSyncCore.prototype, "downloadJson").mockImplementation(async function () {
            observedEndpoint = this._settings.endpoint;
            return milestone;
        });
        const uploadJson = vi.spyOn(JournalSyncCore.prototype, "uploadJson").mockResolvedValue(true);
        const dispose = vi.spyOn(JournalSyncCore.prototype, "dispose");

        await expect(replicator.setPreferredRemoteTweakSettings(trialSettings)).resolves.toBeUndefined();

        expect(observedEndpoint).toBe(trialSettings.endpoint);
        expect(currentSettingsReader).not.toHaveBeenCalled();
        expect(uploadJson).toHaveBeenCalledWith(
            "_00000000-milestone.json",
            expect.objectContaining({
                tweak_values: expect.objectContaining({ [DEVICE_ID_PREFERRED]: expect.any(Object) }),
            })
        );
        expect(dispose).toHaveBeenCalledOnce();
    });

    it("rejects when the milestone is missing and still disposes its trial client", async () => {
        const { replicator } = createReplicator(DEFAULT_SETTINGS);
        vi.spyOn(JournalSyncCore.prototype, "downloadJson").mockResolvedValue(false);
        const dispose = vi.spyOn(JournalSyncCore.prototype, "dispose");

        await expect(replicator.setPreferredRemoteTweakSettings(DEFAULT_SETTINGS)).rejects.toThrow(
            "Missing remote milestone"
        );

        expect(dispose).toHaveBeenCalledOnce();
    });

    it("rejects when the milestone upload does not settle successfully", async () => {
        const { replicator } = createReplicator(DEFAULT_SETTINGS);
        vi.spyOn(JournalSyncCore.prototype, "downloadJson").mockResolvedValue({ tweak_values: {} } as never);
        vi.spyOn(JournalSyncCore.prototype, "uploadJson").mockResolvedValue(false);
        const dispose = vi.spyOn(JournalSyncCore.prototype, "dispose");

        await expect(replicator.setPreferredRemoteTweakSettings(DEFAULT_SETTINGS)).rejects.toThrow(
            "Could not upload remote milestone"
        );

        expect(dispose).toHaveBeenCalledOnce();
    });
});

describe("Journal path identity before recovery mutations", () => {
    function createJournal(localVersion: number, remoteVersion?: number, journals = true) {
        const setting = {
            ...DEFAULT_SETTINGS,
            pathNormalizationVersion: localVersion,
            ignoreVersionCheck: true,
            disableCheckingConfigMismatch: true,
        };
        let milestone: EntryMilestoneInfo | undefined =
            remoteVersion === undefined
                ? undefined
                : {
                      _id: "_00000000-milestone.json" as EntryMilestoneInfo["_id"],
                      type: "milestoneinfo",
                      created: 1,
                      locked: false,
                      accepted_nodes: ["existing"],
                      node_chunk_info: {
                          existing:
                              remoteVersion === 1 ? { min: 4, max: 4, current: 4 } : { min: 0, max: 2, current: 2 },
                      },
                      node_info: {},
                      tweak_values: {},
                  };
        const replicator = new LiveSyncJournalReplicator({
            services: {
                setting: { currentSettings: () => setting },
                keyValueDB: { simpleStore: {} },
                API: { getAppVersion: () => "", getPluginVersion: () => "", getPlatform: () => "" },
                vault: { getVaultName: () => "", vaultName: () => "" },
            },
        } as never);
        replicator.nodeid = "joining";
        const client = {
            downloadJsonWithResult: vi.fn(async () =>
                milestone ? { status: "available", value: structuredClone(milestone) } : { status: "not-found" }
            ),
            uploadJson: vi.fn(async (_key: string, value: EntryMilestoneInfo) => {
                milestone = structuredClone(value);
                return true;
            }),
            hasRemoteJournals: vi.fn(async () => journals),
            getCheckpointInfo: vi.fn(async () => ({ receivedFiles: new Set<string>() })),
        };
        vi.spyOn(replicator, "setupJournalSyncClient").mockReturnValue(client as never);
        return { replicator, setting, client, snapshot: () => structuredClone(milestone) };
    }

    it.each([0, 1])("inspects Journal path identity without admitting a new node: %s", async (remoteVersion) => {
        const { replicator, setting, client, snapshot } = createJournal(1, remoteVersion);
        const before = snapshot();
        await expect(replicator.inspectRemotePathIdentity(setting)).resolves.toEqual({
            status: "configured",
            pathNormalizationVersion: remoteVersion,
        });
        expect(snapshot()).toEqual(before);
        expect(client.uploadJson).not.toHaveBeenCalled();
        expect(client.getCheckpointInfo).not.toHaveBeenCalled();
    });

    it.each([
        ["undeclared legacy range", undefined, 0],
        ["earliest legacy range", { min: 0, max: 0, current: 0 }, 0],
        ["mixed legacy range", { min: 0, max: 3, current: 3 }, 0],
        ["keyed legacy range", { min: 3, max: 3, current: 3 }, 0],
        ["NFC range", { min: 4, max: 4, current: 4 }, 1],
    ] as const)("inspects a %s without writing remote state", async (_label, range, expectedVersion) => {
        const { replicator, setting, client, snapshot } = createJournal(0, 0);
        const milestone = snapshot()!;
        milestone.node_chunk_info = range ? { existing: range } : {};
        client.downloadJsonWithResult.mockResolvedValue({ status: "available", value: milestone });

        await expect(replicator.inspectRemotePathIdentity(setting)).resolves.toEqual({
            status: "configured",
            pathNormalizationVersion: expectedVersion,
        });
        expect(client.hasRemoteJournals).not.toHaveBeenCalled();
        expect(client.uploadJson).not.toHaveBeenCalled();
        expect(client.getCheckpointInfo).not.toHaveBeenCalled();
    });

    it.each([
        ["negative", -1, 2],
        ["fractional", 0, 2.5],
        ["reversed", 3, 2],
        ["mixed legacy and NFC", 0, 4],
        ["future", 5, 5],
        ["unsafe integer", 0, Number.MAX_SAFE_INTEGER + 1],
    ] as const)("rejects a %s Journal range before further inspection", async (_label, min, max) => {
        const { replicator, setting, client, snapshot } = createJournal(0, 0);
        const milestone = snapshot()!;
        milestone.node_chunk_info = { existing: { min, max, current: max } };
        client.downloadJsonWithResult.mockResolvedValue({ status: "available", value: milestone });

        await expect(replicator.inspectRemotePathIdentity(setting)).rejects.toThrow(
            "The Journal declares an unsupported path identity range."
        );
        expect(client.hasRemoteJournals).not.toHaveBeenCalled();
        expect(client.uploadJson).not.toHaveBeenCalled();
    });

    it("inspects retained ranges after accepted nodes have been cleared", async () => {
        const { replicator, setting, client, snapshot } = createJournal(0, 1);
        const milestone = snapshot()!;
        milestone.accepted_nodes = [];
        client.downloadJsonWithResult.mockResolvedValue({ status: "available", value: milestone });

        await expect(replicator.inspectRemotePathIdentity(setting)).resolves.toEqual({
            status: "configured",
            pathNormalizationVersion: 1,
        });
        expect(client.hasRemoteJournals).not.toHaveBeenCalled();
        expect(client.uploadJson).not.toHaveBeenCalled();
    });

    it.each(["retained range", "preferred setting"] as const)(
        "rejects a conflicting %s before inspecting Journal files",
        async (source) => {
            const { replicator, setting, client, snapshot } = createJournal(0, 0);
            const milestone = snapshot()!;
            if (source === "retained range") {
                milestone.node_chunk_info.retired = { min: 4, max: 4, current: 4 };
            } else {
                milestone.tweak_values = { [DEVICE_ID_PREFERRED]: { pathNormalizationVersion: 1 } };
            }
            client.downloadJsonWithResult.mockResolvedValue({ status: "available", value: milestone });

            await expect(replicator.inspectRemotePathIdentity(setting)).rejects.toThrow(
                "The Journal has conflicting path identity declarations."
            );
            expect(client.hasRemoteJournals).not.toHaveBeenCalled();
            expect(client.uploadJson).not.toHaveBeenCalled();
        }
    );

    it.each([0, 1])("does not infer a fresh Journal from missing evidence in mode %s", async (localVersion) => {
        const existing = createJournal(localVersion);
        await expect(existing.replicator.inspectRemotePathIdentity(existing.setting)).rejects.toThrow(/missing/i);
        const empty = createJournal(localVersion, undefined, false);
        await expect(empty.replicator.inspectRemotePathIdentity(empty.setting)).resolves.toEqual({ status: "empty" });
        expect(empty.client.uploadJson).not.toHaveBeenCalled();
    });

    it.each([0, 1])(
        "rejects a different identity before resolving or locking a peer (local %s)",
        async (localVersion) => {
            for (const operation of ["resolve", "lock", "unlock"]) {
                const { replicator, setting, client, snapshot } = createJournal(localVersion, 1 - localVersion);
                const before = snapshot();
                const mutation =
                    operation === "resolve"
                        ? replicator.markRemoteResolved(setting)
                        : replicator.markRemoteLocked(setting, operation === "lock", false);
                await expect(mutation).rejects.toThrow(/path identity/i);
                expect(snapshot()).toEqual(before);
                expect(client.uploadJson).not.toHaveBeenCalled();
            }
        }
    );

    it.each([0, 1])(
        "rejects missing identity before Fetch and recovery administration in mode %s",
        async (localVersion) => {
            const { replicator, setting, client, snapshot } = createJournal(localVersion);
            await expect(replicator.assertRemotePathIdentity(setting)).rejects.toThrow(/milestone/i);
            await expect(replicator.markRemoteResolved(setting)).rejects.toThrow(/milestone/i);
            await expect(replicator.markRemoteLocked(setting, true, false)).rejects.toThrow(/milestone/i);
            await expect(replicator.markRemoteLocked(setting, false, false)).rejects.toThrow(/milestone/i);
            expect(snapshot()).toBeUndefined();
            expect(client.uploadJson).not.toHaveBeenCalled();
            expect(client.getCheckpointInfo).not.toHaveBeenCalled();
        }
    );

    it("keeps a compatible peer admitted after an incompatible peer is refused", async () => {
        const { replicator, setting, client, snapshot } = createJournal(0, 1);
        const nfcSettings = { ...setting, pathNormalizationVersion: 1 };
        await expect(
            replicator.ensureBucketIsCompatible(
                "existing",
                { min: 4, max: 4, current: 4 },
                nfcSettings,
                client as never
            )
        ).resolves.toBe("OK");
        const original = snapshot();
        client.uploadJson.mockClear();
        await expect(replicator.markRemoteResolved(setting)).rejects.toThrow(/path identity/i);
        expect(snapshot()).toEqual(original);
        await expect(
            replicator.ensureBucketIsCompatible(
                "existing",
                { min: 4, max: 4, current: 4 },
                nfcSettings,
                client as never
            )
        ).resolves.toBe("OK");
    });

    it("refuses preferred-setting writes from another path identity", async () => {
        const { replicator, setting, snapshot } = createJournal(0, 1);
        const upload = vi.spyOn(JournalSyncCore.prototype, "uploadJson").mockResolvedValue(true);
        vi.spyOn(JournalSyncCore.prototype, "downloadJson").mockResolvedValue(snapshot() as never);
        await expect(replicator.setPreferredRemoteTweakSettings(setting)).rejects.toThrow(/path identity/i);
        expect(upload).not.toHaveBeenCalled();
    });

    it("checks matching identity without publishing a node or reading its checkpoint", async () => {
        const { replicator, setting, client, snapshot } = createJournal(1, 1);
        const before = snapshot();
        await expect(replicator.assertRemotePathIdentity(setting)).resolves.toBeUndefined();
        expect(snapshot()).toEqual(before);
        expect(client.uploadJson).not.toHaveBeenCalled();
        expect(client.getCheckpointInfo).not.toHaveBeenCalled();
    });

    it("preserves the old identity while locking for a coordinated rebuild", async () => {
        const { replicator, setting, snapshot, client } = createJournal(1, 0);
        const before = snapshot()!;
        await replicator.markRemoteLockedForRebuild(setting);
        expect(snapshot()).toEqual({
            ...before,
            locked: true,
            accepted_nodes: [replicator.nodeid],
            node_chunk_info: { ...before.node_chunk_info, [replicator.nodeid]: before.node_chunk_info.existing },
        });
        await expect(replicator.assertRemotePathIdentity(setting)).rejects.toThrow(/path identity/i);
        expect(client.uploadJson).toHaveBeenCalledOnce();
    });

    it("keeps the old-client version gate effective while a rebuild lock is held", async () => {
        const { replicator, setting, snapshot } = createJournal(1, 1);
        await replicator.markRemoteLockedForRebuild(setting);
        const locked = snapshot()!;
        // An older client resolves itself before checking the accepted-node ranges.
        locked.accepted_nodes.push("old-client");
        locked.node_chunk_info["old-client"] = { min: 0, max: 2, current: 2 };
        const legacy = { ...DEFAULT_SETTINGS, disableCheckingConfigMismatch: true };
        await expect(
            ensureRemoteIsCompatible(
                locked,
                legacy,
                "old-client",
                { min: 0, max: 2, current: 2 },
                {
                    app_version: "",
                    plugin_version: "",
                    vault_name: "",
                    device_name: "",
                    progress: "",
                },
                async () => {}
            )
        ).resolves.toBe("INCOMPATIBLE");
    });

    it("leaves a missing milestone absent until rebuild deletes the journals", async () => {
        const { replicator, setting, snapshot, client } = createJournal(1);
        await replicator.markRemoteLockedForRebuild(setting);
        expect(snapshot()).toBeUndefined();
        expect(client.uploadJson).not.toHaveBeenCalled();
        await expect(replicator.markRemoteResolved(setting)).rejects.toThrow(/milestone/i);
    });
});

describe("isLiveSyncJournalReplicator", () => {
    it("recognises a Journal replicator and its subclasses", () => {
        class DerivedReplicator extends LiveSyncJournalReplicator {}
        expect(isLiveSyncJournalReplicator(new LiveSyncJournalReplicator({} as never))).toBe(true);
        expect(isLiveSyncJournalReplicator(new DerivedReplicator({} as never))).toBe(true);
    });

    it.each([null, undefined, {}, { getStoppedJournal: () => undefined, skipStoppedJournalAndResume: () => true }])(
        "does not accept an unrelated value with similar methods: %s",
        (value) => {
            expect(isLiveSyncJournalReplicator(value)).toBe(false);
        }
    );
});
