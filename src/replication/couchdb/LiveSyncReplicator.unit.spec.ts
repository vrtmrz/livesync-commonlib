import { UnsupportedEncryptedDocumentFormatError } from "@lib/replication/UnsupportedEncryptedDocumentFormatError.ts";
import { NFC_PATH_IDENTITY_FEATURE, REMOTE_FEATURE_GENERATION } from "@lib/pouchdb/remoteFeatureCompatibility.ts";
import { promiseWithResolvers } from "octagonal-wheels/promises";
import { reactiveSource } from "octagonal-wheels/dataobject/reactive";
import { EventEmitter } from "node:events";
import { assert, describe, expect, it, vi } from "vitest";
import PouchDB from "pouchdb-core";
import MemoryAdapter from "pouchdb-adapter-memory";
import { createError } from "pouchdb-errors";
import HttpAdapter from "pouchdb-adapter-http";
import Checkpointer from "pouchdb-checkpointer";
import generateReplicationId from "pouchdb-generate-replication-id";
import {
    DEFAULT_SYNC_PARAMETERS,
    DEVICE_ID_PREFERRED,
    E2EEAlgorithms,
    MILESTONE_DOCID,
    VER,
    VERSIONING_DOCID,
    type EntryDoc,
    type DocumentID,
    type EntryLeaf,
    type ObsidianLiveSyncSettings,
    type RemoteDBSettings,
} from "@lib/common/types.ts";
import { Logger, LOG_LEVEL_INFO, LOG_LEVEL_NOTICE, defaultLogger, setGlobalLogFunction } from "@lib/common/logger.ts";
import { RemoteRequestError } from "@lib/common/LSError.ts";
import * as compatibility from "@lib/pouchdb/LiveSyncDBFunctions.ts";
import * as negotiation from "@lib/pouchdb/negotiation.ts";
import * as remoteIds from "@lib/pouchdb/remoteIdCompatibility.ts";
import { clearHandlers } from "@lib/replication/SyncParamsHandler.ts";
import {
    captureRemoteTransportFailure,
    getReplicationNetworkFailure,
} from "@lib/replication/remoteTransportFailure.ts";
import { PouchDB as HttpPouchDB } from "@lib/pouchdb/pouchdb-http.ts";
import { RemoteService, type RemoteServiceDependencies } from "@lib/services/base/RemoteService.ts";
import { createServiceContext } from "@lib/services/base/ServiceBase";
import { LiveSyncCouchDBReplicator } from "./LiveSyncReplicator.ts";
import {
    CENTRAL_COMPATIBILITY_REJECTION_REASONS,
    centralCompatibilityRejected,
} from "@lib/replication/CentralCompatibility.ts";
import type { InitialFetchFastForward } from "./fastForward.ts";

PouchDB.plugin(MemoryAdapter);
PouchDB.plugin(HttpAdapter);

type ReplicationOperations = {
    closeRemoteConnection: LiveSyncCouchDBReplicator["closeRemoteConnection"];
    openRemoteCouchDBWithSetting: LiveSyncCouchDBReplicator["openRemoteCouchDBWithSetting"];
    openReplicationConnection: LiveSyncCouchDBReplicator["openReplicationConnection"];
    prepareSecuritySeed: LiveSyncCouchDBReplicator["prepareSecuritySeed"];
    runOneShotReplication: LiveSyncCouchDBReplicator["runOneShotReplication"];
    runSyncTransfer: LiveSyncCouchDBReplicator["runSyncTransfer"];
};

/**
 * White-box seams are retained for deterministic retry, stop, and operation-order
 * tests. Lifecycle coverage uses the public continuous entry point and its
 * PouchDB and Remote collaborators.
 */
function operations(replicator: LiveSyncCouchDBReplicator): ReplicationOperations {
    return replicator as unknown as ReplicationOperations;
}

describe("LiveSyncCouchDBReplicator logging", () => {
    it("supplies the API log key default when the caller omits it", async () => {
        const replicator = createOneShotReplicator({ close: vi.fn().mockResolvedValue(undefined) });
        const addLog = vi.fn();
        replicator.env.services.API.addLog = addLog;

        await expect(replicator.migrate(1, 2)).resolves.toBe(true);

        expect(addLog).toHaveBeenCalledExactlyOnceWith("Database updated from 1 to 2", LOG_LEVEL_NOTICE, "");
    });

    it("routes completion logs through each replicator's own API service", () => {
        const globalLog = vi.fn();
        const firstCalls: unknown[][] = [];
        const secondCalls: unknown[][] = [];
        const firstAPI = {
            owner: "first",
            addLog(...args: unknown[]) {
                firstCalls.push([this.owner, ...args]);
            },
        };
        const secondAPI = {
            owner: "second",
            addLog(...args: unknown[]) {
                secondCalls.push([this.owner, ...args]);
            },
        };
        const createSubject = (API: typeof firstAPI) => {
            const subject = new LiveSyncCouchDBReplicator({
                services: { API },
            } as unknown as ConstructorParameters<typeof LiveSyncCouchDBReplicator>[0]);
            subject.updateInfo = vi.fn();
            return subject;
        };
        const firstReplicator = createSubject(firstAPI);
        const secondReplicator = createSubject(secondAPI);
        setGlobalLogFunction(globalLog);

        try {
            firstReplicator.replicationCompleted(true);
            secondReplicator.replicationCompleted(false);

            expect(firstCalls).toEqual([["first", "Replication completed", LOG_LEVEL_NOTICE, "sync"]]);
            expect(secondCalls).toEqual([["second", "Replication completed", LOG_LEVEL_INFO, ""]]);
            expect(globalLog).not.toHaveBeenCalled();
        } finally {
            setGlobalLogFunction(defaultLogger);
        }
    });
});

describe("LiveSyncCouchDBReplicator initialisation", () => {
    it.each([false, true])(
        "rejects NFC remote identity with legacy settings even when checks are skipped (%s)",
        async (skipCheck) => {
            const remoteDatabase = {
                get: vi.fn().mockResolvedValue({
                    _id: VERSIONING_DOCID,
                    type: "versioninfo",
                    version: 13,
                    used_features: ["nfc-path-identity-v1"],
                }),
                close: vi.fn().mockResolvedValue(undefined),
            };
            const replicator = createOneShotReplicator(remoteDatabase);
            vi.mocked(operations(replicator).openReplicationConnection).mockRestore();
            replicator.isMobile = vi.fn().mockReturnValue(false);
            Object.assign(replicator.env.services, {
                API: {
                    addLog: Logger,
                    getAppVersion: () => "test",
                    getPluginVersion: () => "test",
                    getPlatform: () => "test",
                },
                vault: { vaultName: () => "test", getVaultName: () => "test" },
            });
            vi.spyOn(operations(replicator), "openRemoteCouchDBWithSetting").mockResolvedValue({
                db: remoteDatabase,
                info: { update_seq: 0 },
                close: remoteDatabase.close,
            } as never);
            const version = vi.spyOn(negotiation, "checkRemoteVersion").mockResolvedValue(true);
            const admit = vi.spyOn(compatibility, "ensureDatabaseIsCompatible").mockResolvedValue("OK");
            const declare = vi.spyOn(negotiation, "declareRemoteFeatures").mockResolvedValue(true);
            try {
                await expect(
                    replicator.checkReplicationConnectivity(
                        {
                            versionUpFlash: "",
                            couchDB_URI: "https://example.test",
                            couchDB_DBNAME: "db",
                            pathNormalizationVersion: 0,
                            disableCheckingConfigMismatch: true,
                        } as RemoteDBSettings,
                        false,
                        skipCheck,
                        false
                    )
                ).resolves.toBe(false);
                expect(admit).not.toHaveBeenCalled();
                expect(declare).not.toHaveBeenCalled();
                expect(remoteDatabase.close).toHaveBeenCalledOnce();
            } finally {
                version.mockRestore();
                admit.mockRestore();
                declare.mockRestore();
            }
        }
    );

    it("rejects a mismatched remote document ID before declaring the feature", async () => {
        const remoteDatabase = { close: vi.fn().mockResolvedValue(undefined) };
        const replicator = createOneShotReplicator(remoteDatabase);
        vi.mocked(operations(replicator).openReplicationConnection).mockRestore();
        Object.assign(replicator.env.services, {
            API: {
                addLog: Logger,
                isMobile: () => false,
                getAppVersion: () => "test",
                getPluginVersion: () => "test",
                getPlatform: () => "test",
            },
            vault: { vaultName: () => "test", getVaultName: () => "test" },
        });
        vi.spyOn(operations(replicator), "openRemoteCouchDBWithSetting").mockResolvedValue({
            db: remoteDatabase,
            info: { update_seq: 0 },
            close: remoteDatabase.close,
        } as never);
        const version = vi.spyOn(negotiation, "checkRemoteVersion").mockResolvedValue(true);
        const admit = vi.spyOn(compatibility, "ensureDatabaseIsCompatible").mockResolvedValue("OK");
        const assess = vi.spyOn(remoteIds, "assessRemoteDocumentIds").mockResolvedValue("mismatched");
        const declare = vi.spyOn(negotiation, "declareRemoteFeatures").mockResolvedValue(true);
        try {
            const result = await replicator.checkReplicationConnectivity(
                {
                    versionUpFlash: "",
                    couchDB_URI: "https://example.test",
                    couchDB_DBNAME: "remote",
                    encrypt: true,
                    usePathObfuscation: true,
                    idDerivationVersion: 1,
                    idDerivationKey: "ab".repeat(32),
                } as RemoteDBSettings,
                false,
                false,
                false
            );
            expect(result).toBe(false);
            expect(version).not.toHaveBeenCalled();
            expect(admit).not.toHaveBeenCalled();
            expect(declare).not.toHaveBeenCalled();
        } finally {
            version.mockRestore();
            admit.mockRestore();
            assess.mockRestore();
            declare.mockRestore();
        }
    });

    it.each(["OK", "LOCKED", "NODE_LOCKED"] as const)(
        "declares the write feature only for an admitted writer (%s)",
        async (admission) => {
            const remoteDatabase = {
                close: vi.fn().mockResolvedValue(undefined),
                allDocs: vi.fn().mockResolvedValue({ rows: [] }),
            };
            const replicator = createOneShotReplicator(remoteDatabase);
            vi.mocked(operations(replicator).openReplicationConnection).mockRestore();
            Object.assign(replicator.env.services, {
                API: {
                    addLog: Logger,
                    isMobile: () => false,
                    getAppVersion: () => "test",
                    getPluginVersion: () => "test",
                    getPlatform: () => "test",
                },
                vault: { vaultName: () => "test", getVaultName: () => "test" },
            });
            vi.spyOn(operations(replicator), "openRemoteCouchDBWithSetting").mockResolvedValue({
                db: remoteDatabase,
                info: { update_seq: 0 },
                close: remoteDatabase.close,
            } as never);
            const version = vi.spyOn(negotiation, "checkRemoteVersion").mockResolvedValue(true);
            const admit = vi.spyOn(compatibility, "ensureDatabaseIsCompatible").mockResolvedValue(admission);
            const declare = vi.spyOn(negotiation, "declareRemoteFeatures").mockResolvedValue(true);
            try {
                const result = await replicator.checkReplicationConnectivity(
                    {
                        versionUpFlash: "",
                        couchDB_URI: "https://example.test",
                        couchDB_DBNAME: "remote",
                        encrypt: true,
                        usePathObfuscation: true,
                        E2EEAlgorithm: E2EEAlgorithms.V2,
                        encryptInternalMetadata: true,
                    } as RemoteDBSettings,
                    false,
                    false,
                    false
                );
                expect(result !== false).toBe(admission !== "NODE_LOCKED");
                expect(declare).toHaveBeenCalledTimes(admission === "NODE_LOCKED" ? 0 : 1);
            } finally {
                version.mockRestore();
                admit.mockRestore();
                declare.mockRestore();
            }
        }
    );

    it("allows a remote-only connection check before the local database is ready", async () => {
        const getLocalDatabase = vi.fn(() => {
            throw new Error("Local database is not ready yet.");
        });
        const env = {
            services: {
                API: {
                    addLog: Logger,
                    isMobile: () => false,
                },
                database: {
                    get localDatabase() {
                        return getLocalDatabase();
                    },
                },
            },
        } as unknown as ConstructorParameters<typeof LiveSyncCouchDBReplicator>[0];

        const replicator = new LiveSyncCouchDBReplicator(env);
        const connectionClose = vi.fn().mockResolvedValue(undefined);
        vi.spyOn(replicator, "connectRemoteCouchDBWithSetting").mockResolvedValue({
            db: {},
            info: { db_name: "remote" },
            close: connectionClose,
        } as never);

        await expect(replicator.tryConnectRemote({} as RemoteDBSettings, false)).resolves.toBe(true);
        expect(getLocalDatabase).not.toHaveBeenCalled();
        expect(connectionClose).toHaveBeenCalledOnce();
    });
});

describe("LiveSyncCouchDBReplicator finite attempt result", () => {
    it("attaches only the compatibility rejection observed by the exact attempt", async () => {
        const replicator = createOneShotReplicator({ close: vi.fn().mockResolvedValue(undefined) });
        const preferredTweakValue = { customChunkSize: 60 };
        vi.mocked(operations(replicator).openReplicationConnection)
            .mockImplementationOnce(async (...args) => {
                args[6]?.(
                    centralCompatibilityRejected(
                        CENTRAL_COMPATIBILITY_REJECTION_REASONS.TWEAK_MISMATCH,
                        preferredTweakValue
                    )
                );
                return { status: "failed" };
            })
            .mockResolvedValueOnce({ status: "failed" });
        const setting = { useRequestAPI: true } as RemoteDBSettings;

        await expect(replicator.openOneShotReplicationWithOutcome(setting, false)).resolves.toEqual({
            status: "failed",
            error: expect.any(Error),
            recoveryHint: {
                reason: "tweak-mismatch",
                preferredTweakValue,
            },
        });
        await expect(replicator.openOneShotReplicationWithOutcome(setting, false)).resolves.toEqual({
            status: "failed",
            error: expect.any(Error),
        });
    });

    it("retains exact compatibility outcomes for both directional modes", async () => {
        const remoteDatabase = { close: vi.fn().mockResolvedValue(undefined) };
        const replicator = createOneShotReplicator(remoteDatabase);
        const localDatabase = replicator.rawDatabase as unknown as {
            replicate: { from: ReturnType<typeof vi.fn>; to: ReturnType<typeof vi.fn> };
        };
        vi.mocked(operations(replicator).openReplicationConnection).mockImplementation(async (...args) => {
            args[6]?.(centralCompatibilityRejected(CENTRAL_COMPATIBILITY_REJECTION_REASONS.NODE_LOCKED));
            return {
                db: remoteDatabase,
                info: { update_seq: 9 },
                close: () => remoteDatabase.close(),
                syncOptionBase: {},
            } as never;
        });
        vi.spyOn(operations(replicator), "runSyncTransfer").mockResolvedValue({ action: "FAILED" });
        const setting = { useRequestAPI: true } as RemoteDBSettings;

        await expect(replicator.replicateAllToServerWithOutcome(setting, false)).resolves.toMatchObject({
            status: "failed",
            recoveryHint: { reason: CENTRAL_COMPATIBILITY_REJECTION_REASONS.NODE_LOCKED },
        });
        await expect(replicator.replicateAllFromServerWithOutcome(setting, false)).resolves.toMatchObject({
            status: "failed",
            recoveryHint: { reason: CENTRAL_COMPATIBILITY_REJECTION_REASONS.NODE_LOCKED },
        });
        expect(localDatabase.replicate.to).toHaveBeenCalledOnce();
        expect(localDatabase.replicate.from).toHaveBeenCalledOnce();
    });

    it("blocks a coalesced caller without borrowing the initiating compatibility rejection", async () => {
        const replicator = new LiveSyncCouchDBReplicator({
            services: {
                API: { isMobile: () => false, addLog: Logger },
                context: createServiceContext(),
                database: { localDatabase: localDatabaseOwner({}) },
            },
        } as unknown as ConstructorParameters<typeof LiveSyncCouchDBReplicator>[0]);
        const ensurePBKDF2Salt = vi
            .spyOn(operations(replicator), "prepareSecuritySeed")
            .mockResolvedValue({ ready: true });
        let releaseAssessment!: () => void;
        const assessmentGate = new Promise<void>((resolve) => {
            releaseAssessment = resolve;
        });
        let assessmentStarted!: () => void;
        const assessmentStart = new Promise<void>((resolve) => {
            assessmentStarted = resolve;
        });
        const checkReplicationConnectivity = vi
            .spyOn(operations(replicator), "openReplicationConnection")
            .mockImplementation(async (...args) => {
                args[6]?.(centralCompatibilityRejected(CENTRAL_COMPATIBILITY_REJECTION_REASONS.NODE_LOCKED));
                assessmentStarted();
                await assessmentGate;
                return { status: "failed" };
            });
        const setting = { useRequestAPI: true } as RemoteDBSettings;

        const initiating = replicator.openOneShotReplicationWithOutcome(setting, false);
        await assessmentStart;
        const joining = replicator.openOneShotReplicationWithOutcome(setting, false);
        await Promise.resolve();
        releaseAssessment();

        await expect(Promise.all([initiating, joining])).resolves.toEqual([
            {
                status: "failed",
                error: expect.any(Error),
                recoveryHint: { reason: CENTRAL_COMPATIBILITY_REJECTION_REASONS.NODE_LOCKED },
            },
            {
                status: "blocked",
                reason: "replication-in-progress",
            },
        ]);
        expect(ensurePBKDF2Salt).toHaveBeenCalledOnce();
        expect(checkReplicationConnectivity).toHaveBeenCalledOnce();
    });

    it("leaves a shared retry continuation with the caller that initiated the attempt", async () => {
        const remoteDatabase = { close: vi.fn().mockResolvedValue(undefined) };
        const replicator = createOneShotReplicator(remoteDatabase);
        const ensurePBKDF2Salt = vi.mocked(operations(replicator).prepareSecuritySeed);
        let releaseInitialTransfer!: () => void;
        const initialTransferGate = new Promise<void>((resolve) => {
            releaseInitialTransfer = resolve;
        });
        let initialTransferStarted!: () => void;
        const initialTransferStart = new Promise<void>((resolve) => {
            initialTransferStarted = resolve;
        });
        vi.spyOn(operations(replicator), "runSyncTransfer")
            .mockImplementationOnce(async () => {
                initialTransferStarted();
                await initialTransferGate;
                return { action: "NEED_RETRY" };
            })
            .mockResolvedValueOnce({ action: "DONE" });
        const setting = { batch_size: 20, batches_limit: 20 } as RemoteDBSettings;

        const initiating = replicator.openOneShotReplicationWithOutcome(setting, false);
        await initialTransferStart;
        const joining = replicator.openOneShotReplicationWithOutcome(setting, false);
        await Promise.resolve();
        releaseInitialTransfer();

        await expect(Promise.all([initiating, joining])).resolves.toEqual([
            { status: "completed" },
            { status: "blocked", reason: "replication-in-progress" },
        ]);
        expect(ensurePBKDF2Salt).toHaveBeenCalledTimes(2);
        expect(operations(replicator).openReplicationConnection).toHaveBeenCalledTimes(2);
        expect(operations(replicator).runSyncTransfer).toHaveBeenCalledTimes(2);
    });

    it("does not expose an initiating exception to a coalesced caller", async () => {
        const replicator = createOneShotReplicator({ close: vi.fn().mockResolvedValue(undefined) });
        let releaseAssessment!: () => void;
        const assessmentGate = new Promise<void>((resolve) => {
            releaseAssessment = resolve;
        });
        let assessmentStarted!: () => void;
        const assessmentStart = new Promise<void>((resolve) => {
            assessmentStarted = resolve;
        });
        const initiatingError = new Error("initiating connection failed");
        vi.mocked(operations(replicator).openReplicationConnection).mockImplementation(async () => {
            assessmentStarted();
            await assessmentGate;
            throw initiatingError;
        });
        const setting = { useRequestAPI: true } as RemoteDBSettings;

        const initiating = replicator.openOneShotReplicationWithOutcome(setting, false);
        await assessmentStart;
        const joining = replicator.openOneShotReplicationWithOutcome(setting, false);
        await Promise.resolve();
        releaseAssessment();

        await expect(Promise.all([initiating, joining])).resolves.toEqual([
            { status: "failed", error: initiatingError },
            { status: "blocked", reason: "replication-in-progress" },
        ]);
        expect(operations(replicator).prepareSecuritySeed).toHaveBeenCalledOnce();
    });
});

describe("LiveSyncCouchDBReplicator preferred tweak writes", () => {
    const setting = {
        couchDB_URI: "https://example.invalid",
        couchDB_DBNAME: "remote",
    } as RemoteDBSettings;

    it("rejects a connection-string failure instead of resolving successfully", async () => {
        const replicator = new LiveSyncCouchDBReplicator({
            services: {
                API: { isMobile: () => false, addLog: Logger },
                context: createServiceContext(),
            },
        } as unknown as ConstructorParameters<typeof LiveSyncCouchDBReplicator>[0]);
        vi.spyOn(replicator, "connectRemoteCouchDBWithSetting").mockResolvedValue("connection failed" as never);

        await expect(replicator.setPreferredRemoteTweakSettings(setting)).rejects.toThrow("connection failed");
    });

    it("rejects an incompatible remote database instead of resolving successfully", async () => {
        const remoteDatabase = {
            get: vi.fn(async (id: string) => {
                if (id === VERSIONING_DOCID) {
                    return { _id: VERSIONING_DOCID, type: "versioninfo", version: VER + 1 };
                }
                throw new Error(`Unexpected document: ${id}`);
            }),
            put: vi.fn(),
            close: vi.fn().mockResolvedValue(undefined),
        };
        const { replicator } = createCouchReplicatorForPreferredWrite(remoteDatabase);

        await expect(replicator.setPreferredRemoteTweakSettings(setting)).rejects.toThrow(
            "remote database version is not compatible"
        );
        expect(remoteDatabase.put).not.toHaveBeenCalled();
    });

    it("waits for the durable milestone write before settling", async () => {
        let releasePut!: (value: unknown) => void;
        const put = vi.fn(
            () =>
                new Promise((resolve) => {
                    releasePut = resolve;
                })
        );
        const remoteDatabase = {
            get: vi.fn(async (id: string) => {
                if (id === VERSIONING_DOCID) {
                    return { _id: VERSIONING_DOCID, type: "versioninfo", version: VER };
                }
                if (id === MILESTONE_DOCID) {
                    return { _id: MILESTONE_DOCID, tweak_values: {} };
                }
                throw new Error(`Unexpected document: ${id}`);
            }),
            put,
            close: vi.fn().mockResolvedValue(undefined),
        };
        const { replicator } = createCouchReplicatorForPreferredWrite(remoteDatabase);
        let settled = false;

        const operation = replicator.setPreferredRemoteTweakSettings(setting).then(() => {
            settled = true;
        });
        await vi.waitFor(() => expect(put).toHaveBeenCalledOnce());
        expect(settled).toBe(false);

        releasePut({ ok: true });
        await expect(operation).resolves.toBeUndefined();
        expect(settled).toBe(true);
    });

    function createCouchReplicatorForPreferredWrite(remoteDatabase: Record<string, unknown>) {
        const env = {
            services: {
                API: { isMobile: () => false, addLog: Logger },
                context: createServiceContext(),
            },
        } as unknown as ConstructorParameters<typeof LiveSyncCouchDBReplicator>[0];
        const replicator = new LiveSyncCouchDBReplicator(env);
        vi.spyOn(replicator, "connectRemoteCouchDBWithSetting").mockResolvedValue({
            db: remoteDatabase,
            info: { db_name: "remote" },
            close: vi.fn().mockResolvedValue(undefined),
        } as never);
        return { replicator };
    }
});

describe("LiveSyncCouchDBReplicator remote administration settlement", () => {
    const setting = {
        couchDB_URI: "https://example.invalid",
        couchDB_DBNAME: "remote",
    } as RemoteDBSettings;

    function createReplicator() {
        return new LiveSyncCouchDBReplicator({
            services: {
                API: { isMobile: () => false, addLog: Logger },
                context: createServiceContext(),
            },
        } as unknown as ConstructorParameters<typeof LiveSyncCouchDBReplicator>[0]);
    }

    it("rejects a failed lock connection instead of reporting a settled mutation", async () => {
        const replicator = createReplicator();
        vi.spyOn(replicator, "connectRemoteCouchDBWithSetting").mockResolvedValue("connection failed" as never);

        await expect(replicator.markRemoteLocked(setting, true, false)).rejects.toThrow("connection failed");
    });

    it("rejects a failed reset connection instead of reporting a settled mutation", async () => {
        const replicator = createReplicator();
        let releaseClose!: () => void;
        const closeGate = new Promise<void>((resolve) => {
            releaseClose = resolve;
        });
        const close = vi.spyOn(replicator, "closeReplication").mockImplementation(async () => await closeGate);
        const connect = vi
            .spyOn(replicator, "connectRemoteCouchDBWithSetting")
            .mockResolvedValue("connection failed" as never);

        const operation = replicator.tryResetRemoteDatabase(setting);
        void operation.catch((): void => {});
        try {
            await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
            expect(connect).not.toHaveBeenCalled();

            releaseClose();
            await expect(operation).rejects.toThrow("connection failed");
        } finally {
            releaseClose();
            await Promise.allSettled([operation]);
        }
    });
});

describe("LiveSyncCouchDBReplicator connection settings", () => {
    it.each(["sync", "pullOnly", "pushOnly"] as const)(
        "refreshes the Seed before %s connectivity checks, including explicit reconstruction",
        async (syncMode) => {
            const replicator = createOneShotReplicator({ close: vi.fn().mockResolvedValue(undefined) });
            vi.spyOn(operations(replicator), "runSyncTransfer").mockResolvedValue({ action: "DONE" });
            const onFiniteReplicationCompleted = vi.fn().mockResolvedValue(true);
            Object.assign(replicator.env.services, { replication: { onFiniteReplicationCompleted } });
            const setting = { useRequestAPI: true, batch_size: 20, batches_limit: 20 } as RemoteDBSettings;

            await expect(replicator.openOneShotReplication(setting, false, false, syncMode)).resolves.toBe(true);

            expect(onFiniteReplicationCompleted).toHaveBeenCalledTimes(syncMode === "pushOnly" ? 0 : 1);

            expect(operations(replicator).prepareSecuritySeed).toHaveBeenCalledWith(setting, false, false);
            expect(vi.mocked(operations(replicator).prepareSecuritySeed).mock.invocationCallOrder[0]).toBeLessThan(
                vi.mocked(operations(replicator).openReplicationConnection).mock.invocationCallOrder[0]
            );
        }
    );

    it.each(["CANCELLED", "FAILED"] as const)("does not notify after a %s one-shot attempt", async (syncResult) => {
        const replicator = createOneShotReplicator({ close: vi.fn().mockResolvedValue(undefined) });
        const onFiniteReplicationCompleted = vi.fn().mockResolvedValue(true);
        Object.assign(replicator.env.services, { replication: { onFiniteReplicationCompleted } });
        vi.spyOn(operations(replicator), "runSyncTransfer").mockResolvedValue({ action: syncResult });

        await expect(
            replicator.openOneShotReplication({ useRequestAPI: true } as RemoteDBSettings, false, false, "sync")
        ).resolves.toBe(false);

        expect(onFiniteReplicationCompleted).not.toHaveBeenCalled();
    });

    it("settles an invalid connection setting through the asynchronous facet contract", async () => {
        const replicator = Object.create(LiveSyncCouchDBReplicator.prototype) as LiveSyncCouchDBReplicator;
        const connection = replicator.connectRemoteCouchDBWithSetting(
            {
                encrypt: true,
                passphrase: "",
                permitEmptyPassphrase: false,
            } as RemoteDBSettings,
            false
        );

        expect(connection).toBeInstanceOf(Promise);
        await expect(connection).resolves.toBe("Empty passphrases cannot be used without explicit permission");
    });

    it.each([undefined, false, true])(
        "projects the supplied setting's encryption and cache policy into the owned connection (%s)",
        async (headersOnly) => {
            const connect = vi.fn().mockResolvedValue("unused");
            const replicator = Object.create(LiveSyncCouchDBReplicator.prototype) as LiveSyncCouchDBReplicator;
            replicator.env = {
                services: {
                    remote: { connect },
                },
            } as unknown as LiveSyncCouchDBReplicator["env"];
            const setting = {
                couchDB_URI: "https://example.test",
                couchDB_DBNAME: "remote",
                couchDB_CustomHeaders: "",
                couchDB_USER: "user",
                couchDB_PASSWORD: "password",
                disableRequestURI: false,
                enableCompression: false,
                encrypt: false,
                E2EEAlgorithm: E2EEAlgorithms.ForceV1,
                passphrase: "",
                permitEmptyPassphrase: false,
                useDynamicIterationCount: false,
                useJWT: false,
                useRequestAPI: false,
                useCouchDBCacheControlHeadersOnly: headersOnly,
            } as RemoteDBSettings;

            await replicator.connectRemoteCouchDBWithSetting(setting, false, false, true, {
                allowNativeFallback: false,
                encryptionAlgorithm: E2EEAlgorithms.V2,
                useCouchDBCacheControlHeadersOnly: !headersOnly,
            });

            expect(connect.mock.calls[0][11]).toEqual({
                allowNativeFallback: false,
                encryptionAlgorithm: E2EEAlgorithms.ForceV1,
                encryptInternalMetadata: false,
                acceptUnencryptedContent: false,
                useCouchDBCacheControlHeadersOnly: headersOnly === true,
            });

            await replicator.connectRemoteCouchDBWithSetting(
                {
                    ...setting,
                    encrypt: true,
                    E2EEAlgorithm: E2EEAlgorithms.V2,
                    usePathObfuscation: true,
                    encryptInternalMetadata: true,
                    acceptUnencryptedContent: true,
                    passphrase: "secret",
                },
                false,
                false,
                true
            );

            expect(connect.mock.calls[1][11]).toMatchObject({
                encryptionAlgorithm: E2EEAlgorithms.V2,
                encryptInternalMetadata: true,
                acceptUnencryptedContent: true,
                useCouchDBCacheControlHeadersOnly: headersOnly === true,
            });
        }
    );
});

describe("LiveSyncCouchDBReplicator remote preferred tweak values", () => {
    const setting = {
        couchDB_URI: "https://example.invalid",
        couchDB_DBNAME: "remote",
    } as RemoteDBSettings;

    function createReplicator(get: ReturnType<typeof vi.fn>) {
        const env = {
            services: {
                API: {
                    addLog: Logger,
                    isMobile: () => false,
                },
            },
        } as unknown as ConstructorParameters<typeof LiveSyncCouchDBReplicator>[0];
        const replicator = new LiveSyncCouchDBReplicator(env);
        const connectionClose = vi.fn().mockResolvedValue(undefined);
        vi.spyOn(replicator, "connectRemoteCouchDBWithSetting").mockResolvedValue({
            db: { get },
            info: { db_name: "remote" },
            close: connectionClose,
        } as never);
        return { connectionClose, replicator };
    }

    function createRemoteGet(milestone: unknown | (() => never)) {
        return vi.fn(async (id: string) => {
            if (id === VERSIONING_DOCID) {
                return { _id: VERSIONING_DOCID, type: "versioninfo", version: VER };
            }
            if (id === MILESTONE_DOCID) {
                if (typeof milestone === "function") return milestone();
                return milestone;
            }
            throw new Error(`Unexpected document: ${id}`);
        });
    }

    it("distinguishes a remote database without a milestone from an unavailable remote", async () => {
        const missing = { status: 404, name: "not_found", message: "missing" };
        const { connectionClose, replicator } = createReplicator(
            createRemoteGet(() => {
                throw missing;
            })
        );

        await expect(replicator.getRemotePreferredTweakValues(setting)).resolves.toEqual({
            status: "not-configured",
            reason: "milestone-missing",
        });
        expect(connectionClose).toHaveBeenCalledOnce();
    });

    it("reports a remote read failure as unavailable", async () => {
        const failure = new Error("network failed");
        const { connectionClose, replicator } = createReplicator(
            createRemoteGet(() => {
                throw failure;
            })
        );

        await expect(replicator.getRemotePreferredTweakValues(setting)).resolves.toEqual({
            status: "unavailable",
            error: failure,
        });
        expect(connectionClose).toHaveBeenCalledOnce();
    });

    it("does not treat a missing remote database as an unconfigured milestone", async () => {
        const failure = { status: 404, name: "not_found", message: "Database does not exist" };
        const { connectionClose, replicator } = createReplicator(createRemoteGet({}));
        vi.mocked(replicator.connectRemoteCouchDBWithSetting).mockRejectedValueOnce(failure);

        await expect(replicator.getRemotePreferredTweakValues(setting)).resolves.toEqual({
            status: "unavailable",
            error: failure,
        });
        expect(connectionClose).not.toHaveBeenCalled();
    });

    it("distinguishes a milestone without preferred values", async () => {
        const { connectionClose, replicator } = createReplicator(
            createRemoteGet({
                _id: MILESTONE_DOCID,
                tweak_values: {},
            })
        );

        await expect(replicator.getRemotePreferredTweakValues(setting)).resolves.toEqual({
            status: "not-configured",
            reason: "preferred-values-missing",
        });
        expect(connectionClose).toHaveBeenCalledOnce();
    });

    it("returns available preferred values explicitly", async () => {
        const values = { encrypt: true };
        const { connectionClose, replicator } = createReplicator(
            createRemoteGet({
                _id: MILESTONE_DOCID,
                tweak_values: { [DEVICE_ID_PREFERRED]: values },
            })
        );

        await expect(replicator.getRemotePreferredTweakValues(setting)).resolves.toEqual({
            status: "available",
            values,
        });
        expect(connectionClose).toHaveBeenCalledOnce();
    });
});

function createContinuousTestReplicator(localDatabase: object, Replicator = LiveSyncCouchDBReplicator) {
    const runFiniteReplicationActivity = vi.fn(async <T>(task: () => Promise<T>) => await task());
    const replicator = Object.create(Replicator.prototype) as LiveSyncCouchDBReplicator;
    replicator.env = {
        services: {
            API: { addLog: Logger },
            context: createServiceContext(),
            database: { localDatabase: localDatabaseOwner(localDatabase) },
            replicator: { runFiniteReplicationActivity },
        },
    } as unknown as LiveSyncCouchDBReplicator["env"];
    replicator.docArrived = 0;
    replicator.docSent = 0;
    replicator.updateInfo = vi.fn();
    return { replicator, runFiniteReplicationActivity };
}

function replicationHandle() {
    const events = new EventEmitter();
    let resolveCompletion!: () => void;
    const completion = new Promise<void>((resolve) => {
        resolveCompletion = resolve;
    });
    let settled = false;
    return Object.assign(events, {
        then: completion.then.bind(completion),
        cancel: vi.fn(),
        settle(type: "complete" | "error", value: unknown = {}) {
            if (settled) return;
            settled = true;
            events.emit(type, value);
            resolveCompletion();
        },
    });
}

function continuousSettings(overrides: Partial<RemoteDBSettings> = {}): RemoteDBSettings {
    return {
        versionUpFlash: "",
        couchDB_URI: "https://example.test",
        couchDB_DBNAME: "remote",
        couchDB_CustomHeaders: "",
        useRequestAPI: true,
        encrypt: false,
        passphrase: "",
        pathNormalizationVersion: 0,
        readChunksOnline: false,
        useTimeouts: false,
        batch_size: 20,
        batches_limit: 20,
        ...overrides,
    } as RemoteDBSettings;
}

function connectContinuousTestReplicator(
    replicator: LiveSyncCouchDBReplicator,
    remoteDatabase: PouchDB.Database<EntryDoc>
) {
    Object.assign(replicator.env.services.API, {
        isMobile: () => false,
        getAppVersion: () => "test",
        getPluginVersion: () => "test",
        getPlatform: () => "test",
    });
    const closeConnections: Array<() => Promise<void>> = [];
    const openCouchDBConnection = vi.fn(async (): Promise<unknown> => {
        const close = vi.fn().mockResolvedValue(undefined);
        closeConnections.push(close);
        return { db: remoteDatabase, info: await remoteDatabase.info(), close };
    });
    Object.assign(replicator.env.services, {
        remote: { hadLastPostFailedBySize: false, openCouchDBConnection },
        vault: { vaultName: () => "test-vault", getVaultName: () => "test-device" },
    });
    replicator.nodeid = "continuous-test";
    const getSalt = vi.spyOn(replicator, "getReplicationPBKDF2Salt").mockResolvedValue(new Uint8Array([1]));
    return { openCouchDBConnection, closeConnections, getSalt };
}

function stubContinuousRemoteCompatibility() {
    const versionCheck = vi.spyOn(negotiation, "checkRemoteVersion").mockResolvedValue(true);
    const compatibilityCheck = vi.spyOn(compatibility, "ensureDatabaseIsCompatible").mockResolvedValue("OK");
    return () => {
        compatibilityCheck.mockRestore();
        versionCheck.mockRestore();
    };
}

describe("LiveSyncCouchDBReplicator continuous catch-up", () => {
    it("settles joined starts at live handle handoff before the transfer ends", async () => {
        const catchUpHandle = replicationHandle();
        const liveHandle = replicationHandle();
        const localDatabase = {
            get: vi.fn().mockRejectedValue({ status: 404, name: "not_found" }),
            info: vi.fn().mockResolvedValue({ update_seq: 7 }),
            replicate: { from: vi.fn(() => catchUpHandle) },
            sync: vi.fn(() => liveHandle),
        };
        const remoteDatabase = new PouchDB<EntryDoc>(crypto.randomUUID(), { adapter: "memory" });
        const { replicator } = createContinuousTestReplicator(localDatabase);
        const remote = connectContinuousTestReplicator(replicator, remoteDatabase);
        const restoreCompatibility = stubContinuousRemoteCompatibility();
        const first = vi.fn();
        const joined = vi.fn();
        const late = vi.fn();
        const setting = continuousSettings();
        const firstTask = replicator.openContinuousReplication(setting, false, false, first);
        const joinedTask = replicator.openContinuousReplication(setting, false, false, joined);

        try {
            await vi.waitFor(() => expect(catchUpHandle.listenerCount("complete")).toBeGreaterThan(0));
            expect(first).not.toHaveBeenCalled();
            expect(joined).not.toHaveBeenCalled();
            catchUpHandle.settle("complete");
            await vi.waitFor(() => expect(localDatabase.sync).toHaveBeenCalledOnce());
            await vi.waitFor(() => expect(first).toHaveBeenCalledExactlyOnceWith({ status: "started" }));
            await vi.waitFor(() => expect(joined).toHaveBeenCalledExactlyOnceWith({ status: "started" }));
            const lateTask = replicator.openContinuousReplication(setting, false, false, late);
            expect(joinedTask).toBe(firstTask);
            expect(lateTask).toBe(firstTask);
            await vi.waitFor(() => expect(late).toHaveBeenCalledExactlyOnceWith({ status: "started" }));
            expect(localDatabase.replicate.from).toHaveBeenCalledExactlyOnceWith(
                remoteDatabase,
                expect.objectContaining({ batch_size: 20 })
            );
            expect(localDatabase.sync).toHaveBeenCalledExactlyOnceWith(
                remoteDatabase,
                expect.objectContaining({ live: true, retry: true })
            );
            expect(remote.openCouchDBConnection).toHaveBeenCalledTimes(2);
            liveHandle.settle("complete");
            await expect(firstTask).resolves.toBe(true);
        } finally {
            catchUpHandle.settle("complete");
            liveHandle.settle("complete");
            await Promise.allSettled([firstTask]);
            restoreCompatibility();
            await remoteDatabase.destroy();
        }
    });

    it("settles a competing instance without waiting for the owner or taking its start result", async () => {
        const ownerHandle = replicationHandle();
        const ownerDatabase = {
            get: vi.fn().mockRejectedValue({ status: 404, name: "not_found" }),
            info: vi.fn().mockResolvedValue({ update_seq: 7 }),
            replicate: { from: vi.fn(() => ownerHandle) },
            sync: vi.fn(),
        };
        const competitorDatabase = {
            get: vi.fn().mockRejectedValue({ status: 404, name: "not_found" }),
            info: vi.fn().mockResolvedValue({ update_seq: 7 }),
            replicate: { from: vi.fn(() => replicationHandle()) },
            sync: vi.fn(),
        };
        const ownerRemoteDatabase = new PouchDB<EntryDoc>(crypto.randomUUID(), { adapter: "memory" });
        const competitorRemoteDatabase = new PouchDB<EntryDoc>(crypto.randomUUID(), { adapter: "memory" });
        const { replicator: owner } = createContinuousTestReplicator(ownerDatabase);
        const { replicator: competitor } = createContinuousTestReplicator(competitorDatabase);
        const ownerRemote = connectContinuousTestReplicator(owner, ownerRemoteDatabase);
        const competitorRemote = connectContinuousTestReplicator(competitor, competitorRemoteDatabase);
        const restoreCompatibility = stubContinuousRemoteCompatibility();
        const ownerSettled = vi.fn();
        const settings = continuousSettings();
        const running = owner.openContinuousReplication(settings, false, false, ownerSettled);

        try {
            await vi.waitFor(() => expect(ownerHandle.listenerCount("error")).toBeGreaterThan(0));
            const competingStart = promiseWithResolvers<void>();
            const onStartSettled = vi.fn(() => competingStart.resolve());
            const competingTask = competitor.openContinuousReplication(settings, false, false, onStartSettled);
            const taskSettled = vi.fn();
            void competingTask.then(taskSettled);
            await competingStart.promise;

            expect(onStartSettled).toHaveBeenCalledExactlyOnceWith({ status: "failed" });
            expect(taskSettled).toHaveBeenCalledExactlyOnceWith(false);
            expect(competitorDatabase.replicate.from).not.toHaveBeenCalled();
            expect(competitorRemote.openCouchDBConnection).not.toHaveBeenCalled();
            expect(ownerRemote.openCouchDBConnection).toHaveBeenCalledOnce();
            expect(ownerSettled).not.toHaveBeenCalled();
        } finally {
            ownerHandle.settle("error", new Error("Release the owner catch-up fixture"));
            await Promise.allSettled([running]);
            restoreCompatibility();
            await Promise.all([ownerRemoteDatabase.destroy(), competitorRemoteDatabase.destroy()]);
        }
    });

    it.each([
        "openOneShotReplication",
        "ensurePBKDF2Salt",
        "checkReplicationConnectivity",
        "connectRemoteCouchDBWithSetting",
        "processSync",
    ] as const)("honours the %s hook during catch-up", async (hook) => {
        const localDatabase = {
            get: vi.fn().mockRejectedValue({ status: 404, name: "not_found" }),
            info: vi.fn().mockResolvedValue({ update_seq: 0 }),
            replicate: { from: vi.fn(() => replicationHandle()) },
            sync: vi.fn(),
        };
        const remoteDatabase = new PouchDB<EntryDoc>(crypto.randomUUID(), { adapter: "memory" });
        const { replicator } = createContinuousTestReplicator(localDatabase);
        connectContinuousTestReplicator(replicator, remoteDatabase);
        const restoreCompatibility = stubContinuousRemoteCompatibility();
        const baseTransfer = vi
            .spyOn(operations(replicator), "runSyncTransfer")
            .mockResolvedValue({ action: "FAILED" });
        const veto = vi.fn(async () => false);
        const override =
            hook === "connectRemoteCouchDBWithSetting"
                ? vi.fn(async () => "Host rejected the connection")
                : hook === "processSync"
                  ? vi.fn(async () => "FAILED" as const)
                  : veto;
        Object.assign(replicator, { [hook]: override });
        const onStartSettled = vi.fn();

        try {
            await expect(
                replicator.openContinuousReplication(continuousSettings(), false, false, onStartSettled)
            ).resolves.toBe(false);

            expect(override).toHaveBeenCalledOnce();
            expect(onStartSettled).toHaveBeenCalledExactlyOnceWith({ status: "failed" });
            expect(baseTransfer).not.toHaveBeenCalled();
            expect(localDatabase.sync).not.toHaveBeenCalled();
        } finally {
            restoreCompatibility();
            await remoteDatabase.destroy();
        }
    });

    it("honours the legacy opening hook when a continuous start reports its result", async () => {
        const { replicator } = createContinuousTestReplicator({});
        replicator.nodeid = "continuous-test";
        const start = vi.spyOn(replicator, "openContinuousReplication").mockResolvedValue(false);
        const override = vi.spyOn(replicator, "openReplication").mockResolvedValue(false);
        const onStartSettled = vi.fn();
        const settings = continuousSettings();

        await expect(replicator.startContinuousReplication(settings, onStartSettled)).resolves.toBe(false);
        expect(override).toHaveBeenCalledExactlyOnceWith(settings, true, false, false);
        expect(start).not.toHaveBeenCalled();
    });

    it.each(["started", "failed", "cancelled"] as const)(
        "observes the actual continuous startup through a delegating openReplication override (%s)",
        async (status) => {
            class DelegatingReplicator extends LiveSyncCouchDBReplicator {
                override async openReplication(...args: Parameters<LiveSyncCouchDBReplicator["openReplication"]>) {
                    await Promise.resolve();
                    return await super.openReplication(...args);
                }
            }
            const catchUpHandle = replicationHandle();
            const liveHandle = replicationHandle();
            const localDatabase = {
                get: vi.fn().mockRejectedValue({ status: 404, name: "not_found" }),
                info: vi.fn().mockResolvedValue({ update_seq: 0 }),
                replicate: { from: vi.fn(() => catchUpHandle) },
                sync: vi.fn(() => liveHandle),
            };
            const remoteDatabase = new PouchDB<EntryDoc>(crypto.randomUUID(), { adapter: "memory" });
            const { replicator } = createContinuousTestReplicator(localDatabase, DelegatingReplicator);
            connectContinuousTestReplicator(replicator, remoteDatabase);
            const restoreCompatibility = stubContinuousRemoteCompatibility();
            const onStartSettled = vi.fn();

            try {
                await expect(
                    replicator.startContinuousReplication(continuousSettings(), onStartSettled)
                ).resolves.toBeUndefined();
                await vi.waitFor(() => expect(catchUpHandle.listenerCount("complete")).toBeGreaterThan(0));
                expect(onStartSettled).not.toHaveBeenCalled();

                if (status === "cancelled") {
                    const stopped = replicator.terminateSync();
                    await vi.waitFor(() => expect(onStartSettled).toHaveBeenCalledExactlyOnceWith({ status }));
                    catchUpHandle.settle("complete");
                    await stopped;
                } else {
                    catchUpHandle.settle(status === "started" ? "complete" : "error");
                    await vi.waitFor(() => expect(onStartSettled).toHaveBeenCalledExactlyOnceWith({ status }));
                }
                expect(localDatabase.replicate.from).toHaveBeenCalledOnce();
                expect(localDatabase.sync).toHaveBeenCalledTimes(status === "started" ? 1 : 0);
            } finally {
                catchUpHandle.settle("complete");
                liveHandle.settle("complete");
                await replicator.terminateSync();
                restoreCompatibility();
                await remoteDatabase.destroy();
            }
        }
    );

    it("reports a reset during the HTTP 200 response body of the initial pull", async () => {
        const localDatabase = new HttpPouchDB<EntryDoc>(crypto.randomUUID(), { adapter: "memory" });
        const { replicator } = createContinuousTestReplicator(localDatabase);
        connectContinuousTestReplicator(replicator, localDatabase);
        const changesBodyRead = vi.fn();
        const fetch = vi.fn(async (request: string | Request) => {
            const { pathname } = new URL(typeof request === "string" ? request : request.url);
            if (pathname.endsWith("/_changes")) {
                const body = new ReadableStream<Uint8Array>({
                    start(controller) {
                        controller.enqueue(new TextEncoder().encode('{"results":['));
                    },
                    pull(controller) {
                        changesBodyRead();
                        controller.error(
                            new TypeError("terminated", {
                                cause: Object.assign(new Error("connection reset"), { code: "ECONNRESET" }),
                            })
                        );
                    },
                });
                return new Response(body, { status: 200 });
            }
            if (pathname === "/") {
                return Response.json({ uuid: "test-server" });
            }
            if (pathname === "/remote" || pathname === "/remote/") {
                return Response.json({ db_name: "remote", doc_count: 0, update_seq: 0 });
            }
            return Response.json({ error: "not_found", reason: "missing" }, { status: 404 });
        });
        const remote = new (class extends RemoteService {})(replicator.env.services.context, {
            pouchDB: HttpPouchDB,
            APIService: {
                isOnline: true,
                requestCount: reactiveSource(0),
                responseCount: reactiveSource(0),
                nativeFetch: fetch,
                webCompatFetch: fetch,
                addLog: Logger,
            },
            appLifecycle: { getUnresolvedMessages: { addHandler: vi.fn() } },
            setting: { currentSettings: () => ({ E2EEAlgorithm: E2EEAlgorithms.V2 }) },
        } as unknown as RemoteServiceDependencies);
        Object.assign(replicator.env.services, { remote });
        const restoreCompatibility = stubContinuousRemoteCompatibility();
        const onStartSettled = vi.fn();

        try {
            await expect(
                replicator.openContinuousReplication(continuousSettings(), false, false, onStartSettled)
            ).resolves.toBe(false);

            expect(changesBodyRead).toHaveBeenCalledOnce();
            expect(onStartSettled).toHaveBeenCalledExactlyOnceWith({
                status: "failed",
                networkFailure: {
                    reason: "remote-transport",
                    hostOnlineAtFailure: true,
                    failedAt: expect.any(Number),
                },
            });
        } finally {
            restoreCompatibility();
            await localDatabase.destroy();
        }
    });

    it("reports an attributed terminal catch-up failure and releases the task before notification", async () => {
        const handle = replicationHandle();
        const failure = captureRemoteTransportFailure(
            new TypeError("fetch failed", { cause: Object.assign(new Error("reset"), { code: "ECONNRESET" }) }),
            new AbortController().signal,
            () => true
        );
        assert(failure instanceof Error);
        const localDatabase = {
            get: vi.fn().mockRejectedValue({ status: 404, name: "not_found" }),
            info: vi.fn().mockResolvedValue({ update_seq: 7 }),
            replicate: {
                from: vi.fn(() => handle),
            },
            sync: vi.fn(),
        };
        const remoteDatabase = new PouchDB<EntryDoc>(crypto.randomUUID(), { adapter: "memory" });
        const { replicator } = createContinuousTestReplicator(localDatabase);
        const remote = connectContinuousTestReplicator(replicator, remoteDatabase);
        const restoreCompatibility = stubContinuousRemoteCompatibility();
        const close = vi.fn().mockResolvedValue(undefined);
        remote.openCouchDBConnection
            .mockImplementationOnce(async () => ({ db: remoteDatabase, info: await remoteDatabase.info(), close }))
            .mockResolvedValueOnce({ error: new Error("the retry cannot reach the remote") });
        const setting = continuousSettings();
        let retry: Promise<boolean> | undefined;
        const retryReport = vi.fn();
        const report = vi.fn(() => {
            retry = replicator.openContinuousReplication(setting, false, false, retryReport);
        });
        const startup = replicator.openContinuousReplication(setting, false, false, report);

        try {
            await vi.waitFor(() => expect(handle.listenerCount("error")).toBeGreaterThan(0));
            handle.settle("error", createError(failure));
            await expect(startup).resolves.toBe(false);
            expect(report).toHaveBeenCalledExactlyOnceWith({
                status: "failed",
                networkFailure: {
                    reason: "remote-transport",
                    hostOnlineAtFailure: true,
                    failedAt: expect.any(Number),
                },
            });
            expect(retry).not.toBe(startup);
            await expect(retry).resolves.toBe(false);
            expect(retryReport).toHaveBeenCalledExactlyOnceWith({ status: "failed" });
            expect(localDatabase.replicate.from).toHaveBeenCalledOnce();
            expect(localDatabase.sync).not.toHaveBeenCalled();
            expect(remote.openCouchDBConnection).toHaveBeenCalledTimes(2);
            expect(remote.getSalt).toHaveBeenCalledTimes(2);
            expect(close).toHaveBeenCalledOnce();
        } finally {
            handle.settle("error", createError(failure));
            await Promise.allSettled([startup]);
            if (retry) await Promise.allSettled([retry]);
            restoreCompatibility();
            await remoteDatabase.destroy();
        }
    });

    it("settles a failed live opening after successful finite catch-up", async () => {
        const catchUpHandle = replicationHandle();
        const localDatabase = {
            get: vi.fn().mockRejectedValue({ status: 404, name: "not_found" }),
            info: vi.fn().mockResolvedValue({ update_seq: 7 }),
            replicate: { from: vi.fn(() => catchUpHandle) },
            sync: vi.fn(),
        };
        const remoteDatabase = new PouchDB<EntryDoc>(crypto.randomUUID(), { adapter: "memory" });
        const { replicator } = createContinuousTestReplicator(localDatabase);
        const remote = connectContinuousTestReplicator(replicator, remoteDatabase);
        const restoreCompatibility = stubContinuousRemoteCompatibility();
        const failureError = captureRemoteTransportFailure(
            new TypeError("live connection failed", {
                cause: Object.assign(new Error("connection reset"), { code: "ECONNRESET" }),
            }),
            new AbortController().signal,
            () => true
        );
        assert(failureError instanceof Error);
        const failure = getReplicationNetworkFailure(failureError);
        assert(failure);
        const connectionClose = vi.fn().mockResolvedValue(undefined);
        remote.openCouchDBConnection
            .mockImplementationOnce(async () => ({
                db: remoteDatabase,
                info: await remoteDatabase.info(),
                close: connectionClose,
            }))
            .mockResolvedValueOnce({ error: failureError });
        const onStartSettled = vi.fn();
        const task = replicator.openContinuousReplication(continuousSettings(), false, false, onStartSettled);

        try {
            await vi.waitFor(() => expect(catchUpHandle.listenerCount("complete")).toBeGreaterThan(0));
            catchUpHandle.settle("complete");
            await expect(task).resolves.toBe(false);
            expect(localDatabase.replicate.from).toHaveBeenCalledOnce();
            expect(localDatabase.sync).not.toHaveBeenCalled();
            expect(remote.openCouchDBConnection).toHaveBeenCalledTimes(2);
            expect(remote.getSalt).toHaveBeenCalledOnce();
            expect(connectionClose).toHaveBeenCalledOnce();
            expect(onStartSettled).toHaveBeenCalledExactlyOnceWith({ status: "failed", networkFailure: failure });
        } finally {
            catchUpHandle.settle("complete");
            await Promise.allSettled([task]);
            restoreCompatibility();
            await remoteDatabase.destroy();
        }
    });

    it("does not start a connection after continuous replication is stopped before its live controller exists", async () => {
        let markCatchUpStarted!: () => void;
        const catchUpStarted = new Promise<void>((resolve) => {
            markCatchUpStarted = resolve;
        });
        let releaseCatchUp!: () => void;
        const catchUpGate = new Promise<void>((resolve) => {
            releaseCatchUp = resolve;
        });
        const replicator = Object.create(LiveSyncCouchDBReplicator.prototype) as LiveSyncCouchDBReplicator;
        replicator.updateInfo = vi.fn();
        replicator.env = {
            services: {
                API: { addLog: Logger },
                context: createServiceContext(),
                database: {
                    localDatabase: {
                        localDatabase: {},
                    },
                },
                replicator: {
                    runFiniteReplicationActivity: vi.fn(async <T>(task: () => Promise<T>) => await task()),
                },
            },
        } as unknown as LiveSyncCouchDBReplicator["env"];
        // Hold the catch-up boundary so stop can be issued before any controller exists.
        vi.spyOn(operations(replicator), "runOneShotReplication").mockImplementation(async () => {
            markCatchUpStarted();
            await catchUpGate;
            return true;
        });
        const connect = vi
            .spyOn(operations(replicator), "openReplicationConnection")
            .mockResolvedValue({ status: "failed" });

        const onStartSettled = vi.fn();
        const operation = replicator.openContinuousReplication({} as RemoteDBSettings, false, false, onStartSettled);
        await catchUpStarted;
        expect(replicator.controller).toBeUndefined();

        const stop = Promise.resolve(replicator.terminateSync());
        const close = Promise.resolve(replicator.closeReplication());
        await Promise.resolve();
        expect(onStartSettled).toHaveBeenCalledExactlyOnceWith({ status: "cancelled" });
        releaseCatchUp();

        await expect(Promise.all([operation, stop, close])).resolves.toEqual([false, undefined, undefined]);
        expect(connect).not.toHaveBeenCalled();
        expect(onStartSettled).toHaveBeenCalledExactlyOnceWith({ status: "cancelled" });
    });

    it("does not let a stopped continuous catch-up connect after seed preparation resumes", async () => {
        let markSeedPreparationStarted!: () => void;
        const seedPreparationStarted = new Promise<void>((resolve) => {
            markSeedPreparationStarted = resolve;
        });
        let releaseSeedPreparation!: () => void;
        const seedPreparationGate = new Promise<void>((resolve) => {
            releaseSeedPreparation = resolve;
        });
        const replicator = Object.create(LiveSyncCouchDBReplicator.prototype) as LiveSyncCouchDBReplicator;
        replicator.updateInfo = vi.fn();
        replicator.env = {
            services: {
                API: { addLog: Logger },
                context: createServiceContext(),
                database: { localDatabase: localDatabaseOwner({}) },
                replicator: {
                    runFiniteReplicationActivity: vi.fn(async <T>(task: () => Promise<T>) => await task()),
                },
            },
        } as unknown as LiveSyncCouchDBReplicator["env"];
        // Hold seed preparation to verify cancellation prevents the next connection step.
        vi.spyOn(operations(replicator), "prepareSecuritySeed").mockImplementation(async () => {
            markSeedPreparationStarted();
            await seedPreparationGate;
            return { ready: true };
        });
        const connect = vi
            .spyOn(operations(replicator), "openReplicationConnection")
            .mockResolvedValue({ status: "failed" });

        const continuous = replicator.openContinuousReplication(
            { useRequestAPI: true } as RemoteDBSettings,
            false,
            false
        );
        await seedPreparationStarted;
        const stop = replicator.terminateSync();
        releaseSeedPreparation();

        await expect(Promise.all([continuous, stop])).resolves.toEqual([false, undefined]);
        expect(connect).not.toHaveBeenCalled();
    });

    it("keeps repeated pre-controller stop requests pending on the same continuous task", async () => {
        let markCatchUpStarted!: () => void;
        const catchUpStarted = new Promise<void>((resolve) => {
            markCatchUpStarted = resolve;
        });
        let releaseCatchUp!: () => void;
        const catchUpGate = new Promise<void>((resolve) => {
            releaseCatchUp = resolve;
        });
        const replicator = Object.create(LiveSyncCouchDBReplicator.prototype) as LiveSyncCouchDBReplicator;
        replicator.updateInfo = vi.fn();
        replicator.env = {
            services: {
                API: { addLog: Logger },
                context: createServiceContext(),
                database: { localDatabase: localDatabaseOwner({}) },
                replicator: {
                    runFiniteReplicationActivity: vi.fn(async <T>(task: () => Promise<T>) => await task()),
                },
            },
        } as unknown as LiveSyncCouchDBReplicator["env"];
        // Keep the catch-up pending while repeated stops share the same task settlement.
        vi.spyOn(operations(replicator), "runOneShotReplication").mockImplementation(async () => {
            markCatchUpStarted();
            await catchUpGate;
            return true;
        });
        const connect = vi
            .spyOn(operations(replicator), "openReplicationConnection")
            .mockResolvedValue({ status: "failed" });

        const continuous = replicator.openContinuousReplication({} as RemoteDBSettings, false, false);
        await catchUpStarted;
        let stopsSettled = false;
        const stops = Promise.all([
            Promise.resolve(replicator.terminateSync()),
            Promise.resolve(replicator.terminateSync()),
        ]).then(() => {
            stopsSettled = true;
        });

        try {
            for (let turn = 0; turn < 5; turn++) await Promise.resolve();
            expect(stopsSettled).toBe(false);
        } finally {
            releaseCatchUp();
            await Promise.allSettled([continuous, stops]);
        }
        expect(connect).not.toHaveBeenCalled();
    });

    it("closes a live connection acquired after Stop was requested", async () => {
        const localDatabase = {
            info: vi.fn().mockResolvedValue({ update_seq: 7 }),
            sync: vi.fn(() => ({})),
        };
        const remoteDatabase = { close: vi.fn().mockResolvedValue(undefined) };
        const { replicator } = createContinuousTestReplicator(localDatabase);
        // Gate connection acquisition so Stop lands after the request but before the handle returns.
        vi.spyOn(operations(replicator), "runOneShotReplication").mockResolvedValue(true);
        const connectivityStarted = promiseWithResolvers<void>();
        const releaseConnectivity = promiseWithResolvers<void>();
        vi.spyOn(operations(replicator), "openReplicationConnection").mockImplementation(async () => {
            connectivityStarted.resolve();
            await releaseConnectivity.promise;
            return {
                db: remoteDatabase,
                info: { update_seq: 9 },
                close: () => remoteDatabase.close(),
                syncOption: {},
            } as never;
        });

        const continuous = replicator.openContinuousReplication({} as RemoteDBSettings, false, false);
        await connectivityStarted.promise;
        const stop = replicator.terminateSync();
        releaseConnectivity.resolve();

        await expect(Promise.all([continuous, stop])).resolves.toEqual([false, undefined]);
        expect(remoteDatabase.close).toHaveBeenCalledOnce();
        expect(localDatabase.info).not.toHaveBeenCalled();
        expect(localDatabase.sync).not.toHaveBeenCalled();
    });

    it("does not start a retry continuation after Stop settles a live transfer", async () => {
        const localDatabase = {
            info: vi.fn().mockResolvedValue({ update_seq: 7 }),
            sync: vi.fn(() => ({})),
        };
        const remoteDatabase = { close: vi.fn().mockResolvedValue(undefined) };
        const { replicator } = createContinuousTestReplicator(localDatabase);
        // Stub only the transfer result to make the retry-continuation ordering deterministic.
        const catchUp = vi.spyOn(operations(replicator), "runOneShotReplication").mockResolvedValue(true);
        vi.spyOn(operations(replicator), "openReplicationConnection").mockResolvedValue({
            db: remoteDatabase,
            info: { update_seq: 9 },
            close: () => remoteDatabase.close(),
            syncOption: {},
        } as never);
        const transferStarted = promiseWithResolvers<void>();
        const releaseTransfer = promiseWithResolvers<void>();
        vi.spyOn(replicator, "processSync").mockImplementation(async () => {
            transferStarted.resolve();
            await releaseTransfer.promise;
            return "NEED_RETRY";
        });

        const continuous = replicator.openContinuousReplication(
            { batch_size: 20, batches_limit: 20 } as RemoteDBSettings,
            false,
            false
        );
        await transferStarted.promise;
        const stop = replicator.terminateSync();
        releaseTransfer.resolve();

        await expect(Promise.all([continuous, stop])).resolves.toEqual([false, undefined]);
        expect(catchUp).toHaveBeenCalledOnce();
        expect(remoteDatabase.close).toHaveBeenCalledOnce();
    });

    it("exposes the initial pull-only catch-up as finite replication activity", async () => {
        const runFiniteReplicationActivity = vi.fn(async <T>(task: () => Promise<T>) => await task());
        const replicator = Object.create(LiveSyncCouchDBReplicator.prototype) as LiveSyncCouchDBReplicator;
        replicator.updateInfo = vi.fn();
        replicator.env = {
            services: {
                API: { addLog: Logger },
                context: createServiceContext(),
                database: {
                    localDatabase: {
                        localDatabase: {},
                    },
                },
                replicator: {
                    runFiniteReplicationActivity,
                },
            },
        } as unknown as LiveSyncCouchDBReplicator["env"];
        // Stub the catch-up result to isolate the finite-activity service boundary.
        const catchUp = vi
            .spyOn(operations(replicator), "runOneShotReplication")
            .mockResolvedValue({ status: "failed" });
        const setting = {} as RemoteDBSettings;

        await expect(replicator.openContinuousReplication(setting, false, false)).resolves.toBe(false);

        expect(runFiniteReplicationActivity).toHaveBeenCalledOnce();
        expect(runFiniteReplicationActivity).toHaveBeenCalledWith(expect.any(Function), { label: "replication" });
        expect(catchUp).toHaveBeenCalledWith(setting, false, false, "pullOnly", false, undefined, expect.any(Function));
    });

    it("starts another finite catch-up when the live channel retries with smaller batches", async () => {
        const events: string[] = [];
        const runFiniteReplicationActivity = vi.fn(async <T>(task: () => Promise<T>) => await task());
        const remoteDatabase = {
            close: vi.fn(async () => {
                events.push("closed");
            }),
        };
        const localDatabase = {
            info: vi.fn().mockResolvedValue({ update_seq: 7 }),
            sync: vi.fn(() => ({})),
        };
        const replicator = Object.create(LiveSyncCouchDBReplicator.prototype) as LiveSyncCouchDBReplicator;
        replicator.updateInfo = vi.fn();
        replicator.env = {
            services: {
                API: { addLog: Logger },
                context: createServiceContext(),
                database: {
                    localDatabase: localDatabaseOwner(localDatabase),
                },
                replicator: { runFiniteReplicationActivity },
            },
        } as unknown as LiveSyncCouchDBReplicator["env"];
        replicator.docArrived = 0;
        replicator.docSent = 0;
        replicator.updateInfo = vi.fn();
        replicator.terminateSync = vi.fn();
        // Script the two private catch-up results to assert live retry sequencing and close order.
        const catchUp = vi
            .spyOn(operations(replicator), "runOneShotReplication")
            .mockResolvedValueOnce(true)
            .mockImplementationOnce(async () => {
                events.push("restarted");
                return { status: "failed" };
            });
        const connectivity = vi.spyOn(operations(replicator), "openReplicationConnection").mockResolvedValue({
            db: remoteDatabase,
            info: { update_seq: 9 },
            close: () => remoteDatabase.close(),
            syncOption: {},
        } as never);
        vi.spyOn(replicator, "processSync").mockResolvedValue("NEED_RETRY");
        const setting = {
            batch_size: 20,
            batches_limit: 20,
        } as RemoteDBSettings;

        await expect(replicator.openContinuousReplication(setting, false, false)).resolves.toBe(false);

        expect(runFiniteReplicationActivity).toHaveBeenCalledTimes(2);
        expect(connectivity).toHaveBeenCalledWith(setting, true, false, false);
        expect(catchUp).toHaveBeenNthCalledWith(
            1,
            setting,
            false,
            false,
            "pullOnly",
            false,
            undefined,
            expect.any(Function)
        );
        expect(catchUp).toHaveBeenNthCalledWith(
            2,
            expect.objectContaining({ batch_size: 12, batches_limit: 12 }),
            false,
            false,
            "pullOnly",
            false,
            undefined,
            expect.any(Function)
        );
        expect(events).toEqual(["closed", "restarted"]);
    });

    it("closes the live remote database when continuous replication settles", async () => {
        const remoteDatabase = { close: vi.fn().mockResolvedValue(undefined) };
        const localDatabase = {
            info: vi.fn().mockResolvedValue({ update_seq: 7 }),
            sync: vi.fn(() => ({})),
        };
        const replicator = Object.create(LiveSyncCouchDBReplicator.prototype) as LiveSyncCouchDBReplicator;
        replicator.updateInfo = vi.fn();
        replicator.env = {
            services: {
                API: { addLog: Logger },
                context: createServiceContext(),
                database: { localDatabase: localDatabaseOwner(localDatabase) },
                replicator: {
                    runFiniteReplicationActivity: vi.fn(async <T>(task: () => Promise<T>) => await task()),
                },
            },
        } as unknown as LiveSyncCouchDBReplicator["env"];
        replicator.docArrived = 0;
        replicator.docSent = 0;
        replicator.updateInfo = vi.fn();
        replicator.terminateSync = vi.fn();
        vi.spyOn(operations(replicator), "runOneShotReplication").mockResolvedValue(true);
        vi.spyOn(operations(replicator), "openReplicationConnection").mockResolvedValue({
            db: remoteDatabase,
            info: { update_seq: 9 },
            close: () => remoteDatabase.close(),
            syncOption: {},
        } as never);
        vi.spyOn(replicator, "processSync").mockResolvedValue("DONE");

        await expect(replicator.openContinuousReplication({} as RemoteDBSettings, false, false)).resolves.toBe(true);

        expect(remoteDatabase.close).toHaveBeenCalledOnce();
    });
});

function localDatabaseOwner<T>(localDatabase: T) {
    return {
        localDatabase,
        readFromDatabase: <R>(read: (pouch: T) => Promise<R>) => read(localDatabase),
    };
}

function createOneShotReplicator(remoteDatabase: { close: () => Promise<void> }) {
    if (!("get" in remoteDatabase)) {
        Object.assign(remoteDatabase, { get: vi.fn().mockRejectedValue({ status: 404, name: "not_found" }) });
    }
    const localDatabase = {
        get: vi.fn().mockRejectedValue({ status: 404, name: "not_found" }),
        info: vi.fn().mockResolvedValue({ update_seq: 7 }),
        sync: vi.fn(() => ({})),
        replicate: {
            from: vi.fn(() => ({})),
            to: vi.fn(() => ({})),
        },
    };
    const replicator = Object.create(LiveSyncCouchDBReplicator.prototype) as LiveSyncCouchDBReplicator;
    replicator.env = {
        services: {
            API: { addLog: Logger },
            context: createServiceContext(),
            database: { localDatabase: localDatabaseOwner(localDatabase) },
        },
    } as unknown as LiveSyncCouchDBReplicator["env"];
    replicator.docArrived = 0;
    replicator.docSent = 0;
    replicator.updateInfo = vi.fn();
    replicator.terminateSync = vi.fn();
    vi.spyOn(operations(replicator), "prepareSecuritySeed").mockResolvedValue({ ready: true });
    vi.spyOn(operations(replicator), "openReplicationConnection").mockResolvedValue({
        db: remoteDatabase,
        info: { update_seq: 9 },
        close: () => remoteDatabase.close(),
        syncOptionBase: {},
    } as never);
    return replicator;
}

function createInitialFetchFastForwardDatabase(): PouchDB.Database<EntryDoc> {
    return new PouchDB<EntryDoc>(crypto.randomUUID(), { adapter: "memory" });
}

type InitialFetchFastForwardSettings = RemoteDBSettings &
    Pick<ObsidianLiveSyncSettings, "doNotSuspendOnFetching" | "suspendFileWatching" | "suspendParseReplicationResult">;

function initialFetchFastForwardSettings(
    overrides: Partial<InitialFetchFastForwardSettings> = {}
): InitialFetchFastForwardSettings {
    return {
        couchDB_URI: "https://example.test",
        couchDB_DBNAME: "remote",
        useRequestAPI: false,
        readChunksOnline: false,
        doNotSuspendOnFetching: false,
        suspendFileWatching: true,
        suspendParseReplicationResult: true,
        ...overrides,
    } as InitialFetchFastForwardSettings;
}

function createInitialFetchFastForwardResourceFixture(
    local: PouchDB.Database<EntryDoc>,
    remote: PouchDB.Database<EntryDoc>,
    settingOverrides: Partial<InitialFetchFastForwardSettings> = {}
) {
    const setting = initialFetchFastForwardSettings(settingOverrides);
    const currentSettings = { ...setting };
    const replicator = createOneShotReplicator(remote as unknown as { close: () => Promise<void> });
    const services = replicator.env.services as unknown as Record<string, any>;
    services.database.localDatabase.localDatabase = local;
    services.setting = { currentSettings: () => currentSettings };
    const connectionClose = vi.fn().mockResolvedValue(undefined);
    const openOwnedConnection = vi.spyOn(replicator as any, "openOwnedConnection").mockResolvedValue({
        db: remote,
        info: { update_seq: 0 },
        close: connectionClose,
    });
    const resource = replicator.createInitialFetchFastForwardResource(setting);
    return {
        currentSettings,
        openOwnedConnection,
        connectionClose,
        replicator,
        resource,
        setLocalDatabase(database: PouchDB.Database<EntryDoc>) {
            services.database.localDatabase.localDatabase = database;
        },
    };
}

async function importInitialFetchFastForwardDocument(
    local: PouchDB.Database<EntryDoc>,
    remote: PouchDB.Database<EntryDoc>,
    session: InitialFetchFastForward
) {
    const document = await remote.get("imported-note", { revs: true });
    await local.bulkDocs([document], { new_edits: false });
    session.recordStoredRevisions([{ id: document._id, rev: document._rev }]);
    session.recordCheckpoint((await remote.info()).update_seq);
}

async function getInitialFetchFastForwardCheckpoint(
    source: PouchDB.Database<EntryDoc>,
    target: PouchDB.Database<EntryDoc>
) {
    type ReplicationIdEndpoint = PouchDB.Database<EntryDoc> & Parameters<typeof generateReplicationId>[0];
    const id = await generateReplicationId(source as ReplicationIdEndpoint, target as ReplicationIdEndpoint, {});
    return await new Checkpointer(source, target, id, { cancelled: false }).getCheckpoint();
}

describe("LiveSyncCouchDBReplicator initial-fetch Fast Forward ownership", () => {
    it("prepares one handoff, advances its native checkpoints, and closes the private connection once", async () => {
        const local = createInitialFetchFastForwardDatabase();
        const remote = createInitialFetchFastForwardDatabase();
        const fixture = createInitialFetchFastForwardResourceFixture(local, remote);

        try {
            await remote.put({ _id: "imported-note", type: "plain", value: "imported" } as never);
            const session = await fixture.resource.prepare();
            expect(session).toBeDefined();
            await expect(fixture.resource.prepare()).resolves.toBeUndefined();
            await importInitialFetchFastForwardDocument(local, remote, session!);

            expect(await session!.fastForward()).toBe(true);
            const localSequence = (await local.info()).update_seq;
            const remoteSequence = (await remote.info()).update_seq;
            await expect(getInitialFetchFastForwardCheckpoint(local, remote)).resolves.toBe(localSequence);
            await expect(getInitialFetchFastForwardCheckpoint(remote, local)).resolves.toBe(remoteSequence);

            await fixture.resource.dispose();
            await fixture.resource.dispose();
            expect(fixture.openOwnedConnection).toHaveBeenCalledOnce();
            expect(fixture.connectionClose).toHaveBeenCalledOnce();
        } finally {
            await fixture.resource.dispose();
            await local.destroy();
            await remote.destroy();
        }
    });

    it.each([
        ["native Request API", { useRequestAPI: true }],
        ["fetch without writer suspension", { doNotSuspendOnFetching: true }],
    ] as const)("does not prepare or open a private connection for %s", async (_reason, overrides) => {
        const local = createInitialFetchFastForwardDatabase();
        const remote = createInitialFetchFastForwardDatabase();
        const fixture = createInitialFetchFastForwardResourceFixture(local, remote, overrides);

        try {
            await expect(fixture.resource.prepare()).resolves.toBeUndefined();
            await fixture.resource.dispose();
            await fixture.resource.dispose();

            expect(fixture.openOwnedConnection).not.toHaveBeenCalled();
            expect(fixture.connectionClose).not.toHaveBeenCalled();
        } finally {
            await fixture.resource.dispose();
            await local.destroy();
            await remote.destroy();
        }
    });

    it.each([
        "settings binding",
        "plaintext receipt policy",
        "local database",
        "file-watching suspension",
        "replication-result suspension",
        "resource disposal",
    ] as const)("does not advance imported checkpoints after %s changes", async (reason) => {
        const local = createInitialFetchFastForwardDatabase();
        const remote = createInitialFetchFastForwardDatabase();
        const replacement = createInitialFetchFastForwardDatabase();
        const fixture = createInitialFetchFastForwardResourceFixture(local, remote, { encrypt: true });

        try {
            await remote.put({ _id: "imported-note", type: "plain", value: "imported" } as never);
            const session = await fixture.resource.prepare();
            expect(session).toBeDefined();
            await importInitialFetchFastForwardDocument(local, remote, session!);
            switch (reason) {
                case "settings binding":
                    fixture.currentSettings.couchDB_DBNAME = "another-remote";
                    break;
                case "plaintext receipt policy":
                    fixture.currentSettings.acceptUnencryptedContent = true;
                    break;
                case "local database":
                    fixture.setLocalDatabase(replacement);
                    break;
                case "file-watching suspension":
                    fixture.currentSettings.suspendFileWatching = false;
                    break;
                case "replication-result suspension":
                    fixture.currentSettings.suspendParseReplicationResult = false;
                    break;
                case "resource disposal":
                    await fixture.resource.dispose();
                    break;
            }

            expect(await session!.fastForward()).toBe(false);
            await expect(getInitialFetchFastForwardCheckpoint(local, remote)).resolves.toBe(0);
            await expect(getInitialFetchFastForwardCheckpoint(remote, local)).resolves.toBe(0);

            await fixture.resource.dispose();
            await fixture.resource.dispose();
            expect(fixture.connectionClose).toHaveBeenCalledOnce();
        } finally {
            await fixture.resource.dispose();
            await local.destroy();
            await remote.destroy();
            await replacement.destroy();
        }
    });

    it("closes a connection which arrives after disposal during preparation", async () => {
        const local = createInitialFetchFastForwardDatabase();
        const remote = createInitialFetchFastForwardDatabase();
        const fixture = createInitialFetchFastForwardResourceFixture(local, remote);
        const releaseConnection = promiseWithResolvers<void>();
        fixture.openOwnedConnection.mockImplementation(async () => {
            await releaseConnection.promise;
            return { db: remote, info: { update_seq: 0 }, close: fixture.connectionClose };
        });
        const preparing = fixture.resource.prepare();

        try {
            expect(fixture.openOwnedConnection).toHaveBeenCalledOnce();
            await fixture.resource.dispose();
            releaseConnection.resolve();
            await expect(preparing).resolves.toBeUndefined();
            await fixture.resource.dispose();

            expect(fixture.connectionClose).toHaveBeenCalledOnce();
        } finally {
            releaseConnection.resolve();
            await preparing.catch((): void => {});
            await fixture.resource.dispose();
            await local.destroy();
            await remote.destroy();
        }
    });

    it("does not open a connection after disposal before preparation", async () => {
        const local = createInitialFetchFastForwardDatabase();
        const remote = createInitialFetchFastForwardDatabase();
        const fixture = createInitialFetchFastForwardResourceFixture(local, remote);

        try {
            await fixture.resource.dispose();
            await expect(fixture.resource.prepare()).resolves.toBeUndefined();

            expect(fixture.openOwnedConnection).not.toHaveBeenCalled();
            expect(fixture.connectionClose).not.toHaveBeenCalled();
        } finally {
            await fixture.resource.dispose();
            await local.destroy();
            await remote.destroy();
        }
    });
});

describe("LiveSyncCouchDBReplicator one-shot connection ownership", () => {
    it("passes its prepared owned remote database into the transfer before disposal", async () => {
        const missingMilestone = { status: 404 };
        const remoteDatabase = {
            get: vi.fn().mockRejectedValue(missingMilestone),
            put: vi.fn().mockResolvedValue({ ok: true }),
        };
        const connectionClose = vi.fn().mockResolvedValue(undefined);
        const onFiniteReplicationCompleted = vi.fn().mockRejectedValue(new Error("observer failed"));
        const sync = vi.fn(() => ({}));
        const localDatabase = {
            get: vi.fn().mockRejectedValue({ status: 404, name: "not_found" }),
            info: vi.fn().mockResolvedValue({ update_seq: 7 }),
            sync,
        };
        const replicator = Object.create(LiveSyncCouchDBReplicator.prototype) as LiveSyncCouchDBReplicator;
        replicator.env = {
            services: {
                API: {
                    addLog: Logger,
                    getAppVersion: () => "app-version",
                    getPluginVersion: () => "plugin-version",
                    getPlatform: () => "test-platform",
                    isMobile: () => false,
                },
                context: createServiceContext(),
                replication: { onFiniteReplicationCompleted },
                database: {
                    localDatabase: localDatabaseOwner(localDatabase),
                    localNodeIdentity: { nodeId: "device-node" },
                },
                vault: {
                    getVaultName: () => "device-name",
                    vaultName: () => "vault-name",
                },
            },
        } as unknown as LiveSyncCouchDBReplicator["env"];
        replicator.docArrived = 0;
        replicator.docSent = 0;
        replicator.updateInfo = vi.fn();
        replicator.terminateSync = vi.fn();
        vi.spyOn(operations(replicator), "prepareSecuritySeed").mockResolvedValue({ ready: true });
        const connect = vi.spyOn(operations(replicator), "openRemoteCouchDBWithSetting").mockResolvedValue({
            db: remoteDatabase,
            info: { update_seq: 9 },
            close: connectionClose,
        } as never);
        vi.spyOn(operations(replicator), "runSyncTransfer").mockResolvedValue({ action: "DONE" });
        const versionCheck = vi.spyOn(negotiation, "checkRemoteVersion").mockResolvedValue(true);
        const setting = {
            versionUpFlash: "",
            couchDB_URI: "https://example.test",
            couchDB_DBNAME: "remote",
            batch_size: 20,
            batches_limit: 20,
        } as RemoteDBSettings;

        try {
            await expect(replicator.openOneShotReplication(setting, false, false, "sync")).resolves.toBe(true);
        } finally {
            versionCheck.mockRestore();
        }

        expect(connect).toHaveBeenCalledOnce();
        expect(onFiniteReplicationCompleted).toHaveBeenCalledOnce();
        expect(replicator.docArrived).toBe(0);
        expect(remoteDatabase.get).toHaveBeenCalledWith(MILESTONE_DOCID);
        expect(sync).toHaveBeenCalledWith(remoteDatabase, expect.any(Object));
        expect(connectionClose).toHaveBeenCalledOnce();
    });

    it("ends a one-shot attempt when its connectivity preflight expires", async () => {
        const remoteDatabase = { close: vi.fn().mockResolvedValue(undefined) };
        const replicator = createOneShotReplicator(remoteDatabase);
        replicator.env = {
            ...replicator.env,
            oneShotConnectivityTimeoutMs: 5,
        } as LiveSyncCouchDBReplicator["env"];
        const failed = { status: "failed" } as const;
        const release = promiseWithResolvers<typeof failed>();
        vi.mocked(operations(replicator).openReplicationConnection).mockImplementation((...args) => {
            const options = args[5] as { signal?: AbortSignal } | undefined;
            options?.signal?.addEventListener("abort", () => release.resolve(failed), { once: true });
            return release.promise;
        });

        const replication = replicator.openOneShotReplication({} as RemoteDBSettings, false, false, "sync");
        let pendingTimer: ReturnType<typeof setTimeout> | undefined;
        const outcome = await Promise.race([
            replication,
            new Promise<"pending">((resolve) => {
                pendingTimer = setTimeout(() => resolve("pending"), 250);
            }),
        ]);
        if (pendingTimer) clearTimeout(pendingTimer);
        release.resolve(failed);
        await replication;

        expect(outcome).toBe(false);
        await expect(replicator.openOneShotReplication({} as RemoteDBSettings, false, false, "sync")).resolves.toBe(
            false
        );
        expect(operations(replicator).openReplicationConnection).toHaveBeenCalledTimes(2);
    });

    it.each([
        ["when close succeeds", undefined],
        ["without replacing the timeout when close fails", new Error("close failed")],
    ] as const)("aborts and closes the owned connection %s", async (_case, closeError) => {
        const remoteDatabase = { close: vi.fn().mockResolvedValue(undefined) };
        const connectionClose = closeError
            ? vi.fn().mockRejectedValue(closeError)
            : vi.fn().mockResolvedValue(undefined);
        const replicator = createOneShotReplicator(remoteDatabase);
        vi.mocked(operations(replicator).openReplicationConnection).mockRestore();
        let preflightSignal: AbortSignal | undefined;
        const connect = vi.fn((...args: unknown[]) => {
            const options = args[11] as { signal: AbortSignal };
            preflightSignal = options.signal;
            return Promise.resolve({
                db: remoteDatabase,
                info: { update_seq: 9 },
                close: connectionClose,
            });
        });
        replicator.env = {
            ...replicator.env,
            oneShotConnectivityTimeoutMs: 5,
            services: {
                ...replicator.env.services,
                API: { isMobile: () => false, addLog: Logger },
                remote: { connect },
            },
        } as unknown as LiveSyncCouchDBReplicator["env"];
        const versionCheck = vi.spyOn(negotiation, "checkRemoteVersion").mockImplementation(
            () =>
                new Promise<boolean>((_resolve, reject) => {
                    preflightSignal?.addEventListener("abort", () => reject(preflightSignal?.reason), {
                        once: true,
                    });
                })
        );
        const logger = vi.fn();
        setGlobalLogFunction(logger);

        try {
            await expect(
                replicator.openOneShotReplication(
                    {
                        versionUpFlash: "",
                        couchDB_URI: "https://example.test",
                        couchDB_DBNAME: "remote",
                        couchDB_CustomHeaders: "",
                    } as RemoteDBSettings,
                    false,
                    false,
                    "sync"
                )
            ).resolves.toBe(false);
            expect(logger).toHaveBeenCalledWith("The remote connectivity check timed out.", expect.anything(), "sync");
            if (closeError) {
                expect(logger).toHaveBeenCalledWith("Failed to close remote database.", expect.anything(), "sync");
                expect(logger).toHaveBeenCalledWith(closeError, expect.anything(), "sync");
            }
        } finally {
            versionCheck.mockRestore();
            setGlobalLogFunction(defaultLogger);
        }

        expect(preflightSignal?.aborted).toBe(true);
        expect(connectionClose).toHaveBeenCalledOnce();
        expect(remoteDatabase.close).not.toHaveBeenCalled();
        expect((replicator.rawDatabase as unknown as { sync: ReturnType<typeof vi.fn> }).sync).not.toHaveBeenCalled();
    });

    it("clears the connectivity deadline before transferring the connection to replication", async () => {
        const remoteDatabase = { close: vi.fn().mockResolvedValue(undefined) };
        const connectionClose = vi.fn().mockResolvedValue(undefined);
        const replicator = createOneShotReplicator(remoteDatabase);
        replicator.env = {
            ...replicator.env,
            oneShotConnectivityTimeoutMs: 5,
        } as LiveSyncCouchDBReplicator["env"];
        let preflightSignal: AbortSignal | undefined;
        vi.mocked(operations(replicator).openReplicationConnection).mockImplementation((...args) => {
            preflightSignal = (args[5] as { signal?: AbortSignal } | undefined)?.signal;
            return Promise.resolve({
                db: remoteDatabase,
                info: { update_seq: 9 },
                close: connectionClose,
                syncOptionBase: {},
            } as never);
        });
        vi.spyOn(operations(replicator), "runSyncTransfer").mockImplementation(async () => {
            await new Promise((resolve) => setTimeout(resolve, 15));
            return { action: "DONE" };
        });

        await expect(replicator.openOneShotReplication({} as RemoteDBSettings, false, false, "sync")).resolves.toBe(
            true
        );

        expect(preflightSignal?.aborted).toBe(false);
        expect(connectionClose).toHaveBeenCalledOnce();
        expect(remoteDatabase.close).not.toHaveBeenCalled();
    });

    it("does not claim a deadline for the non-abortable native request path", async () => {
        const remoteDatabase = { close: vi.fn().mockResolvedValue(undefined) };
        const replicator = createOneShotReplicator(remoteDatabase);
        vi.mocked(operations(replicator).openReplicationConnection).mockResolvedValue({ status: "failed" });

        await expect(
            replicator.openOneShotReplication({ useRequestAPI: true } as RemoteDBSettings, false, false, "sync")
        ).resolves.toBe(false);

        expect(operations(replicator).openReplicationConnection).toHaveBeenCalledWith(
            expect.anything(),
            false,
            false,
            false,
            false
        );
    });

    it.each([
        ["DONE", true],
        ["FAILED", false],
    ] as const)("closes the remote database after %s", async (syncResult, expected) => {
        const remoteDatabase = { close: vi.fn().mockResolvedValue(undefined) };
        const replicator = createOneShotReplicator(remoteDatabase);
        vi.spyOn(operations(replicator), "runSyncTransfer").mockResolvedValue({ action: syncResult });

        await expect(replicator.openOneShotReplication({} as RemoteDBSettings, false, false, "sync")).resolves.toBe(
            expected
        );

        expect(remoteDatabase.close).toHaveBeenCalledOnce();
    });

    it("closes every finite connection across repeated one-shot Security Seed refreshes", async () => {
        const remoteDatabases: {
            close: ReturnType<typeof vi.fn>;
            get: ReturnType<typeof vi.fn>;
        }[] = [];
        const localDatabase = {
            info: vi.fn().mockResolvedValue({ update_seq: 7 }),
            sync: vi.fn(() => ({})),
        };
        const replicator = Object.create(LiveSyncCouchDBReplicator.prototype) as LiveSyncCouchDBReplicator;
        replicator.env = {
            services: {
                API: { isMobile: () => false, addLog: Logger },
                context: createServiceContext(),
                database: { localDatabase: localDatabaseOwner(localDatabase) },
            },
        } as unknown as LiveSyncCouchDBReplicator["env"];
        replicator.docArrived = 0;
        replicator.docSent = 0;
        replicator.updateInfo = vi.fn();
        replicator.terminateSync = vi.fn();
        const setting = {
            couchDB_URI: "https://example.test",
            couchDB_DBNAME: "remote",
        } as RemoteDBSettings;
        const connect = vi
            .spyOn(operations(replicator), "openRemoteCouchDBWithSetting")
            .mockImplementation(async () => {
                const db = {
                    close: vi.fn().mockResolvedValue(undefined),
                    get: vi.fn().mockResolvedValue({ ...DEFAULT_SYNC_PARAMETERS, pbkdf2salt: "AA==" }),
                };
                remoteDatabases.push(db);
                return { db, info: { update_seq: 9 }, close: () => db.close() } as never;
            });
        vi.spyOn(operations(replicator), "openReplicationConnection").mockImplementation(async () => {
            const connection = await operations(replicator).openRemoteCouchDBWithSetting(setting, false, true, false);
            assert(!("error" in connection));
            return { ...connection, syncOptionBase: {} } as never;
        });
        vi.spyOn(operations(replicator), "runSyncTransfer").mockResolvedValue({ action: "DONE" });

        try {
            for (let cycle = 0; cycle < 2; cycle++) {
                // Exercise the refresh boundary that hid a second finite connection behind each one-shot attempt.
                clearHandlers();
                await expect(replicator.openOneShotReplication(setting, false, false, "sync")).resolves.toBe(true);
            }
        } finally {
            clearHandlers();
        }

        expect(connect).toHaveBeenCalledTimes(4);
        expect(remoteDatabases).toHaveLength(4);
        for (const remoteDatabase of remoteDatabases) {
            expect(remoteDatabase.close).toHaveBeenCalledOnce();
        }
    });

    it("closes a connection when connectivity checks cannot transfer ownership", async () => {
        const remoteDatabase = {
            get: vi.fn().mockRejectedValue({ status: 404, name: "not_found" }),
            close: vi.fn().mockResolvedValue(undefined),
        };
        const replicator = Object.create(LiveSyncCouchDBReplicator.prototype) as LiveSyncCouchDBReplicator;
        replicator.env = {
            services: {
                API: { addLog: Logger },
                context: createServiceContext(),
                database: { localDatabase: localDatabaseOwner(remoteDatabase) },
            },
        } as unknown as LiveSyncCouchDBReplicator["env"];
        replicator.isMobile = vi.fn().mockReturnValue(false);
        vi.spyOn(operations(replicator), "openRemoteCouchDBWithSetting").mockResolvedValue({
            db: remoteDatabase,
            info: { update_seq: 9 },
            close: () => remoteDatabase.close(),
        } as never);
        const versionCheck = vi.spyOn(negotiation, "checkRemoteVersion").mockResolvedValueOnce(false);

        try {
            await expect(
                replicator.checkReplicationConnectivity(
                    {
                        versionUpFlash: "",
                        couchDB_URI: "https://example.test",
                        couchDB_DBNAME: "db",
                    } as RemoteDBSettings,
                    false,
                    false,
                    false
                )
            ).resolves.toBe(false);
        } finally {
            versionCheck.mockRestore();
        }

        expect(remoteDatabase.close).toHaveBeenCalledOnce();
    });

    it("leaves a successful connection open for the caller that receives ownership", async () => {
        const remoteDatabase = {
            get: vi.fn().mockRejectedValue({ status: 404, name: "not_found" }),
            close: vi.fn().mockResolvedValue(undefined),
        };
        const replicator = Object.create(LiveSyncCouchDBReplicator.prototype) as LiveSyncCouchDBReplicator;
        replicator.env = {
            services: {
                API: { addLog: Logger },
                context: createServiceContext(),
                database: { localDatabase: localDatabaseOwner(remoteDatabase) },
            },
        } as unknown as LiveSyncCouchDBReplicator["env"];
        replicator.isMobile = vi.fn().mockReturnValue(false);
        vi.spyOn(operations(replicator), "openRemoteCouchDBWithSetting").mockResolvedValue({
            db: remoteDatabase,
            info: { update_seq: 9 },
            close: () => remoteDatabase.close(),
        } as never);

        const connection = await replicator.checkReplicationConnectivity(
            {
                versionUpFlash: "",
                couchDB_URI: "https://example.test",
                couchDB_DBNAME: "db",
                batch_size: 20,
                batches_limit: 20,
            } as RemoteDBSettings,
            false,
            true,
            false
        );

        expect(connection).not.toBe(false);
        expect(connection && connection.db).toBe(remoteDatabase);
        expect(remoteDatabase.close).not.toHaveBeenCalled();
    });

    it.each(["NEED_RETRY", "NEED_RESURRECT"] as const)(
        "waits for close and reassesses compatibility before %s starts",
        async (syncResult) => {
            const events: string[] = [];
            const remoteDatabase = {
                close: vi.fn(async () => {
                    await Promise.resolve();
                    events.push("closed");
                }),
            };
            const replicator = createOneShotReplicator(remoteDatabase);
            vi.spyOn(operations(replicator), "runSyncTransfer").mockResolvedValue({ action: syncResult });
            vi.mocked(operations(replicator).openReplicationConnection)
                .mockResolvedValueOnce({
                    db: remoteDatabase,
                    info: { update_seq: 9 },
                    close: () => remoteDatabase.close(),
                    syncOptionBase: {},
                } as never)
                .mockImplementationOnce(async () => {
                    events.push("restarted");
                    return { status: "failed" };
                });
            const setting = { batch_size: 20, batches_limit: 20 } as RemoteDBSettings;

            await replicator.openOneShotReplication(setting, false, false, "sync");

            expect(events).toEqual(["closed", "restarted"]);
            expect(vi.mocked(operations(replicator).openReplicationConnection).mock.calls[1]?.[2]).toBe(false);
        }
    );

    it("logs a close failure without replacing the replication result", async () => {
        const closeError = new Error("close failed");
        const remoteDatabase = { close: vi.fn().mockRejectedValue(closeError) };
        const replicator = createOneShotReplicator(remoteDatabase);
        vi.spyOn(operations(replicator), "runSyncTransfer").mockResolvedValue({ action: "DONE" });
        const logger = vi.fn();
        setGlobalLogFunction(logger);

        try {
            await expect(replicator.openOneShotReplication({} as RemoteDBSettings, false, false, "sync")).resolves.toBe(
                true
            );
            expect(logger).toHaveBeenCalledWith("Failed to close remote database.", expect.anything(), "sync");
            expect(logger).toHaveBeenCalledWith(closeError, expect.anything(), "sync");
        } finally {
            setGlobalLogFunction(defaultLogger);
        }
    });

    it("logs a close failure without preventing retry", async () => {
        const remoteDatabase = { close: vi.fn().mockRejectedValue(new Error("close failed")) };
        const replicator = createOneShotReplicator(remoteDatabase);
        vi.spyOn(operations(replicator), "runSyncTransfer").mockResolvedValue({ action: "NEED_RETRY" });
        vi.mocked(operations(replicator).openReplicationConnection)
            .mockResolvedValueOnce({
                db: remoteDatabase,
                info: { update_seq: 9 },
                close: () => remoteDatabase.close(),
                syncOptionBase: {},
            } as never)
            .mockResolvedValueOnce({ status: "failed" });
        const logger = vi.fn();
        setGlobalLogFunction(logger);

        try {
            await replicator.openOneShotReplication(
                { batch_size: 20, batches_limit: 20 } as RemoteDBSettings,
                false,
                false,
                "sync"
            );
            expect(operations(replicator).openReplicationConnection).toHaveBeenCalledTimes(2);
            expect(logger).toHaveBeenCalledWith("Failed to close remote database.", expect.anything(), "sync");
        } finally {
            setGlobalLogFunction(defaultLogger);
        }
    });
});

describe("LiveSyncCouchDBReplicator direct document connection ownership", () => {
    it.each([
        ["success", { _id: "sync-params" }, undefined],
        ["not found", false, { status: 404 }],
        ["failure", undefined, new Error("get failed")],
    ] as const)("closes an internally created connection after %s", async (_case, expected, error) => {
        const remoteDatabase = {
            get: error ? vi.fn().mockRejectedValue(error) : vi.fn().mockResolvedValue(expected),
        };
        const connectionClose = vi.fn().mockResolvedValue(undefined);
        const replicator = Object.create(LiveSyncCouchDBReplicator.prototype) as LiveSyncCouchDBReplicator;
        replicator.isMobile = vi.fn().mockReturnValue(false);
        vi.spyOn(operations(replicator), "openRemoteCouchDBWithSetting").mockResolvedValue({
            db: remoteDatabase,
            close: connectionClose,
        } as never);

        const result = replicator.fetchRemoteDocument({} as RemoteDBSettings, "sync-params");
        if (error && "status" in error && error.status === 404) {
            await expect(result).resolves.toBe(false);
        } else if (error) {
            await expect(result).rejects.toBe(error);
        } else {
            await expect(result).resolves.toBe(expected);
        }

        expect(connectionClose).toHaveBeenCalledOnce();
    });

    it("leaves a caller-provided connection open", async () => {
        const remoteDatabase = {
            get: vi.fn().mockResolvedValue({ _id: "sync-params" }),
            close: vi.fn().mockResolvedValue(undefined),
        };
        const replicator = Object.create(LiveSyncCouchDBReplicator.prototype) as LiveSyncCouchDBReplicator;

        await replicator.fetchRemoteDocument({} as RemoteDBSettings, "sync-params", remoteDatabase as never);

        expect(remoteDatabase.close).not.toHaveBeenCalled();
    });

    it.each([
        ["success", undefined],
        ["failure", new Error("put failed")],
    ] as const)("closes an internally created connection after put %s", async (_case, error) => {
        const response = { ok: true, id: "sync-params", rev: "1-test" };
        const remoteDatabase = {
            put: error ? vi.fn().mockRejectedValue(error) : vi.fn().mockResolvedValue(response),
        };
        const connectionClose = vi.fn().mockResolvedValue(undefined);
        const replicator = Object.create(LiveSyncCouchDBReplicator.prototype) as LiveSyncCouchDBReplicator;
        replicator.isMobile = vi.fn().mockReturnValue(false);
        vi.spyOn(operations(replicator), "openRemoteCouchDBWithSetting").mockResolvedValue({
            db: remoteDatabase,
            close: connectionClose,
        } as never);

        const result = replicator.putRemoteDocument({} as RemoteDBSettings, { _id: "sync-params" } as never);
        if (error) {
            await expect(result).rejects.toBe(error);
        } else {
            await expect(result).resolves.toBe(response);
        }

        expect(connectionClose).toHaveBeenCalledOnce();
    });

    it("leaves a caller-provided connection open after put", async () => {
        const remoteDatabase = {
            put: vi.fn().mockResolvedValue({ ok: true, id: "sync-params", rev: "1-test" }),
            close: vi.fn().mockResolvedValue(undefined),
        };
        const replicator = Object.create(LiveSyncCouchDBReplicator.prototype) as LiveSyncCouchDBReplicator;

        await replicator.putRemoteDocument(
            {} as RemoteDBSettings,
            { _id: "sync-params" } as never,
            remoteDatabase as never
        );

        expect(remoteDatabase.close).not.toHaveBeenCalled();
    });
});

describe("LiveSyncCouchDBReplicator finite maintenance connection ownership", () => {
    const setting = {
        couchDB_URI: "https://example.invalid",
        couchDB_DBNAME: "remote",
    } as RemoteDBSettings;

    function createReplicator(
        remoteDatabase: Record<string, unknown>,
        connectionClose = vi.fn().mockResolvedValue(undefined)
    ) {
        const replicator = Object.create(LiveSyncCouchDBReplicator.prototype) as LiveSyncCouchDBReplicator;
        replicator.env = {
            services: {
                API: { isMobile: () => false, addLog: Logger },
                context: createServiceContext(),
                database: { localNodeIdentity: { nodeId: "node" } },
                setting: { currentSettings: () => setting },
            },
        } as unknown as LiveSyncCouchDBReplicator["env"];
        vi.spyOn(replicator, "connectRemoteCouchDBWithSetting").mockResolvedValue({
            db: remoteDatabase,
            info: { db_name: "remote" },
            close: connectionClose,
        } as never);
        return { connectionClose, replicator };
    }

    it.each([
        ["compactRemote", (replicator: LiveSyncCouchDBReplicator) => replicator.compactRemote(setting)],
        ["getRemoteStatus", (replicator: LiveSyncCouchDBReplicator) => replicator.getRemoteStatus(setting)],
        [
            "getConnectedDeviceList",
            (replicator: LiveSyncCouchDBReplicator) => replicator.getConnectedDeviceList(setting),
        ],
    ] as const)("closes the connection after %s", async (_method, run) => {
        const remoteDatabase = {
            compact: vi.fn().mockResolvedValue({ ok: true }),
            info: vi.fn().mockResolvedValue({ db_name: "remote" }),
            get: vi.fn().mockResolvedValue({ node_info: {}, accepted_nodes: [] }),
            close: vi.fn().mockResolvedValue(undefined),
        };
        const { connectionClose, replicator } = createReplicator(remoteDatabase);

        await run(replicator);

        expect(connectionClose).toHaveBeenCalledOnce();
    });

    it("closes the connection after reading preferred tweak values", async () => {
        const remoteDatabase = {
            get: vi.fn(async (id: string) =>
                id === VERSIONING_DOCID
                    ? { _id: VERSIONING_DOCID, type: "versioninfo", version: VER }
                    : { _id: MILESTONE_DOCID, tweak_values: {} }
            ),
            close: vi.fn().mockResolvedValue(undefined),
        };
        const { connectionClose, replicator } = createReplicator(remoteDatabase);

        await replicator.getRemotePreferredTweakValues(setting);

        expect(connectionClose).toHaveBeenCalledOnce();
    });

    it("logs a close failure without replacing a finite operation result", async () => {
        const closeError = new Error("close failed");
        const remoteDatabase = {
            compact: vi.fn().mockResolvedValue({ ok: true }),
            close: vi.fn().mockRejectedValue(closeError),
        };
        const connectionClose = vi.fn().mockRejectedValue(closeError);
        const { replicator } = createReplicator(remoteDatabase, connectionClose);
        const logger = vi.fn();
        setGlobalLogFunction(logger);

        try {
            await expect(replicator.compactRemote(setting)).resolves.toBe(true);
            expect(logger).toHaveBeenCalledWith("Failed to close remote database.", expect.anything(), "sync");
            expect(logger).toHaveBeenCalledWith(closeError, expect.anything(), "sync");
        } finally {
            setGlobalLogFunction(defaultLogger);
        }
    });
});

describe("LiveSyncCouchDBReplicator chunk sending settlement and connection ownership", () => {
    function createChunkSendingFixture(chunkCount: number, bulkDocs: ReturnType<typeof vi.fn>) {
        const chunks = Array.from({ length: chunkCount }, (_, index) => ({
            id: `h:chunk-${index}`,
            seq: index + 1,
        }));
        const values = new Map<string, unknown>();
        const store = {
            delete: vi.fn(async (key: string) => {
                values.delete(key);
            }),
            get: vi.fn(async (key: string) => values.get(key)),
            keys: vi.fn(async (from: string, to: string) =>
                [...values.keys()].filter((key) => key >= from && key < to).sort()
            ),
            set: vi.fn(async (key: string, value: unknown) => {
                values.set(key, value);
            }),
        };
        const changes = Object.assign(Promise.resolve(), {
            on: vi.fn((_event: string, handler: (change: { id: string; seq: number }) => void) => {
                chunks.forEach(handler);
                return changes;
            }),
        });
        const localDatabase = {
            changes: vi.fn(() => changes),
            allDocs: vi.fn(async ({ keys }: { keys: string[] }) => ({
                rows: keys.map((id) => ({
                    id,
                    key: id,
                    value: { rev: "1-local" },
                    doc: { _id: id, _rev: "1-local", type: "leaf", data: id },
                })),
            })),
        };
        const remoteDatabase = {
            get: vi.fn(async () => ({ created: 1 })),
            allDocs: vi.fn(async ({ keys }: { keys: string[] }) => ({
                rows: keys.map((id) => ({ id, key: id, error: "not_found" })),
            })),
            bulkDocs,
            close: vi.fn().mockResolvedValue(undefined),
        };
        const replicator = Object.create(LiveSyncCouchDBReplicator.prototype) as LiveSyncCouchDBReplicator;
        replicator.env = {
            services: {
                API: { isMobile: () => false, addLog: Logger },
                context: createServiceContext(),
                database: { localDatabase: localDatabaseOwner(localDatabase) },
                keyValueDB: { openSimpleStore: () => store },
            },
        } as unknown as LiveSyncCouchDBReplicator["env"];
        vi.spyOn(replicator, "getLastTransferredSeqOfChunks").mockResolvedValue({
            _id: "_local/max_seq_on_chunk-1",
            maxSeq: 0,
            remoteID: 1,
            seqStatusMap: {},
            _rev: undefined,
        });
        vi.spyOn(operations(replicator), "openReplicationConnection").mockResolvedValue({
            db: remoteDatabase,
        } as never);
        vi.spyOn(operations(replicator), "closeRemoteConnection").mockResolvedValue(undefined);
        vi.spyOn(replicator, "updateMaxTransferredSeqOnChunks").mockResolvedValue({} as never);

        return { remoteDatabase, replicator };
    }

    it("returns false when a scheduled batch reports a handled upload failure", async () => {
        const bulkDocs = vi.fn().mockRejectedValue(new Error("upload failed"));
        const { remoteDatabase, replicator } = createChunkSendingFixture(1, bulkDocs);

        await expect(
            replicator.sendChunks({ sendChunksBulkMaxSize: 1 } as RemoteDBSettings, remoteDatabase as never, false, 0)
        ).resolves.toBe(false);
        expect(remoteDatabase.bulkDocs).toHaveBeenCalledOnce();
    });

    it("does not send chunks when the remote compatibility preflight rejects the operation", async () => {
        const bulkDocs = vi.fn().mockResolvedValue([]);
        const { remoteDatabase, replicator } = createChunkSendingFixture(1, bulkDocs);
        vi.mocked(operations(replicator).openReplicationConnection).mockResolvedValueOnce({ status: "failed" });

        await expect(
            replicator.sendChunks({ sendChunksBulkMaxSize: 1 } as RemoteDBSettings, remoteDatabase as never, false, 0)
        ).resolves.toBe(false);
        expect(bulkDocs).not.toHaveBeenCalled();
        expect(remoteDatabase.get).not.toHaveBeenCalled();
    });

    it("does not carry the previous final batch into the next queued group", async () => {
        const bulkDocs = vi.fn().mockResolvedValue([]);
        const { remoteDatabase, replicator } = createChunkSendingFixture(251, bulkDocs);

        await expect(
            replicator.sendChunks({ sendChunksBulkMaxSize: 1 } as RemoteDBSettings, remoteDatabase as never, false, 0)
        ).resolves.toBe(true);

        const sentIDs = bulkDocs.mock.calls.flatMap(([docs]) => (docs as Array<{ _id: string }>).map((doc) => doc._id));
        expect(sentIDs).toHaveLength(251);
        expect(new Set(sentIDs).size).toBe(251);
    });

    it("closes only the connection it creates when sending fails", async () => {
        const remoteDatabase = {
            get: vi.fn().mockRejectedValue(new Error("milestone failed")),
            close: vi.fn().mockResolvedValue(undefined),
        };
        const connectionClose = vi.fn().mockResolvedValue(undefined);
        const replicator = Object.create(LiveSyncCouchDBReplicator.prototype) as LiveSyncCouchDBReplicator;
        replicator.env = {
            services: {
                API: { isMobile: () => false, addLog: Logger },
                context: createServiceContext(),
                keyValueDB: {
                    openSimpleStore: () => ({
                        delete: vi.fn(),
                        get: vi.fn(),
                        keys: vi.fn().mockResolvedValue([]),
                        set: vi.fn(),
                    }),
                },
            },
        } as unknown as LiveSyncCouchDBReplicator["env"];
        vi.spyOn(replicator, "connectRemoteCouchDBWithSetting").mockResolvedValue({
            db: remoteDatabase,
            close: connectionClose,
        } as never);
        vi.spyOn(operations(replicator), "openReplicationConnection").mockResolvedValue({
            db: remoteDatabase,
            close: vi.fn().mockResolvedValue(undefined),
        } as never);

        await expect(replicator.sendChunks({} as RemoteDBSettings, undefined, false)).rejects.toThrow(
            "milestone failed"
        );
        expect(connectionClose).toHaveBeenCalledOnce();

        await expect(replicator.sendChunks({} as RemoteDBSettings, remoteDatabase as never, false)).rejects.toThrow(
            "milestone failed"
        );

        expect(connectionClose).toHaveBeenCalledOnce();
        expect(remoteDatabase.close).not.toHaveBeenCalled();
    });
});

describe("LiveSyncCouchDBReplicator remote chunk fetching", () => {
    it("preserves a typed supplied-fetch rejection through real PouchDB HTTP reads", async () => {
        const typedFailure = new RemoteRequestError("Remote request failed", {
            cause: new TypeError("network fetch failed"),
        });
        const fetch = vi.fn().mockRejectedValue(typedFailure);
        const remote = new PouchDB<EntryDoc>("https://couchdb.test/typed-request", {
            skip_setup: true,
            fetch,
        });

        try {
            await expect(remote.allDocs({ keys: ["h:pending"] })).rejects.toBe(typedFailure);
            expect(fetch).toHaveBeenCalledOnce();
        } finally {
            await remote.close();
        }
    });

    it("reports network failure in the version probe before the chunk lookup", async () => {
        const failure = Object.assign(new Error("request unavailable"), { status: 0 });
        const remoteDatabase = { get: vi.fn().mockRejectedValue(failure), allDocs: vi.fn() };
        const close = vi.fn().mockResolvedValue(undefined);
        const replicator = Object.create(LiveSyncCouchDBReplicator.prototype) as LiveSyncCouchDBReplicator;
        replicator.env = {
            services: {
                API: { isMobile: () => false, isOnline: true, addLog: Logger },
                context: createServiceContext(),
                setting: { currentSettings: () => ({}) },
            },
        } as unknown as LiveSyncCouchDBReplicator["env"];
        vi.spyOn(replicator, "connectRemoteCouchDBWithSetting").mockResolvedValue({
            db: remoteDatabase,
            close,
        } as never);

        await expect(replicator.fetchRemoteChunks(["h:pending"], false, {} as RemoteDBSettings)).rejects.toBe(failure);

        expect(remoteDatabase.allDocs).not.toHaveBeenCalled();
        expect(close).toHaveBeenCalledOnce();
    });

    it.each([
        ["native network TypeError", new TypeError("network fetch failed"), true, "transport"],
        ["status zero", Object.assign(new Error("network fetch failed"), { status: 0 }), true, "transport"],
        ["server status 503", Object.assign(new Error("server unavailable"), { status: 503 }), true, "unavailable"],
        ["untyped unknown native error", new Error("unclassified request failure"), true, "unavailable"],
        ["untyped structural Error", { name: "Error", message: "unclassified request failure" }, true, "unavailable"],
        [
            "authentication status 401",
            Object.assign(new Error("unauthorised"), { status: 401 }),
            true,
            "authentication",
        ],
        ["cancellation while offline", Object.assign(new Error("aborted"), { name: "AbortError" }), false, "cancelled"],
    ] as const)("preserves %s at the remote chunk lookup boundary", async (_case, failure, isOnline, _reason) => {
        const remoteDatabase = {
            get: vi.fn(async () => ({ _id: VERSIONING_DOCID, type: "versioninfo", version: VER })),
            allDocs: vi.fn().mockRejectedValue(failure),
        };
        const connectionClose = vi.fn().mockResolvedValue(undefined);
        const replicator = Object.create(LiveSyncCouchDBReplicator.prototype) as LiveSyncCouchDBReplicator;
        replicator.env = {
            services: {
                API: { isMobile: () => false, isOnline, addLog: Logger },
                context: createServiceContext(),
                setting: { currentSettings: () => ({}) },
            },
        } as unknown as LiveSyncCouchDBReplicator["env"];
        vi.spyOn(replicator, "connectRemoteCouchDBWithSetting").mockResolvedValue({
            db: remoteDatabase,
            close: connectionClose,
        } as never);

        await expect(Reflect.apply(replicator.fetchRemoteChunks, replicator, [["h:pending"], false, {}])).rejects.toBe(
            failure
        );

        expect(connectionClose).toHaveBeenCalledOnce();
    });

    it.each([
        ["network cause behind default status 500", new TypeError("network fetch failed"), true, "transport"],
        ["authentication cause", Object.assign(new Error("unauthorised"), { status: 401 }), true, "authentication"],
        ["missing cause", Object.assign(new Error("missing"), { status: 404 }), true, "missing"],
        ["configuration cause", Object.assign(new Error("invalid request"), { status: 400 }), true, "configuration"],
        ["unknown cause", new Error("unclassified request failure"), true, "transport"],
        ["cross-realm Error cause", { name: "Error", message: "unclassified request failure" }, true, "transport"],
        ["abort cause", Object.assign(new Error("aborted"), { name: "AbortError" }), false, "cancelled"],
    ] as const)("preserves typed request failure with its %s", async (_case, cause, isOnline, _reason) => {
        const typedFailure = new RemoteRequestError("Remote request failed", { cause });
        const remoteDatabase = {
            get: vi.fn(async () => ({ _id: VERSIONING_DOCID, type: "versioninfo", version: VER })),
            allDocs: vi.fn().mockRejectedValue(typedFailure),
        };
        const connectionClose = vi.fn().mockResolvedValue(undefined);
        const replicator = Object.create(LiveSyncCouchDBReplicator.prototype) as LiveSyncCouchDBReplicator;
        replicator.env = {
            services: {
                API: { isMobile: () => false, isOnline, addLog: Logger },
                context: createServiceContext(),
                setting: { currentSettings: () => ({}) },
            },
        } as unknown as LiveSyncCouchDBReplicator["env"];
        vi.spyOn(replicator, "connectRemoteCouchDBWithSetting").mockResolvedValue({
            db: remoteDatabase,
            close: connectionClose,
        } as never);

        await expect(Reflect.apply(replicator.fetchRemoteChunks, replicator, [["h:pending"], false, {}])).rejects.toBe(
            typedFailure
        );

        expect(connectionClose).toHaveBeenCalledOnce();
    });

    it("uses the actual offline API status for a rejected connection preflight", async () => {
        const replicator = Object.create(LiveSyncCouchDBReplicator.prototype) as LiveSyncCouchDBReplicator;
        replicator.env = {
            services: {
                API: { isMobile: () => false, isOnline: false, addLog: Logger },
                context: createServiceContext(),
                setting: { currentSettings: () => ({}) },
            },
        } as unknown as LiveSyncCouchDBReplicator["env"];
        vi.spyOn(replicator, "connectRemoteCouchDBWithSetting").mockResolvedValue("offline" as never);

        await expect(
            Reflect.apply(replicator.fetchRemoteChunks, replicator, [["h:pending"], false, {}])
        ).rejects.toBeInstanceOf(RemoteRequestError);
    });

    it("does not fetch chunks from a database using an unknown feature", async () => {
        const remoteDatabase = {
            get: vi.fn(async () => ({
                _id: VERSIONING_DOCID,
                type: "versioninfo",
                version: 13,
                used_features: ["future-format-v7"],
            })),
            allDocs: vi.fn(async () => ({ rows: [] })),
        };
        const connectionClose = vi.fn().mockResolvedValue(undefined);
        const replicator = Object.create(LiveSyncCouchDBReplicator.prototype) as LiveSyncCouchDBReplicator;
        replicator.env = {
            services: {
                API: { isMobile: () => false, addLog: Logger },
                context: createServiceContext(),
                setting: { currentSettings: () => ({}) },
            },
        } as unknown as LiveSyncCouchDBReplicator["env"];
        vi.spyOn(replicator, "connectRemoteCouchDBWithSetting").mockResolvedValue({
            db: remoteDatabase,
            close: connectionClose,
        } as never);

        await expect(replicator.fetchRemoteChunks(["h:pending"], false)).rejects.toBeInstanceOf(RemoteRequestError);
        expect(remoteDatabase.allDocs).not.toHaveBeenCalled();
        expect(connectionClose).toHaveBeenCalledOnce();
    });

    it("preserves available chunks when another row in the same batch is missing", async () => {
        const availableChunk = {
            _id: "h:available" as DocumentID,
            type: "leaf",
            data: "available-data",
        } as EntryLeaf;
        const allDocs = vi.fn().mockResolvedValue({
            rows: [
                {
                    id: availableChunk._id,
                    key: availableChunk._id,
                    value: { rev: "1-available" },
                    doc: availableChunk,
                },
                {
                    key: "h:missing",
                    error: "not_found",
                },
            ],
        });
        const replicator = Object.create(LiveSyncCouchDBReplicator.prototype) as LiveSyncCouchDBReplicator;
        const connectionClose = vi.fn().mockResolvedValue(undefined);
        const liveSetting = { couchDB_URI: "https://live.example.test" } as RemoteDBSettings;
        replicator.env = {
            services: {
                API: { isMobile: () => false, addLog: Logger },
                context: createServiceContext(),
                setting: { currentSettings: () => liveSetting },
            },
        } as unknown as LiveSyncCouchDBReplicator["env"];
        const connect = vi.spyOn(replicator, "connectRemoteCouchDBWithSetting").mockResolvedValue({
            db: { get: vi.fn(async () => ({ _id: VERSIONING_DOCID, type: "versioninfo", version: VER })), allDocs },
            close: connectionClose,
        } as never);
        const readSetting = { couchDB_URI: "https://snapshot.example.test" } as RemoteDBSettings;
        const fetchWithSetting = replicator.fetchRemoteChunks as (
            missingChunks: string[],
            showResult: boolean,
            setting: RemoteDBSettings
        ) => ReturnType<LiveSyncCouchDBReplicator["fetchRemoteChunks"]>;

        await expect(
            fetchWithSetting.call(replicator, [availableChunk._id, "h:missing"], false, readSetting)
        ).resolves.toEqual([availableChunk]);
        expect(connect).toHaveBeenCalledWith(readSetting, false, false, true);
        expect(allDocs).toHaveBeenCalledWith({
            keys: [availableChunk._id, "h:missing"],
            include_docs: true,
        });
    });

    it("closes its remote database when chunk fetching succeeds or fails", async () => {
        const remoteDatabase = {
            get: vi.fn(async () => ({ _id: VERSIONING_DOCID, type: "versioninfo", version: VER })),
            allDocs: vi.fn().mockResolvedValueOnce({ rows: [] }).mockRejectedValueOnce(new Error("chunk fetch failed")),
        };
        const connectionClose = vi.fn().mockResolvedValue(undefined);
        const replicator = Object.create(LiveSyncCouchDBReplicator.prototype) as LiveSyncCouchDBReplicator;
        replicator.env = {
            services: {
                API: { isMobile: () => false, addLog: Logger },
                context: createServiceContext(),
                setting: { currentSettings: () => ({}) },
            },
        } as unknown as LiveSyncCouchDBReplicator["env"];
        vi.spyOn(replicator, "connectRemoteCouchDBWithSetting").mockResolvedValue({
            db: remoteDatabase,
            close: connectionClose,
        } as never);

        await expect(replicator.fetchRemoteChunks([], false)).resolves.toEqual([]);
        await expect(replicator.fetchRemoteChunks([], false)).rejects.toThrow("chunk fetch failed");

        expect(connectionClose).toHaveBeenCalledTimes(2);
    });
});

describe("E2EE receipt policy failures", () => {
    it.each(["sync", "pullOnly"] as const)("stops %s after a plaintext rejection from requestError", async (mode) => {
        const replicator = createOneShotReplicator({ close: vi.fn(async () => undefined) });
        Object.assign(replicator.env.services, { remote: { hadLastPostFailedBySize: false } });
        const unresolved = new Promise<void>(() => undefined);
        const handler = Object.assign(new EventEmitter(), {
            ...(mode === "sync" ? { pull: new EventEmitter(), push: new EventEmitter() } : {}),
            cancel: vi.fn(),
            then: unresolved.then.bind(unresolved),
        });
        const source = handler.pull ?? handler;
        const log = vi.fn();
        setGlobalLogFunction(log);
        try {
            const result = replicator.processSync(handler as never, false, 0, 0, mode, false);
            source.emit("requestError", {
                name: "UnencryptedContentRejectedError",
                code: "UNENCRYPTED_CONTENT_REJECTED",
                documentId: "h:+blocked",
                contentKind: "chunk",
                message: "Synthetic error text must not be logged wholesale",
            });
            handler.emit("complete", { ok: true });
            await expect(result).resolves.toBe("FAILED");
            expect(handler.cancel).toHaveBeenCalledOnce();
            expect(source.listenerCount("requestError")).toBe(0);
            expect(
                log.mock.calls.some(
                    ([message]) => typeof message === "string" && message.includes("Accept unencrypted content")
                )
            ).toBe(true);
            expect(log.mock.calls.some(([message]) => typeof message === "object")).toBe(false);
        } finally {
            replicator.controller?.abort();
            setGlobalLogFunction(defaultLogger);
        }
    });

    it.each(["requestError", "error"] as const)(
        "retains an unsupported encrypted format in the finite download outcome after %s",
        async (event) => {
            const close = vi.fn(async () => undefined);
            const replicator = createOneShotReplicator({ close });
            const onLocalDatabaseError = vi.fn();
            Object.assign(replicator.env.services.database, { localDatabaseDirect: {}, onLocalDatabaseError });
            Object.assign(replicator.env.services, { remote: { hadLastPostFailedBySize: true } });
            const unresolved = new Promise<void>(() => undefined);
            const handler = Object.assign(new EventEmitter(), {
                cancel: vi.fn(),
                then: unresolved.then.bind(unresolved),
            });
            const error = createError(new UnsupportedEncryptedDocumentFormatError());
            expect(error).not.toBeInstanceOf(UnsupportedEncryptedDocumentFormatError);
            const localDatabase = replicator.rawDatabase as unknown as {
                replicate: { from: ReturnType<typeof vi.fn> };
            };
            localDatabase.replicate.from.mockImplementation(() => {
                queueMicrotask(() => {
                    handler.emit(event, error);
                    handler.emit("complete", { ok: true });
                });
                return handler;
            });

            const outcome = await replicator.replicateAllFromServerWithOutcome({
                useRequestAPI: true,
            } as RemoteDBSettings);
            assert(outcome.status === "failed", "The finite download should fail");
            assert(
                outcome.error instanceof UnsupportedEncryptedDocumentFormatError,
                "The failure should retain its type"
            );
            expect(outcome.error.cause).toBe(error);
            expect(replicator.syncStatus).toBe("ERRORED");
            expect(localDatabase.replicate.from).toHaveBeenCalledOnce();
            expect(handler.cancel).toHaveBeenCalledOnce();
            expect(handler.listenerCount("requestError")).toBe(0);
            expect(close).toHaveBeenCalledOnce();
            expect(onLocalDatabaseError).not.toHaveBeenCalled();
        }
    );

    it("keeps an explicitly stopped one-shot cancelled when a request error arrives", async () => {
        const replicator = createOneShotReplicator({ close: vi.fn(async () => undefined) });
        // Restore the real stop so the controller is aborted before the late request error.
        vi.mocked(replicator.terminateSync).mockImplementation(LiveSyncCouchDBReplicator.prototype.terminateSync);
        const unresolved = new Promise<void>(() => undefined);
        const handler = Object.assign(new EventEmitter(), {
            cancel: vi.fn(),
            then: unresolved.then.bind(unresolved),
        });

        const result = replicator.processSync(handler as never, false, 0, 0, "pullOnly", false, false);
        const stopping = replicator.closeReplication();
        handler.emit("requestError", createError(new UnsupportedEncryptedDocumentFormatError()));
        await stopping;

        await expect(result).resolves.toBe("CANCELLED");
        expect(replicator.syncStatus).toBe("CLOSED");
        expect(handler.cancel).toHaveBeenCalledOnce();
    });

    it("preserves normal transport retry events until replication completes", async () => {
        const replicator = createOneShotReplicator({ close: vi.fn(async () => undefined) });
        const unresolved = new Promise<void>(() => undefined);
        const handler = Object.assign(new EventEmitter(), {
            pull: new EventEmitter(),
            push: new EventEmitter(),
            cancel: vi.fn(),
            then: unresolved.then.bind(unresolved),
        });
        const result = replicator.processSync(handler as never, false, 0, 0, "sync", false);
        handler.pull.emit("requestError", { status: 503, message: "temporary fixture failure" });
        handler.emit("paused");
        handler.emit("active");
        handler.emit("complete", { ok: true });
        await expect(result).resolves.toBe("DONE");
        expect(handler.cancel).toHaveBeenCalledOnce();
        expect(handler.pull.listenerCount("requestError")).toBe(0);
    });
});

describe("managed replication failure notification", () => {
    function fixture() {
        const subject = Object.create(LiveSyncCouchDBReplicator.prototype) as LiveSyncCouchDBReplicator;
        const owner = {} as never;
        const onLocalDatabaseError = vi.fn(() => new Promise<boolean>(() => {}));
        const database = { localDatabaseDirect: owner, onLocalDatabaseError };
        Object.assign(subject, {
            env: { services: { API: { addLog: Logger }, database } },
            abortController: vi.fn(),
            updateInfo: vi.fn(),
        });
        return { subject, owner, database, onLocalDatabaseError };
    }

    it("requests inspection of the captured owner without waiting for recovery", async () => {
        const { subject, owner, onLocalDatabaseError } = fixture();
        const error = { name: "arbitrary failure" };
        expect(subject.replicationErrored(error, owner)).toBeUndefined();
        await Promise.resolve();
        expect(onLocalDatabaseError).toHaveBeenCalledExactlyOnceWith(owner, error);
    });

    it("ignores a retired or absent owner and known remote request failures", async () => {
        const { subject, owner, database, onLocalDatabaseError } = fixture();
        subject.replicationErrored(new RemoteRequestError("request failed"), owner);
        subject.replicationErrored(new Error("no owner"), undefined);
        subject.replicationErrored(new Error("retired operation"), owner);
        database.localDatabaseDirect = {} as never;
        await Promise.resolve();
        expect(onLocalDatabaseError).not.toHaveBeenCalled();
    });
});

describe("replication preparation local database failure notification", () => {
    function preparationFixture() {
        const remote = { close: vi.fn(async () => undefined) };
        const subject = createOneShotReplicator(remote);
        const database = subject.env.services.database;
        Object.assign(subject.env.services.API, { isMobile: () => false });
        Object.assign(subject.env.services, {
            replicator: { runFiniteReplicationActivity: async <T>(task: () => Promise<T>) => await task() },
        });
        const owner = database.localDatabase;
        const onLocalDatabaseError = vi.fn(() => new Promise<boolean>(() => {}));
        Object.assign(database, { localDatabaseDirect: owner, onLocalDatabaseError });
        Object.assign(owner, {
            readFromDatabase: <T>(read: (pouch: typeof owner.localDatabase) => Promise<T>) => read(owner.localDatabase),
        });
        return { subject, remote, database, owner, onLocalDatabaseError };
    }

    it.each(["one-shot", "continuous"])(
        "notifies the owned %s info failure without awaiting recovery",
        async (mode) => {
            const { subject, remote, owner, onLocalDatabaseError } = preparationFixture();
            const error = new Error("Local info failed");
            vi.mocked(owner.localDatabase.info).mockRejectedValueOnce(error);
            if (mode === "continuous") vi.spyOn(operations(subject), "runOneShotReplication").mockResolvedValue(true);
            const operation =
                mode === "one-shot"
                    ? subject.openOneShotReplication({} as RemoteDBSettings, false, false, "sync")
                    : subject.openContinuousReplication({} as RemoteDBSettings, false, false);

            await expect(operation).rejects.toBe(error);
            await Promise.resolve();
            expect(onLocalDatabaseError).toHaveBeenCalledExactlyOnceWith(owner, error);
            expect(remote.close).toHaveBeenCalledOnce();
        }
    );

    it("does not treat a missing local declaration as an IO failure", async () => {
        const { subject, remote, onLocalDatabaseError } = preparationFixture();
        vi.mocked(operations(subject).openReplicationConnection).mockRestore();
        vi.spyOn(operations(subject), "openRemoteCouchDBWithSetting").mockResolvedValue({
            db: remote,
            close: remote.close,
        } as never);
        const settings = {
            couchDB_URI: "https://example.invalid",
            couchDB_DBNAME: "fixture",
            versionUpFlash: "",
            pathNormalizationVersion: 0,
        } as RemoteDBSettings;
        const connection = await subject.checkReplicationConnectivity(settings, false, true, false);
        expect(connection).not.toBe(false);
        await Promise.resolve();
        expect(onLocalDatabaseError).not.toHaveBeenCalled();
        if (connection) await connection.close();
    });

    it("keeps an intentional local path identity rejection separate from an IO failure", async () => {
        const { subject, remote, owner, onLocalDatabaseError } = preparationFixture();
        const document = {
            _id: VERSIONING_DOCID,
            type: "versioninfo",
            version: REMOTE_FEATURE_GENERATION,
            used_features: [NFC_PATH_IDENTITY_FEATURE],
        };
        vi.mocked(owner.localDatabase.get).mockResolvedValueOnce(document as never);
        vi.mocked(operations(subject).openReplicationConnection).mockRestore();
        vi.spyOn(operations(subject), "openRemoteCouchDBWithSetting").mockResolvedValue({
            db: remote,
            close: remote.close,
        } as never);
        const settings = {
            couchDB_URI: "https://example.invalid",
            couchDB_DBNAME: "fixture",
            versionUpFlash: "",
            pathNormalizationVersion: 0,
        } as RemoteDBSettings;

        await expect(subject.checkReplicationConnectivity(settings, false, true, false)).resolves.toBe(false);
        await Promise.resolve();
        expect(onLocalDatabaseError).not.toHaveBeenCalled();
        expect(remote.close).toHaveBeenCalledOnce();
    });

    it.each(["local", "remote"])("attributes the %s path identity failure to its actual source", async (source) => {
        const { subject, remote, owner, onLocalDatabaseError } = preparationFixture();
        const error = new Error("Path identity read failed");
        const remoteGet = vi.fn().mockRejectedValue({ status: 404, name: "not_found" });
        Object.assign(remote, { get: remoteGet });
        if (source === "local") vi.mocked(owner.localDatabase.get).mockRejectedValueOnce(error);
        else remoteGet.mockRejectedValueOnce(error);
        vi.mocked(operations(subject).openReplicationConnection).mockRestore();
        vi.spyOn(operations(subject), "openRemoteCouchDBWithSetting").mockResolvedValue({
            db: remote,
            close: remote.close,
        } as never);
        const settings = {
            couchDB_URI: "https://example.invalid",
            couchDB_DBNAME: "fixture",
            versionUpFlash: "",
        } as RemoteDBSettings;

        await expect(subject.checkReplicationConnectivity(settings, false, true, false)).resolves.toBe(false);
        await Promise.resolve();
        if (source === "local") expect(onLocalDatabaseError).toHaveBeenCalledExactlyOnceWith(owner, error);
        else expect(onLocalDatabaseError).not.toHaveBeenCalled();
        expect(remote.close).toHaveBeenCalledOnce();
    });
});
