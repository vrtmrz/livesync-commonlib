import { describe, expect, it, vi } from "vitest";
import {
    DEFAULT_SYNC_PARAMETERS,
    DEVICE_ID_PREFERRED,
    E2EEAlgorithms,
    MILESTONE_DOCID,
    VER,
    VERSIONING_DOCID,
    type DocumentID,
    type EntryLeaf,
    type RemoteDBSettings,
} from "@lib/common/types.ts";
import { defaultLogger, setGlobalLogFunction } from "@lib/common/logger.ts";
import * as negotiation from "@lib/pouchdb/negotiation.ts";
import { clearHandlers } from "@lib/replication/SyncParamsHandler.ts";
import { createServiceContext } from "@lib/services/base/ServiceBase";
import { LiveSyncCouchDBReplicator } from "./LiveSyncReplicator.ts";
import {
    CENTRAL_COMPATIBILITY_REJECTION_REASONS,
    centralCompatibilityRejected,
} from "@lib/replication/CentralCompatibility.ts";

describe("LiveSyncCouchDBReplicator initialisation", () => {
    it("allows a remote-only connection check before the local database is ready", async () => {
        const getLocalDatabase = vi.fn(() => {
            throw new Error("Local database is not ready yet.");
        });
        const env = {
            services: {
                API: {
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
        const replicator = Object.create(LiveSyncCouchDBReplicator.prototype) as LiveSyncCouchDBReplicator;
        const preferredTweakValue = { customChunkSize: 60 };
        vi.spyOn(replicator, "openOneShotReplication")
            .mockImplementationOnce(async (...args) => {
                args[5]?.(
                    centralCompatibilityRejected(
                        CENTRAL_COMPATIBILITY_REJECTION_REASONS.TWEAK_MISMATCH,
                        preferredTweakValue
                    )
                );
                return false;
            })
            .mockResolvedValueOnce(false);

        await expect(replicator.openOneShotReplicationWithOutcome({} as RemoteDBSettings, false)).resolves.toEqual({
            status: "failed",
            error: expect.any(Error),
            recoveryHint: {
                reason: "tweak-mismatch",
                preferredTweakValue,
            },
        });
        await expect(replicator.openOneShotReplicationWithOutcome({} as RemoteDBSettings, false)).resolves.toEqual({
            status: "failed",
            error: expect.any(Error),
        });
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
                API: { isMobile: () => false },
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
                API: { isMobile: () => false },
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
                API: { isMobile: () => false },
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
        vi.spyOn(replicator, "connectRemoteCouchDBWithSetting").mockResolvedValue("connection failed" as never);

        await expect(replicator.tryResetRemoteDatabase(setting)).rejects.toThrow("connection failed");
    });
});

describe("LiveSyncCouchDBReplicator connection settings", () => {
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

    it("uses the supplied setting's encryption algorithm for the owned connection", async () => {
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
        } as RemoteDBSettings;

        await replicator.connectRemoteCouchDBWithSetting(setting, false, false, true, {
            allowNativeFallback: false,
            encryptionAlgorithm: E2EEAlgorithms.V2,
        });

        expect(connect.mock.calls[0][11]).toEqual({
            allowNativeFallback: false,
            encryptionAlgorithm: E2EEAlgorithms.ForceV1,
        });
    });
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
describe("LiveSyncCouchDBReplicator continuous catch-up", () => {
    it("exposes the initial pull-only catch-up as finite replication activity", async () => {
        const runFiniteReplicationActivity = vi.fn(async <T>(task: () => Promise<T>) => await task());
        const replicator = Object.create(LiveSyncCouchDBReplicator.prototype) as LiveSyncCouchDBReplicator;
        replicator.env = {
            services: {
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
        const catchUp = vi.spyOn(replicator, "openOneShotReplication").mockResolvedValue(false);
        const setting = {} as RemoteDBSettings;

        await expect(replicator.openContinuousReplication(setting, false, false)).resolves.toBe(false);

        expect(runFiniteReplicationActivity).toHaveBeenCalledOnce();
        expect(runFiniteReplicationActivity).toHaveBeenCalledWith(expect.any(Function), { label: "replication" });
        expect(catchUp).toHaveBeenCalledWith(setting, false, false, "pullOnly");
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
        replicator.env = {
            services: {
                context: createServiceContext(),
                database: {
                    localDatabase: { localDatabase },
                },
                replicator: { runFiniteReplicationActivity },
            },
        } as unknown as LiveSyncCouchDBReplicator["env"];
        replicator.docArrived = 0;
        replicator.docSent = 0;
        replicator.updateInfo = vi.fn();
        replicator.terminateSync = vi.fn();
        const catchUp = vi
            .spyOn(replicator, "openOneShotReplication")
            .mockResolvedValueOnce(true)
            .mockImplementationOnce(async () => {
                events.push("restarted");
                return false;
            });
        const connectivity = vi.spyOn(replicator, "checkReplicationConnectivity").mockResolvedValue({
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
        expect(catchUp).toHaveBeenNthCalledWith(1, setting, false, false, "pullOnly");
        expect(catchUp).toHaveBeenNthCalledWith(
            2,
            expect.objectContaining({ batch_size: 12, batches_limit: 12 }),
            false,
            false,
            "pullOnly"
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
        replicator.env = {
            services: {
                context: createServiceContext(),
                database: { localDatabase: { localDatabase } },
                replicator: {
                    runFiniteReplicationActivity: vi.fn(async <T>(task: () => Promise<T>) => await task()),
                },
            },
        } as unknown as LiveSyncCouchDBReplicator["env"];
        replicator.docArrived = 0;
        replicator.docSent = 0;
        replicator.updateInfo = vi.fn();
        replicator.terminateSync = vi.fn();
        vi.spyOn(replicator, "openOneShotReplication").mockResolvedValue(true);
        vi.spyOn(replicator, "checkReplicationConnectivity").mockResolvedValue({
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

function createOneShotReplicator(remoteDatabase: { close: () => Promise<void> }) {
    const localDatabase = {
        info: vi.fn().mockResolvedValue({ update_seq: 7 }),
        sync: vi.fn(() => ({})),
    };
    const replicator = Object.create(LiveSyncCouchDBReplicator.prototype) as LiveSyncCouchDBReplicator;
    replicator.env = {
        services: {
            context: createServiceContext(),
            database: { localDatabase: { localDatabase } },
        },
    } as unknown as LiveSyncCouchDBReplicator["env"];
    replicator.docArrived = 0;
    replicator.docSent = 0;
    replicator.updateInfo = vi.fn();
    replicator.terminateSync = vi.fn();
    vi.spyOn(replicator, "ensurePBKDF2Salt").mockResolvedValue(true);
    vi.spyOn(replicator, "checkReplicationConnectivity").mockResolvedValue({
        db: remoteDatabase,
        info: { update_seq: 9 },
        close: () => remoteDatabase.close(),
        syncOptionBase: {},
    } as never);
    return replicator;
}

describe("LiveSyncCouchDBReplicator one-shot connection ownership", () => {
    it("passes its prepared owned remote database into the transfer before disposal", async () => {
        const missingMilestone = { status: 404 };
        const remoteDatabase = {
            get: vi.fn().mockRejectedValue(missingMilestone),
            put: vi.fn().mockResolvedValue({ ok: true }),
        };
        const connectionClose = vi.fn().mockResolvedValue(undefined);
        const sync = vi.fn(() => ({}));
        const localDatabase = {
            info: vi.fn().mockResolvedValue({ update_seq: 7 }),
            sync,
        };
        const replicator = Object.create(LiveSyncCouchDBReplicator.prototype) as LiveSyncCouchDBReplicator;
        replicator.env = {
            services: {
                API: {
                    getAppVersion: () => "app-version",
                    getPluginVersion: () => "plugin-version",
                    isMobile: () => false,
                },
                context: createServiceContext(),
                database: {
                    localDatabase: { localDatabase },
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
        vi.spyOn(replicator, "ensurePBKDF2Salt").mockResolvedValue(true);
        const connect = vi.spyOn(replicator, "connectRemoteCouchDBWithSetting").mockResolvedValue({
            db: remoteDatabase,
            info: { update_seq: 9 },
            close: connectionClose,
        } as never);
        vi.spyOn(replicator, "processSync").mockResolvedValue("DONE");
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
        const release = Promise.withResolvers<false>();
        vi.mocked(replicator.checkReplicationConnectivity).mockImplementation((...args) => {
            const options = args[5] as { signal?: AbortSignal } | undefined;
            options?.signal?.addEventListener("abort", () => release.resolve(false), { once: true });
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
        release.resolve(false);
        await replication;

        expect(outcome).toBe(false);
        await expect(replicator.openOneShotReplication({} as RemoteDBSettings, false, false, "sync")).resolves.toBe(
            false
        );
        expect(replicator.checkReplicationConnectivity).toHaveBeenCalledTimes(2);
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
        vi.mocked(replicator.checkReplicationConnectivity).mockRestore();
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
                API: { isMobile: () => false },
                remote: { connect },
            },
        } as LiveSyncCouchDBReplicator["env"];
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
        expect((replicator.rawDatabase as { sync: ReturnType<typeof vi.fn> }).sync).not.toHaveBeenCalled();
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
        vi.mocked(replicator.checkReplicationConnectivity).mockImplementation((...args) => {
            preflightSignal = (args[5] as { signal?: AbortSignal } | undefined)?.signal;
            return Promise.resolve({
                db: remoteDatabase,
                info: { update_seq: 9 },
                close: connectionClose,
                syncOptionBase: {},
            } as never);
        });
        vi.spyOn(replicator, "processSync").mockImplementation(async () => {
            await new Promise((resolve) => setTimeout(resolve, 15));
            return "DONE";
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
        vi.mocked(replicator.checkReplicationConnectivity).mockResolvedValue(false);

        await expect(
            replicator.openOneShotReplication({ useRequestAPI: true } as RemoteDBSettings, false, false, "sync")
        ).resolves.toBe(false);

        expect(replicator.checkReplicationConnectivity).toHaveBeenCalledWith(
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
        vi.spyOn(replicator, "processSync").mockResolvedValue(syncResult);

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
                API: { isMobile: () => false },
                context: createServiceContext(),
                database: { localDatabase: { localDatabase } },
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
        const connect = vi.spyOn(replicator, "connectRemoteCouchDBWithSetting").mockImplementation(async () => {
            const db = {
                close: vi.fn().mockResolvedValue(undefined),
                get: vi.fn().mockResolvedValue({ ...DEFAULT_SYNC_PARAMETERS, pbkdf2salt: "AA==" }),
            };
            remoteDatabases.push(db);
            return { db, info: { update_seq: 9 }, close: () => db.close() } as never;
        });
        vi.spyOn(replicator, "checkReplicationConnectivity").mockImplementation(async () => {
            const connection = await replicator.connectRemoteCouchDBWithSetting(setting, false, true);
            if (typeof connection === "string") return false;
            return { ...connection, syncOptionBase: {} } as never;
        });
        vi.spyOn(replicator, "processSync").mockResolvedValue("DONE");

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
        const remoteDatabase = { close: vi.fn().mockResolvedValue(undefined) };
        const replicator = Object.create(LiveSyncCouchDBReplicator.prototype) as LiveSyncCouchDBReplicator;
        replicator.translate = vi.fn((key) => key);
        replicator.isMobile = vi.fn().mockReturnValue(false);
        vi.spyOn(replicator, "connectRemoteCouchDBWithSetting").mockResolvedValue({
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
        const remoteDatabase = { close: vi.fn().mockResolvedValue(undefined) };
        const replicator = Object.create(LiveSyncCouchDBReplicator.prototype) as LiveSyncCouchDBReplicator;
        replicator.translate = vi.fn((key) => key);
        replicator.isMobile = vi.fn().mockReturnValue(false);
        vi.spyOn(replicator, "connectRemoteCouchDBWithSetting").mockResolvedValue({
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
            vi.spyOn(replicator, "processSync").mockResolvedValue(syncResult);
            vi.mocked(replicator.checkReplicationConnectivity)
                .mockResolvedValueOnce({
                    db: remoteDatabase,
                    info: { update_seq: 9 },
                    close: () => remoteDatabase.close(),
                    syncOptionBase: {},
                } as never)
                .mockImplementationOnce(async () => {
                    events.push("restarted");
                    return false;
                });
            const setting = { batch_size: 20, batches_limit: 20 } as RemoteDBSettings;

            await replicator.openOneShotReplication(setting, false, false, "sync");

            expect(events).toEqual(["closed", "restarted"]);
            expect(vi.mocked(replicator.checkReplicationConnectivity).mock.calls[1]?.[2]).toBe(false);
        }
    );

    it("logs a close failure without replacing the replication result", async () => {
        const closeError = new Error("close failed");
        const remoteDatabase = { close: vi.fn().mockRejectedValue(closeError) };
        const replicator = createOneShotReplicator(remoteDatabase);
        vi.spyOn(replicator, "processSync").mockResolvedValue("DONE");
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
        vi.spyOn(replicator, "processSync").mockResolvedValue("NEED_RETRY");
        vi.mocked(replicator.checkReplicationConnectivity)
            .mockResolvedValueOnce({
                db: remoteDatabase,
                info: { update_seq: 9 },
                close: () => remoteDatabase.close(),
                syncOptionBase: {},
            } as never)
            .mockResolvedValueOnce(false);
        const logger = vi.fn();
        setGlobalLogFunction(logger);

        try {
            await replicator.openOneShotReplication(
                { batch_size: 20, batches_limit: 20 } as RemoteDBSettings,
                false,
                false,
                "sync"
            );
            expect(replicator.checkReplicationConnectivity).toHaveBeenCalledTimes(2);
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
        vi.spyOn(replicator, "connectRemoteCouchDBWithSetting").mockResolvedValue({
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
        vi.spyOn(replicator, "connectRemoteCouchDBWithSetting").mockResolvedValue({
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
                API: { isMobile: () => false },
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
                API: { isMobile: () => false },
                context: createServiceContext(),
                database: { localDatabase: { localDatabase } },
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
        vi.spyOn(replicator, "checkReplicationConnectivity").mockResolvedValue(false);
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
                API: { isMobile: () => false },
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
                API: { isMobile: () => false },
                context: createServiceContext(),
                setting: { currentSettings: () => liveSetting },
            },
        } as unknown as LiveSyncCouchDBReplicator["env"];
        const connect = vi.spyOn(replicator, "connectRemoteCouchDBWithSetting").mockResolvedValue({
            db: { allDocs },
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
            allDocs: vi.fn().mockResolvedValueOnce({ rows: [] }).mockRejectedValueOnce(new Error("chunk fetch failed")),
        };
        const connectionClose = vi.fn().mockResolvedValue(undefined);
        const replicator = Object.create(LiveSyncCouchDBReplicator.prototype) as LiveSyncCouchDBReplicator;
        replicator.env = {
            services: {
                API: { isMobile: () => false },
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
