import { afterEach, describe, expect, it, vi } from "vitest";
import {
    DEFAULT_SETTINGS,
    DEVICE_ID_PREFERRED,
    type EntryMilestoneInfo,
    type RemoteDBSettings,
} from "@lib/common/types.ts";
import { LiveSyncJournalReplicator } from "./LiveSyncJournalReplicator.ts";
import { MinioStorageAdapter } from "./objectstore/MinioStorageAdapter.ts";
import { JournalSyncCore } from "./JournalSyncCore.ts";
import { JournalStorageReadStatuses } from "./objectstore/JournalStorageAdapter.ts";
import { createServiceContext } from "@lib/services/base/ServiceBase.ts";
import { defaultLogger, setGlobalLogFunction } from "@lib/common/logger.ts";
import {
    CENTRAL_COMPATIBILITY_REJECTION_REASONS,
    centralCompatibilityRejected,
} from "@lib/replication/CentralCompatibility.ts";

afterEach(() => {
    vi.restoreAllMocks();
});

describe("LiveSyncJournalReplicator initialisation", () => {
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
        } as never);

        await expect(replicator.openReplication(DEFAULT_SETTINGS, false, false)).resolves.toBe(false);
        expect(sync).toHaveBeenCalledWith(false);
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
            isAvailable: vi.fn(async () => true),
            sync: vi.fn(async () => true),
            uploadJson: vi.fn(async () => true),
        };
        replicator._client = client as never;
        return { client, replicator, setting };
    }

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
        } as never);
        return { downloadJson, downloadJsonWithResult, getCheckpointInfo, replicator, uploadJson };
    }

    it("initialises and writes a compatibility milestone after a not-found read", async () => {
        const { downloadJsonWithResult, replicator, uploadJson } = createReplicator({ status: "not-found" });

        await expect(replicator.ensureBucketIsCompatible("device-node", compatibilityVersionRange)).resolves.toBe("OK");

        expect(downloadJsonWithResult).toHaveBeenCalledWith("_00000000-milestone.json");
        expect(uploadJson).toHaveBeenCalledOnce();
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
        const client = { requestStop, sendLocalJournal, sync };
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
        const client = { requestStop, sync: vi.fn(async () => true) };
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
        const client = { requestStop, sync };
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
        const client = { dispose: vi.fn(), sync: vi.fn(async () => true) };
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
