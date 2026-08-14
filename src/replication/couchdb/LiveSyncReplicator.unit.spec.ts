import { describe, expect, it, vi } from "vitest";
import {
    DEVICE_ID_PREFERRED,
    MILESTONE_DOCID,
    VER,
    VERSIONING_DOCID,
    type DocumentID,
    type EntryLeaf,
    type RemoteDBSettings,
} from "@lib/common/types.ts";
import { defaultLogger, setGlobalLogFunction } from "@lib/common/logger.ts";
import * as negotiation from "@lib/pouchdb/negotiation.ts";
import { createServiceContext } from "@lib/services/base/ServiceBase";
import { LiveSyncCouchDBReplicator } from "./LiveSyncReplicator.ts";

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
        vi.spyOn(replicator, "connectRemoteCouchDBWithSetting").mockResolvedValue({
            db: {},
            info: { db_name: "remote" },
        } as never);

        await expect(replicator.tryConnectRemote({} as RemoteDBSettings, false)).resolves.toBe(true);
        expect(getLocalDatabase).not.toHaveBeenCalled();
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
        vi.spyOn(replicator, "connectRemoteCouchDBWithSetting").mockResolvedValue({
            db: { get, close: vi.fn().mockResolvedValue(undefined) },
            info: { db_name: "remote" },
        } as never);
        return replicator;
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
        const replicator = createReplicator(
            createRemoteGet(() => {
                throw missing;
            })
        );

        await expect(replicator.getRemotePreferredTweakValues(setting)).resolves.toEqual({
            status: "not-configured",
            reason: "milestone-missing",
        });
    });

    it("reports a remote read failure as unavailable", async () => {
        const failure = new Error("network failed");
        const replicator = createReplicator(
            createRemoteGet(() => {
                throw failure;
            })
        );

        await expect(replicator.getRemotePreferredTweakValues(setting)).resolves.toEqual({
            status: "unavailable",
            error: failure,
        });
    });

    it("does not treat a missing remote database as an unconfigured milestone", async () => {
        const failure = { status: 404, name: "not_found", message: "Database does not exist" };
        const replicator = createReplicator(createRemoteGet({}));
        vi.mocked(replicator.connectRemoteCouchDBWithSetting).mockRejectedValueOnce(failure);

        await expect(replicator.getRemotePreferredTweakValues(setting)).resolves.toEqual({
            status: "unavailable",
            error: failure,
        });
    });

    it("distinguishes a milestone without preferred values", async () => {
        const replicator = createReplicator(
            createRemoteGet({
                _id: MILESTONE_DOCID,
                tweak_values: {},
            })
        );

        await expect(replicator.getRemotePreferredTweakValues(setting)).resolves.toEqual({
            status: "not-configured",
            reason: "preferred-values-missing",
        });
    });

    it("returns available preferred values explicitly", async () => {
        const values = { encrypt: true };
        const replicator = createReplicator(
            createRemoteGet({
                _id: MILESTONE_DOCID,
                tweak_values: { [DEVICE_ID_PREFERRED]: values },
            })
        );

        await expect(replicator.getRemotePreferredTweakValues(setting)).resolves.toEqual({
            status: "available",
            values,
        });
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
        vi.spyOn(replicator, "checkReplicationConnectivity").mockResolvedValue({
            db: remoteDatabase,
            info: { update_seq: 9 },
            syncOption: {},
        } as never);
        vi.spyOn(replicator, "processSync").mockResolvedValue("NEED_RETRY");
        const setting = {
            batch_size: 20,
            batches_limit: 20,
        } as RemoteDBSettings;

        await expect(replicator.openContinuousReplication(setting, false, false)).resolves.toBe(false);

        expect(runFiniteReplicationActivity).toHaveBeenCalledTimes(2);
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
        syncOptionBase: {},
    } as never);
    return replicator;
}

describe("LiveSyncCouchDBReplicator one-shot connection ownership", () => {
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

    it("closes a connection when connectivity checks cannot transfer ownership", async () => {
        const remoteDatabase = { close: vi.fn().mockResolvedValue(undefined) };
        const replicator = Object.create(LiveSyncCouchDBReplicator.prototype) as LiveSyncCouchDBReplicator;
        replicator.translate = vi.fn((key) => key);
        replicator.isMobile = vi.fn().mockReturnValue(false);
        vi.spyOn(replicator, "connectRemoteCouchDBWithSetting").mockResolvedValue({
            db: remoteDatabase,
            info: { update_seq: 9 },
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

    it.each(["NEED_RETRY", "NEED_RESURRECT"] as const)("waits for close before %s starts", async (syncResult) => {
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
                syncOptionBase: {},
            } as never)
            .mockImplementationOnce(async () => {
                events.push("restarted");
                return false;
            });
        const setting = { batch_size: 20, batches_limit: 20 } as RemoteDBSettings;

        await replicator.openOneShotReplication(setting, false, false, "sync");

        expect(events).toEqual(["closed", "restarted"]);
    });

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
            close: vi.fn().mockResolvedValue(undefined),
        };
        const replicator = Object.create(LiveSyncCouchDBReplicator.prototype) as LiveSyncCouchDBReplicator;
        replicator.isMobile = vi.fn().mockReturnValue(false);
        vi.spyOn(replicator, "connectRemoteCouchDBWithSetting").mockResolvedValue({ db: remoteDatabase } as never);

        const result = replicator.fetchRemoteDocument({} as RemoteDBSettings, "sync-params");
        if (error && "status" in error && error.status === 404) {
            await expect(result).resolves.toBe(false);
        } else if (error) {
            await expect(result).rejects.toBe(error);
        } else {
            await expect(result).resolves.toBe(expected);
        }

        expect(remoteDatabase.close).toHaveBeenCalledOnce();
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
            close: vi.fn().mockResolvedValue(undefined),
        };
        const replicator = Object.create(LiveSyncCouchDBReplicator.prototype) as LiveSyncCouchDBReplicator;
        replicator.isMobile = vi.fn().mockReturnValue(false);
        vi.spyOn(replicator, "connectRemoteCouchDBWithSetting").mockResolvedValue({ db: remoteDatabase } as never);

        const result = replicator.putRemoteDocument({} as RemoteDBSettings, { _id: "sync-params" } as never);
        if (error) {
            await expect(result).rejects.toBe(error);
        } else {
            await expect(result).resolves.toBe(response);
        }

        expect(remoteDatabase.close).toHaveBeenCalledOnce();
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

    function createReplicator(remoteDatabase: Record<string, unknown>) {
        const replicator = Object.create(LiveSyncCouchDBReplicator.prototype) as LiveSyncCouchDBReplicator;
        replicator.env = {
            services: {
                API: { isMobile: () => false },
                context: createServiceContext(),
                setting: { currentSettings: () => setting },
            },
        } as unknown as LiveSyncCouchDBReplicator["env"];
        replicator.nodeid = "node";
        vi.spyOn(replicator, "connectRemoteCouchDBWithSetting").mockResolvedValue({
            db: remoteDatabase,
            info: { db_name: "remote" },
        } as never);
        return replicator;
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
        const replicator = createReplicator(remoteDatabase);

        await run(replicator);

        expect(remoteDatabase.close).toHaveBeenCalledOnce();
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
        const replicator = createReplicator(remoteDatabase);

        await replicator.getRemotePreferredTweakValues(setting);

        expect(remoteDatabase.close).toHaveBeenCalledOnce();
    });

    it("logs a close failure without replacing a finite operation result", async () => {
        const closeError = new Error("close failed");
        const remoteDatabase = {
            compact: vi.fn().mockResolvedValue({ ok: true }),
            close: vi.fn().mockRejectedValue(closeError),
        };
        const replicator = createReplicator(remoteDatabase);
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

describe("LiveSyncCouchDBReplicator chunk sending connection ownership", () => {
    it("closes only the connection it creates when sending fails", async () => {
        const remoteDatabase = {
            get: vi.fn().mockRejectedValue(new Error("milestone failed")),
            close: vi.fn().mockResolvedValue(undefined),
        };
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
        vi.spyOn(replicator, "connectRemoteCouchDBWithSetting").mockResolvedValue({ db: remoteDatabase } as never);

        await expect(replicator.sendChunks({} as RemoteDBSettings, undefined, false)).rejects.toThrow(
            "milestone failed"
        );
        expect(remoteDatabase.close).toHaveBeenCalledOnce();

        await expect(replicator.sendChunks({} as RemoteDBSettings, remoteDatabase as never, false)).rejects.toThrow(
            "milestone failed"
        );

        expect(remoteDatabase.close).toHaveBeenCalledOnce();
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
        replicator.env = {
            services: {
                API: { isMobile: () => false },
                context: createServiceContext(),
                setting: { currentSettings: () => ({}) },
            },
        } as unknown as LiveSyncCouchDBReplicator["env"];
        vi.spyOn(replicator, "connectRemoteCouchDBWithSetting").mockResolvedValue({
            db: { allDocs },
        } as never);

        await expect(replicator.fetchRemoteChunks([availableChunk._id, "h:missing"], false)).resolves.toEqual([
            availableChunk,
        ]);
        expect(allDocs).toHaveBeenCalledWith({
            keys: [availableChunk._id, "h:missing"],
            include_docs: true,
        });
    });

    it("closes its remote database when chunk fetching succeeds or fails", async () => {
        const remoteDatabase = {
            allDocs: vi.fn().mockResolvedValueOnce({ rows: [] }).mockRejectedValueOnce(new Error("chunk fetch failed")),
            close: vi.fn().mockResolvedValue(undefined),
        };
        const replicator = Object.create(LiveSyncCouchDBReplicator.prototype) as LiveSyncCouchDBReplicator;
        replicator.env = {
            services: {
                API: { isMobile: () => false },
                context: createServiceContext(),
                setting: { currentSettings: () => ({}) },
            },
        } as unknown as LiveSyncCouchDBReplicator["env"];
        vi.spyOn(replicator, "connectRemoteCouchDBWithSetting").mockResolvedValue({ db: remoteDatabase } as never);

        await expect(replicator.fetchRemoteChunks([], false)).resolves.toEqual([]);
        await expect(replicator.fetchRemoteChunks([], false)).rejects.toThrow("chunk fetch failed");

        expect(remoteDatabase.close).toHaveBeenCalledTimes(2);
    });
});
