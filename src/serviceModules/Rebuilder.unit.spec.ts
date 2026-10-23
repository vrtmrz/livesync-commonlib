import { describe, expect, it, vi } from "vitest";
import { REMOTE_COUCHDB, REMOTE_MINIO, REMOTE_P2P } from "@lib/common/models/setting.const";
import { FlagFilesHumanReadable } from "@lib/common/models/redflag.const";
import { ServiceRebuilder } from "./Rebuilder";
import { createLiveSyncEventHub } from "@lib/hub/hub";
import { EVENT_DATABASE_REBUILT } from "@lib/events/coreEvents";
import { REMOTE_RESOURCE_KINDS } from "@lib/replication";
import { VERSIONING_DOCID } from "@lib/common/types";
import PouchDB from "pouchdb-core";
import MemoryAdapter from "pouchdb-adapter-memory";
import { DEFAULT_SETTINGS, type EntryDoc } from "@lib/common/types";
import { LiveSyncLocalDB } from "@lib/pouchdb/LiveSyncLocalDB";
import { PathServiceCompat } from "@lib/services/implements/injectable/InjectablePathService";
import { ServiceContext } from "@lib/services/base/ServiceBase";
import type { ISettingService } from "@lib/services/base/IService";
import {
    composedPath,
    decomposedPath,
    pathIdentityDeletionCases,
    seedPathIdentityDeletionCase,
} from "../../test/pathIdentityDeletionCases";

PouchDB.plugin(MemoryAdapter);

const fetchChangesForInitialSyncMock = vi.hoisted(() => vi.fn());
const checkRemoteFeaturesForInitialSyncMock = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("@lib/pouchdb/StreamingFetch", () => ({
    fetchChangesForInitialSync: fetchChangesForInitialSyncMock,
    checkRemoteFeaturesForInitialSync: checkRemoteFeaturesForInitialSyncMock,
    isRetryableStreamingFetchFailure: (error: unknown) =>
        Boolean((error as { retryable?: boolean } | undefined)?.retryable),
}));

vi.mock("octagonal-wheels/promises", async (importOriginal) => {
    const original = (await importOriginal()) as Record<string, unknown>;
    return {
        ...original,
        delay: vi.fn(async () => undefined),
    };
});

function createRebuilder(initialDatabaseSuffix = "") {
    const smallConfig = new Map<string, string>();
    const settings = {
        isConfigured: true,
        additionalSuffixOfDatabaseName: initialDatabaseSuffix,
        remoteType: REMOTE_COUCHDB,
        couchDB_URI: "https://example.com",
        couchDB_DBNAME: "db",
        couchDB_USER: "user",
        couchDB_PASSWORD: "pass",
        couchDB_CustomHeaders: "",
        useRequestAPI: false,
        useJWT: false,
        passphrase: "",
        E2EEAlgorithm: "",
        doNotSuspendOnFetching: false,
        suspendFileWatching: true,
        suspendParseReplicationResult: true,
    } as any;
    const remoteDB = {
        get: vi.fn(async () => ({ _id: VERSIONING_DOCID, type: "versioninfo", version: 12 })),
        allDocs: vi.fn(async () => ({ rows: [] })),
        info: vi.fn(async () => ({ doc_count: 0 })),
    };
    const localDB = {
        get: vi.fn().mockRejectedValue({ status: 404, name: "not_found" }),
        info: vi.fn(async () => ({ doc_count: 1 })),
        allDocs: vi.fn(async () => ({ total_rows: 1 })),
    };
    const activityFinished = vi.fn();
    let activeDatabaseSuffix = initialDatabaseSuffix;
    const resetDatabaseTargets: string[] = [];
    const runBoundedRemoteActivity = vi.fn(async (task: () => unknown) => {
        try {
            return await task();
        } finally {
            activityFinished();
        }
    });
    const services = {
        events: createLiveSyncEventHub(),
        API: {
            addLog: vi.fn(),
            getAppID: vi.fn(() => "app"),
            isMobile: vi.fn(() => false),
        },
        setting: {
            currentSettings: vi.fn(() => settings),
            suspendExtraSync: vi.fn(async () => undefined),
            suspendAllSync: { addHandler: vi.fn() },
            applyPartial: vi.fn(async (partial: any) => {
                Object.assign(settings, partial);
            }),
            saveSettingData: vi.fn(async () => undefined),
            getSmallConfig: vi.fn(
                (key: string) => smallConfig.get(`${settings.additionalSuffixOfDatabaseName}-${key}`) ?? ""
            ),
            setSmallConfig: vi.fn((key: string, value: string) => {
                smallConfig.set(`${settings.additionalSuffixOfDatabaseName}-${key}`, value);
            }),
            deleteSmallConfig: vi.fn((key: string) => {
                smallConfig.delete(`${settings.additionalSuffixOfDatabaseName}-${key}`);
            }),
        },
        control: {
            applySettings: vi.fn(async () => undefined),
        },
        database: {
            onDatabaseReset: { addHandler: vi.fn() },
            resetDatabase: vi.fn(async () => {
                resetDatabaseTargets.push(activeDatabaseSuffix);
                return true;
            }),
            resetDatabaseForCurrentSettings: vi.fn(async () => {
                activeDatabaseSuffix = settings.additionalSuffixOfDatabaseName;
                resetDatabaseTargets.push(activeDatabaseSuffix);
                return true;
            }),
            openDatabase: vi.fn(async () => {
                activeDatabaseSuffix = settings.additionalSuffixOfDatabaseName;
                return true;
            }),
            isDatabaseReady: vi.fn(() => true),
            localDatabase: { localDatabase: localDB, findAllDocs: vi.fn(async function* () {}) },
        },
        databaseEvents: {
            initialiseDatabase: vi.fn(async () => undefined),
            onDatabaseInitialised: vi.fn(async () => true),
        },
        replicator: {
            getActiveReplicator: vi.fn(() => ({
                getReplicationPBKDF2Salt: vi.fn(async () => "salt"),
                tryResetRemoteDatabase: vi.fn(async () => undefined),
            })),
            getNewReplicator: vi.fn(),
            createRemoteResource: vi.fn(async (kind: string) =>
                kind === REMOTE_RESOURCE_KINDS.SECURITY_SEED
                    ? {
                          read: vi.fn(async () => new Uint8Array([1])),
                          dispose: vi.fn(async () => undefined),
                      }
                    : undefined
            ),
            runBoundedRemoteActivity,
        },
        replication: {
            markResolved: vi.fn(async () => undefined),
            markLocked: vi.fn(async () => undefined),
            replicateAllToRemote: vi.fn(async () => true),
            replicateAllFromRemote: vi.fn(async () => true),
            replicateAllToRemoteForRebuild: vi.fn(async () => true),
            replicateAllFromRemoteForRebuild: vi.fn(async () => true),
            onBeforeReplicate: vi.fn(async () => true),
        },
        appLifecycle: {
            resetIsReady: vi.fn(),
            markIsReady: vi.fn(),
            performRestart: vi.fn(),
            setSuspended: vi.fn(),
        },
        UI: {
            showMarkdownDialog: vi.fn(async () => "OK"),
            confirm: {
                askSelectStringDialogue: vi.fn(async () => "Cancel operation"),
            },
        },
        remote: {
            connect: vi.fn(async () => ({ db: remoteDB, close: vi.fn(async () => undefined) })),
        },
        storageAccess: {
            getFileNames: vi.fn(async () => [] as string[]),
            clearTouched: vi.fn(),
            writeFileAuto: vi.fn(async () => undefined),
            delete: vi.fn(async () => undefined),
        },
        vault: {
            scanVault: vi.fn(async () => true),
            isTargetFile: vi.fn(async () => true),
        },
        path: {
            path2id: vi.fn(async (path: string) =>
                settings.pathNormalizationVersion === 1 ? path.normalize("NFC").toLowerCase() : path.toLowerCase()
            ),
        },
        fileProcessing: {
            commitPendingFileEvents: vi.fn(async () => true),
        },
        fileHandler: {
            createAllChunks: vi.fn(async () => undefined),
        },
    };

    return {
        rebuilder: new ServiceRebuilder(services as any),
        services,
        settings,
        activityFinished,
        runBoundedRemoteActivity,
        resetDatabaseTargets,
        remoteDB,
    };
}

let deletionDatabaseSequence = 0;

describe.each(["Rebuild", "Standard Fetch", "Fast Fetch"] as const)(
    "NFC Metadata deletion preflight: %s",
    (operation) => {
        it.each(pathIdentityDeletionCases)("handles $name before local database replacement", async (scenario) => {
            const { rebuilder, services, settings, remoteDB } = createRebuilder();
            settings.pathNormalizationVersion = 1;
            const pathService = new PathServiceCompat(new ServiceContext(), {
                settingService: {
                    currentSettings: () => ({
                        ...DEFAULT_SETTINGS,
                        ...settings,
                        handleFilenameCaseSensitive: false,
                        encrypt: false,
                        usePathObfuscation: false,
                    }),
                } as ISettingService,
            });
            services.path.path2id = vi.fn(pathService.path2id.bind(pathService)) as never;
            const database = new PouchDB<EntryDoc>(`path-identity-deletion-${++deletionDatabaseSequence}`, {
                adapter: "memory",
            });
            try {
                await seedPathIdentityDeletionCase(database, scenario);
                const subject = Object.create(LiveSyncLocalDB.prototype) as LiveSyncLocalDB;
                Object.assign(subject, { localDatabase: database });
                services.database.localDatabase = subject as never;
                services.storageAccess.getFileNames.mockResolvedValue(
                    scenario.name.startsWith("both ") ? [] : [composedPath]
                );
                remoteDB.get.mockResolvedValue({
                    _id: VERSIONING_DOCID,
                    type: "versioninfo",
                    version: 13,
                    used_features: ["nfc-path-identity-v1"],
                } as never);

                const enumerated: EntryDoc[] = [];
                for await (const entry of subject.findAllDocs()) enumerated.push(entry);
                expect(enumerated).toHaveLength(scenario.count);
                if (scenario.name === "CouchDB tombstone") {
                    expect(enumerated.map((entry) => entry._id)).toEqual([composedPath]);
                    const leaves = await database.get(decomposedPath, { open_revs: "all" });
                    expect(leaves).toEqual([
                        expect.objectContaining({ ok: expect.objectContaining({ _deleted: true }) }),
                    ]);
                }
                if (scenario.name.startsWith("logically deleted winner")) {
                    expect(await database.get(decomposedPath, { conflicts: true })).toMatchObject({
                        deleted: true,
                        _conflicts: ["2-aaaa"],
                    });
                    expect(enumerated.find((entry) => entry._id === decomposedPath)).not.toHaveProperty("_conflicts");
                }

                const before = await database.info();
                const resetBoundary = new Error("Reached the local database replacement boundary");
                services.database.resetDatabaseForCurrentSettings.mockRejectedValueOnce(resetBoundary);
                const invocation =
                    operation === "Rebuild"
                        ? rebuilder.rebuildEverything()
                        : operation === "Standard Fetch"
                          ? rebuilder.fetchLocal()
                          : rebuilder.fetchLocalDBFast(false);
                if (scenario.expectedCollision) {
                    await expect(invocation).rejects.toThrow(/File path identity collision/);
                    expect(services.database.resetDatabaseForCurrentSettings).not.toHaveBeenCalled();
                } else {
                    await expect(invocation).rejects.toBe(resetBoundary);
                    expect(services.database.resetDatabaseForCurrentSettings).toHaveBeenCalledTimes(1);
                }
                expect(services.replication.markLocked).not.toHaveBeenCalled();
                expect(services.replication.replicateAllToRemoteForRebuild).not.toHaveBeenCalled();
                expect((await database.info()).update_seq).toBe(before.update_seq);
            } finally {
                await database.destroy();
            }
        });
    }
);

describe("ServiceRebuilder scheduled restart flags", () => {
    it.each([
        ["Fetch", "scheduleFetch", FlagFilesHumanReadable.FETCH_ALL],
        ["Rebuild", "scheduleRebuild", FlagFilesHumanReadable.REBUILD_ALL],
    ] as const)("writes the %s flag and prepares state before requesting a restart", async (_name, method, flag) => {
        const { rebuilder, services } = createRebuilder();
        const prepare = vi.fn(async () => undefined);

        await expect(rebuilder[method](prepare)).resolves.toBe(true);

        expect(services.storageAccess.writeFileAuto).toHaveBeenCalledWith(flag, "");
        expect(services.storageAccess.writeFileAuto.mock.invocationCallOrder[0]).toBeLessThan(
            services.appLifecycle.setSuspended.mock.invocationCallOrder[0]
        );
        expect(services.appLifecycle.setSuspended).toHaveBeenCalledWith(true);
        expect(services.appLifecycle.setSuspended.mock.invocationCallOrder[0]).toBeLessThan(
            prepare.mock.invocationCallOrder[0]
        );
        expect(prepare.mock.invocationCallOrder[0]).toBeLessThan(
            services.appLifecycle.performRestart.mock.invocationCallOrder[0]
        );
    });

    it.each([
        ["Fetch", "scheduleFetch"],
        ["Rebuild", "scheduleRebuild"],
    ] as const)("does not restart when the %s flag cannot be written", async (_name, method) => {
        const { rebuilder, services } = createRebuilder();
        services.storageAccess.writeFileAuto.mockRejectedValueOnce(new Error("read-only Vault"));

        await expect(rebuilder[method]()).resolves.toBe(false);

        expect(services.appLifecycle.setSuspended).not.toHaveBeenCalled();
        expect(services.appLifecycle.performRestart).not.toHaveBeenCalled();
    });

    it.each([
        ["Fetch", "scheduleFetch", FlagFilesHumanReadable.FETCH_ALL],
        ["Rebuild", "scheduleRebuild", FlagFilesHumanReadable.REBUILD_ALL],
    ] as const)("cleans up the %s flag when preparation fails", async (_name, method, flag) => {
        const { rebuilder, services } = createRebuilder();
        const error = new Error("settings could not be saved");

        await expect(rebuilder[method](async () => Promise.reject(error))).rejects.toBe(error);

        expect(services.storageAccess.delete).toHaveBeenCalledWith(flag, true);
        expect(services.appLifecycle.setSuspended).toHaveBeenNthCalledWith(1, true);
        expect(services.appLifecycle.setSuspended).toHaveBeenNthCalledWith(2, false);
        expect(services.appLifecycle.performRestart).not.toHaveBeenCalled();
    });
});

describe("ServiceRebuilder NFC path preflight", () => {
    it("does not resume a Fast Fetch checkpoint from a different path identity mode", () => {
        const { rebuilder, settings } = createRebuilder();
        (rebuilder as any).saveFastFetchCheckpoint("https://example.com/db", "legacy-sequence");
        settings.pathNormalizationVersion = 1;

        expect((rebuilder as any).getFastFetchCheckpoint("https://example.com/db")).toBeUndefined();
    });

    it("rejects a remote-only rebuild before reset if local Metadata still uses legacy identity", async () => {
        const { rebuilder, services, settings } = createRebuilder();
        settings.pathNormalizationVersion = 1;
        Object.assign(services.database.localDatabase.localDatabase, {
            get: vi.fn().mockRejectedValue({ status: 404, name: "not_found" }),
            allDocs: vi.fn().mockResolvedValue({
                rows: [
                    {
                        id: "note.md",
                        doc: {
                            _id: "note.md",
                            path: "note.md",
                            type: "plain",
                        },
                    },
                ],
            }),
        });

        await expect(rebuilder.rebuildRemote()).rejects.toThrow(/path identity/);

        expect(services.replication.markLocked).not.toHaveBeenCalled();
        expect(services.replication.replicateAllToRemote).not.toHaveBeenCalled();
    });

    it("keeps logically deleted Metadata in the remote-only path identity check", async () => {
        const { rebuilder, services, settings } = createRebuilder();
        settings.pathNormalizationVersion = 1;
        services.database.localDatabase.localDatabase.get = vi.fn(async () => ({
            _id: VERSIONING_DOCID,
            type: "versioninfo",
            version: 13,
            used_features: ["nfc-path-identity-v1"],
        })) as never;
        services.database.localDatabase.findAllDocs = vi.fn(async function* () {
            yield {
                _id: decomposedPath,
                path: decomposedPath,
                deleted: true,
                _conflicts: [],
            };
        }) as never;

        await expect(rebuilder.rebuildRemote()).rejects.toThrow(/stored document ID/);

        expect(services.replication.markLocked).not.toHaveBeenCalled();
        expect(services.replication.replicateAllToRemote).not.toHaveBeenCalled();
    });

    it("refuses to merge separate Metadata documents when rebuilding", async () => {
        const { rebuilder, services, settings } = createRebuilder();
        settings.pathNormalizationVersion = 1;
        services.database.localDatabase.findAllDocs = vi.fn(async function* () {
            yield { _id: "caf\u00e9.md", path: "Caf\u00e9.md" };
            yield { _id: "cafe\u0301.md", path: "Cafe\u0301.md" };
        }) as never;

        await expect(rebuilder.rebuildEverything()).rejects.toThrow(/collision/i);

        expect(services.database.resetDatabaseForCurrentSettings).not.toHaveBeenCalled();
        expect(services.replication.markLocked).not.toHaveBeenCalled();
    });

    it("checks remote path identity before Standard Fetch resets local data", async () => {
        const { rebuilder, services, remoteDB } = createRebuilder();
        remoteDB.get.mockResolvedValueOnce({
            _id: VERSIONING_DOCID,
            type: "versioninfo",
            version: 13,
            used_features: ["nfc-path-identity-v1"],
        } as never);

        await expect(rebuilder.fetchLocal()).rejects.toThrow(/path identity/);

        expect(services.database.resetDatabaseForCurrentSettings).not.toHaveBeenCalled();
        expect(services.replication.markResolved).not.toHaveBeenCalled();
    });

    it("checks storage collisions without waiting for an unopened database", async () => {
        const { rebuilder, services, settings } = createRebuilder();
        settings.pathNormalizationVersion = 1;
        services.database.isDatabaseReady.mockReturnValue(false);
        services.storageAccess.getFileNames.mockResolvedValue(["Caf\u00e9.md", "Cafe\u0301.md"]);
        services.vault.isTargetFile.mockImplementation(async () => {
            throw new Error("database not ready");
        });

        await expect(rebuilder.rebuildEverything()).rejects.toThrow(/collision/i);
        expect(services.vault.isTargetFile).not.toHaveBeenCalled();
        expect(services.database.resetDatabaseForCurrentSettings).not.toHaveBeenCalled();
    });

    it("preserves both databases when two storage paths have one NFC identity", async () => {
        const { rebuilder, services, settings } = createRebuilder();
        settings.pathNormalizationVersion = 1;
        services.storageAccess.getFileNames.mockResolvedValue(["Caf\u00e9/note.md", "Cafe\u0301/note.md"]);

        await expect(rebuilder.rebuildEverything()).rejects.toThrow(/collision/i);

        expect(services.database.resetDatabaseForCurrentSettings).not.toHaveBeenCalled();
        expect(services.replication.markLocked).not.toHaveBeenCalled();
        expect(services.setting.suspendExtraSync).not.toHaveBeenCalled();
    });

    it("keeps version 0 reconstruction outside the NFC path preflight", async () => {
        const { rebuilder, services, settings } = createRebuilder();
        settings.pathNormalizationVersion = 0;
        const resetBoundary = new Error("Reached the local database replacement boundary");
        services.database.resetDatabaseForCurrentSettings.mockRejectedValueOnce(resetBoundary);

        await expect(rebuilder.rebuildEverything()).rejects.toBe(resetBoundary);

        expect(services.storageAccess.getFileNames).not.toHaveBeenCalled();
        expect(services.database.resetDatabaseForCurrentSettings).toHaveBeenCalledTimes(1);
    });

    it.each([REMOTE_MINIO, REMOTE_P2P])(
        "refuses NFC reconstruction for unsupported transport %s",
        async (remoteType) => {
            const { rebuilder, services, settings } = createRebuilder();
            settings.pathNormalizationVersion = 1;
            settings.remoteType = remoteType;

            await expect(rebuilder.rebuildEverything()).rejects.toThrow(/CouchDB/);

            expect(services.database.resetDatabaseForCurrentSettings).not.toHaveBeenCalled();
            expect(services.replication.markLocked).not.toHaveBeenCalled();
        }
    );

    it("refuses Standard Fetch before resetting local data when storage identities collide", async () => {
        const { rebuilder, services, settings } = createRebuilder();
        settings.pathNormalizationVersion = 1;
        services.storageAccess.getFileNames.mockResolvedValue(["Caf\u00e9.md", "Cafe\u0301.md"]);

        await expect(rebuilder.fetchLocal()).rejects.toThrow(/collision/i);

        expect(services.database.resetDatabaseForCurrentSettings).not.toHaveBeenCalled();
        expect(services.replication.markResolved).not.toHaveBeenCalled();
    });
});

describe("ServiceRebuilder event isolation", () => {
    it.each(["", "previous-device"])(
        "resets only the database selected by the new device suffix when the former suffix is %j",
        async (formerSuffix) => {
            const { rebuilder, resetDatabaseTargets } = createRebuilder(formerSuffix);

            await rebuilder.resetLocalDatabase();

            expect(resetDatabaseTargets).toEqual(["app"]);
        }
    );

    it("does not announce a reset which the database service could not complete", async () => {
        const { rebuilder, services } = createRebuilder("previous-device");
        const listener = vi.fn();
        services.events.onEvent(EVENT_DATABASE_REBUILT, listener);
        services.database.resetDatabaseForCurrentSettings.mockResolvedValueOnce(false);

        await expect(rebuilder.resetLocalDatabase()).rejects.toThrow(
            "The local database selected by the current settings could not be reset."
        );

        expect(listener).not.toHaveBeenCalled();
    });

    it("announces a database reset through its injected event hub", async () => {
        const { rebuilder, services } = createRebuilder();
        const listener = vi.fn();
        services.events.onEvent(EVENT_DATABASE_REBUILT, listener);

        await rebuilder.resetLocalDatabase();

        expect(listener).toHaveBeenCalledOnce();
    });
});

describe("ServiceRebuilder fast fetch admission", () => {
    it.each([false, true])("rejects unknown features before changing the local database (resume: %s)", async (resume) => {
        const { rebuilder, services } = createRebuilder();
        if (resume) {
            (rebuilder as any).saveFastFetchCheckpoint("https://example.com/db", "previous-sequence");
        }
        fetchChangesForInitialSyncMock.mockReset().mockResolvedValue(undefined);
        const rejection = new Error("Unknown features are in use: future-feature");
        checkRemoteFeaturesForInitialSyncMock.mockRejectedValueOnce(rejection);

        await expect(rebuilder.$fetchLocalDBFast(false)).rejects.toBe(rejection);

        expect(services.appLifecycle.resetIsReady).not.toHaveBeenCalled();
        expect(services.database.resetDatabaseForCurrentSettings).not.toHaveBeenCalled();
        expect(services.database.resetDatabase).not.toHaveBeenCalled();
        expect(services.database.openDatabase).not.toHaveBeenCalled();
        expect(fetchChangesForInitialSyncMock).not.toHaveBeenCalled();
        expect(services.replication.markResolved).not.toHaveBeenCalled();
        expect(services.setting.deleteSmallConfig).not.toHaveBeenCalled();
    });
});

describe("ServiceRebuilder fast fetch retry", () => {
    it("retries from the latest checkpoint after a transient fast fetch failure", async () => {
        const { rebuilder, runBoundedRemoteActivity } = createRebuilder();

        fetchChangesForInitialSyncMock
            .mockImplementationOnce(async (...args: any[]) => {
                await args[6]("10-g1");
                throw Object.assign(new Error("network changed"), {
                    stage: "transport",
                    retryable: true,
                });
            })
            .mockResolvedValueOnce(undefined);

        await rebuilder.$fetchLocalDBFast(false);

        expect(fetchChangesForInitialSyncMock).toHaveBeenCalledTimes(2);
        expect(fetchChangesForInitialSyncMock.mock.calls[0][4]).toBe("0");
        expect(fetchChangesForInitialSyncMock.mock.calls[1][4]).toBe("10-g1");
        expect(runBoundedRemoteActivity).toHaveBeenCalledWith(expect.any(Function), {
            label: "fast-fetch",
        });
    });

    it("does not retry a terminal fast fetch failure or finalise the local database", async () => {
        fetchChangesForInitialSyncMock.mockReset().mockRejectedValue(
            Object.assign(new Error("cannot decrypt remote document"), {
                stage: "decryption",
                retryable: false,
            })
        );
        const { rebuilder, services } = createRebuilder();

        await expect(rebuilder.$fetchLocalDBFast(true)).rejects.toThrow("cannot decrypt remote document");

        expect(fetchChangesForInitialSyncMock).toHaveBeenCalledOnce();
        expect(services.replication.markResolved).not.toHaveBeenCalled();
        expect(services.vault.scanVault).not.toHaveBeenCalled();
        expect(services.setting.deleteSmallConfig).not.toHaveBeenCalledWith("fast-fetch-checkpoint");
    });

    it("keeps reflection resumption and checkpoint removal inside a successful fast-fetch activity", async () => {
        fetchChangesForInitialSyncMock.mockReset().mockResolvedValue(undefined);
        const { rebuilder, services, activityFinished } = createRebuilder();

        await rebuilder.$fetchLocalDBFast(true);

        expect(services.vault.scanVault).toHaveBeenCalledWith(true);
        expect(services.setting.deleteSmallConfig).toHaveBeenCalledWith("fast-fetch-checkpoint");
        expect(services.vault.scanVault.mock.invocationCallOrder[0]).toBeLessThan(
            services.setting.deleteSmallConfig.mock.invocationCallOrder[0]
        );
        expect(services.setting.deleteSmallConfig.mock.invocationCallOrder[0]).toBeLessThan(
            activityFinished.mock.invocationCallOrder[0]
        );
    });

    it("forwards the configured CouchDB custom headers to the fast fetch", async () => {
        fetchChangesForInitialSyncMock.mockReset().mockResolvedValue(undefined);
        const { rebuilder, settings } = createRebuilder();
        settings.couchDB_CustomHeaders = "CF-Access-Client-Id: client-id\nCF-Access-Client-Secret: client-secret";

        await rebuilder.$fetchLocalDBFast(false);

        expect(fetchChangesForInitialSyncMock.mock.calls[0][7]).toEqual({
            "CF-Access-Client-Id": "client-id",
            "CF-Access-Client-Secret": "client-secret",
        });
    });
});

describe("ServiceRebuilder fast fetch resource ownership", () => {
    function enableHandoff(services: ReturnType<typeof createRebuilder>["services"]) {
        const session = {
            recordStoredRevisions: vi.fn(),
            recordCheckpoint: vi.fn(),
            fastForward: vi.fn(async () => true),
        };
        const resource = { prepare: vi.fn(async () => session), dispose: vi.fn(async () => undefined) };
        const original = services.replicator.createRemoteResource.getMockImplementation()!;
        services.replicator.createRemoteResource.mockImplementation(async (kind: string) =>
            kind === REMOTE_RESOURCE_KINDS.INITIAL_FETCH_FAST_FORWARD ? resource as never : original(kind)
        );
        return { session, resource };
    }

    it("hands off a fresh full import before marking it resolved or resuming writers", async () => {
        const { rebuilder, services, settings } = createRebuilder();
        services.database.localDatabase.localDatabase.info.mockResolvedValue({ doc_count: 0 });
        const { session, resource } = enableHandoff(services);
        fetchChangesForInitialSyncMock.mockReset().mockImplementation(async (...args: any[]) => {
            await args[8]([{ id: "file", rev: "1-imported" }]);
            await args[6]("verified-remote-sequence");
        });
        await rebuilder.$fetchLocalDBFast(false);
        expect(session.recordStoredRevisions).toHaveBeenCalledWith([{ id: "file", rev: "1-imported" }]);
        expect(session.recordCheckpoint).toHaveBeenCalledWith("verified-remote-sequence");
        expect(session.fastForward).toHaveBeenCalledOnce();
        expect(session.fastForward.mock.invocationCallOrder[0]).toBeLessThan(
            services.replication.markResolved.mock.invocationCallOrder[0]
        );
        expect(settings.suspendFileWatching).toBe(true);
        expect(settings.suspendParseReplicationResult).toBe(true);
        expect(resource.dispose).toHaveBeenCalledOnce();
        expect(services.replication.replicateAllFromRemote).not.toHaveBeenCalled();
        expect(services.replication.replicateAllToRemote).not.toHaveBeenCalled();
    });

    it("keeps an old resume cursor outside the fresh-import handoff", async () => {
        fetchChangesForInitialSyncMock.mockReset().mockResolvedValue(undefined);
        const { rebuilder, services } = createRebuilder();
        (rebuilder as any).saveFastFetchCheckpoint("https://example.com/db", "old-cursor");
        const { session, resource } = enableHandoff(services);
        await rebuilder.$fetchLocalDBFast(false);
        expect(fetchChangesForInitialSyncMock.mock.calls[0][4]).toBe("old-cursor");
        expect(resource.prepare).not.toHaveBeenCalled();
        expect(session.fastForward).not.toHaveBeenCalled();
    });

    it("does not create a handoff when the workflow leaves writers enabled", async () => {
        fetchChangesForInitialSyncMock.mockReset().mockResolvedValue(undefined);
        const { rebuilder, services, settings } = createRebuilder();
        settings.doNotSuspendOnFetching = true;
        services.database.localDatabase.localDatabase.info.mockResolvedValue({ doc_count: 0 });
        const { resource } = enableHandoff(services);
        await rebuilder.$fetchLocalDBFast(false);
        expect(resource.prepare).not.toHaveBeenCalled();
    });

    it("disposes the handoff without advancing it after an incomplete fetch", async () => {
        const failure = new Error("incomplete import");
        fetchChangesForInitialSyncMock.mockReset().mockRejectedValue(failure);
        const { rebuilder, services } = createRebuilder();
        services.database.localDatabase.localDatabase.info.mockResolvedValue({ doc_count: 0 });
        const { session, resource } = enableHandoff(services);
        await expect(rebuilder.$fetchLocalDBFast(false)).rejects.toBe(failure);
        expect(session.fastForward).not.toHaveBeenCalled();
        expect(resource.dispose).toHaveBeenCalledOnce();
        expect(services.replication.markResolved).not.toHaveBeenCalled();
    });

    it("does not use the general Replicator factory solely to prepare Fast Fetch", async () => {
        fetchChangesForInitialSyncMock.mockReset().mockResolvedValue(undefined);
        const { rebuilder, services, settings } = createRebuilder();

        await rebuilder.$fetchLocalDBFast(false);

        expect(services.replicator.getNewReplicator).not.toHaveBeenCalled();
        expect(services.replicator.createRemoteResource).toHaveBeenCalledWith(
            REMOTE_RESOURCE_KINDS.SECURITY_SEED,
            settings
        );
    });

    it("disposes the owned Security Seed resource exactly once when Fast Fetch succeeds", async () => {
        fetchChangesForInitialSyncMock.mockReset().mockResolvedValue(undefined);
        const { rebuilder, services } = createRebuilder();
        const dispose = vi.fn(async () => undefined);
        const resource = {
            read: vi.fn(async () => new Uint8Array([1])),
            dispose,
        };
        services.replicator.createRemoteResource.mockResolvedValue(resource);

        await rebuilder.$fetchLocalDBFast(false);

        expect(dispose).toHaveBeenCalledOnce();
    });

    it("disposes the owned Security Seed resource exactly once when Fast Fetch fails", async () => {
        const failure = Object.assign(new Error("stream failed"), { retryable: false });
        fetchChangesForInitialSyncMock.mockReset().mockRejectedValue(failure);
        const { rebuilder, services } = createRebuilder();
        const dispose = vi.fn(async () => undefined);
        const resource = {
            read: vi.fn(async () => new Uint8Array([1])),
            dispose,
        };
        services.replicator.createRemoteResource.mockResolvedValue(resource);

        await expect(rebuilder.$fetchLocalDBFast(false)).rejects.toBe(failure);

        expect(dispose).toHaveBeenCalledOnce();
    });

    it("does not borrow the active Replicator for Fast Fetch", async () => {
        fetchChangesForInitialSyncMock.mockReset().mockResolvedValue(undefined);
        const { rebuilder, services } = createRebuilder();

        await rebuilder.$fetchLocalDBFast(false);

        expect(services.replicator.getNewReplicator).not.toHaveBeenCalled();
        expect(services.replicator.getActiveReplicator).not.toHaveBeenCalled();
    });
});

describe("ServiceRebuilder bounded remote activity", () => {
    it("stops a rebuild before remote mutation when the selected local database cannot be reset", async () => {
        const { rebuilder, services } = createRebuilder("previous-device");
        const remoteReplicator = services.replicator.getActiveReplicator();
        services.database.resetDatabaseForCurrentSettings.mockResolvedValueOnce(false);

        await expect(rebuilder.$rebuildEverything()).rejects.toThrow(
            "The local database selected by the current settings could not be reset."
        );

        expect(services.databaseEvents.initialiseDatabase).not.toHaveBeenCalled();
        expect(remoteReplicator?.tryResetRemoteDatabase).not.toHaveBeenCalled();
        expect(services.replication.replicateAllToRemote).not.toHaveBeenCalled();
    });

    it("initialises a first P2P device without attempting to reset or upload to a non-existent remote database", async () => {
        const { rebuilder, services, settings } = createRebuilder();
        settings.remoteType = REMOTE_P2P;
        const p2pReplicator = {
            tryResetRemoteDatabase: vi.fn(async () => {
                throw new Error("P2P replication does not support database reset.");
            }),
        };
        services.replicator.getActiveReplicator.mockReturnValue(p2pReplicator);

        await expect(rebuilder.$rebuildEverything()).resolves.toBeUndefined();

        expect(services.database.resetDatabaseForCurrentSettings).toHaveBeenCalled();
        expect(services.databaseEvents.initialiseDatabase).not.toHaveBeenCalled();
        expect(services.vault.scanVault).toHaveBeenCalledOnce();
        expect(services.vault.scanVault).toHaveBeenCalledWith(true, true);
        expect(services.databaseEvents.onDatabaseInitialised).toHaveBeenCalledOnce();
        expect(services.fileProcessing.commitPendingFileEvents).toHaveBeenCalledTimes(2);
        expect(services.appLifecycle.markIsReady).toHaveBeenCalledOnce();
        expect(p2pReplicator.tryResetRemoteDatabase).not.toHaveBeenCalled();
        expect(services.replication.markLocked).not.toHaveBeenCalled();
        expect(services.replication.replicateAllToRemote).not.toHaveBeenCalled();
        expect(services.replication.replicateAllToRemoteForRebuild).not.toHaveBeenCalled();
    });

    it("protects a remote rebuild but releases the activity before the completion dialogue", async () => {
        const { rebuilder, services, activityFinished, runBoundedRemoteActivity } = createRebuilder();

        await rebuilder.$rebuildRemote();

        expect(runBoundedRemoteActivity).toHaveBeenCalledWith(expect.any(Function), {
            label: "rebuild-remote",
        });
        expect(services.replication.replicateAllToRemote).toHaveBeenCalledTimes(2);
        expect(services.replication.replicateAllToRemote).toHaveBeenNthCalledWith(1, true);
        expect(services.replication.replicateAllToRemote).toHaveBeenNthCalledWith(2, true);
        expect(services.replication.replicateAllToRemote.mock.invocationCallOrder[1]).toBeLessThan(
            activityFinished.mock.invocationCallOrder[0]
        );
        expect(activityFinished.mock.invocationCallOrder[0]).toBeLessThan(
            services.UI.showMarkdownDialog.mock.invocationCallOrder[0]
        );
    });

    it("protects rebuilding both databases", async () => {
        const { rebuilder, services, activityFinished, runBoundedRemoteActivity } = createRebuilder();

        await rebuilder.$rebuildEverything();

        expect(runBoundedRemoteActivity).toHaveBeenCalledWith(expect.any(Function), {
            label: "rebuild-everything",
        });
        expect(services.databaseEvents.initialiseDatabase).not.toHaveBeenCalled();
        expect(services.replication.replicateAllToRemote).not.toHaveBeenCalled();
        expect(services.replication.replicateAllToRemoteForRebuild).toHaveBeenCalledTimes(2);
        expect(services.replication.replicateAllToRemoteForRebuild).toHaveBeenNthCalledWith(1, true);
        expect(services.replication.replicateAllToRemoteForRebuild).toHaveBeenNthCalledWith(2, true);
        expect(services.vault.scanVault).toHaveBeenCalledOnce();
        expect(services.vault.scanVault).toHaveBeenCalledWith(true, true);
        expect(services.databaseEvents.onDatabaseInitialised).toHaveBeenCalledOnce();
        expect(services.databaseEvents.onDatabaseInitialised.mock.invocationCallOrder[0]).toBeLessThan(
            services.replication.replicateAllToRemoteForRebuild.mock.invocationCallOrder[0]
        );
        expect(services.replication.replicateAllToRemoteForRebuild.mock.invocationCallOrder[1]).toBeLessThan(
            activityFinished.mock.invocationCallOrder[0]
        );
    });

    it("protects a standard remote fetch through reflection resumption", async () => {
        const { rebuilder, services, activityFinished, runBoundedRemoteActivity } = createRebuilder();

        await rebuilder.$fetchLocal(false, true);

        expect(runBoundedRemoteActivity).toHaveBeenCalledWith(expect.any(Function), {
            label: "rebuild-fetch",
        });
        expect(services.replication.replicateAllFromRemote).not.toHaveBeenCalled();
        expect(services.replication.replicateAllFromRemoteForRebuild).toHaveBeenCalledTimes(2);
        expect(services.vault.scanVault).toHaveBeenCalledWith(true);
        expect(services.vault.scanVault.mock.invocationCallOrder[0]).toBeLessThan(
            activityFinished.mock.invocationCallOrder[0]
        );
    });

    it("completes a P2P fetch with one explicit peer-selection pass", async () => {
        const { rebuilder, services, settings } = createRebuilder();
        settings.remoteType = REMOTE_P2P;

        await rebuilder.$fetchLocal(false, true);

        expect(services.replication.replicateAllFromRemote).not.toHaveBeenCalled();
        expect(services.replication.replicateAllFromRemoteForRebuild).toHaveBeenCalledOnce();
        expect(services.vault.scanVault).toHaveBeenCalledWith(true);
    });

    it("does not start protected activity while waiting for restricted-fetch confirmation", async () => {
        const { rebuilder, settings, runBoundedRemoteActivity } = createRebuilder();
        settings.maxMTimeForReflectEvents = Date.now();

        await rebuilder.$fetchLocal(false, true);

        expect(runBoundedRemoteActivity).not.toHaveBeenCalled();
    });

    it("uses only the standard-fetch activity when fast fetch falls back", async () => {
        const { rebuilder, settings, runBoundedRemoteActivity } = createRebuilder();
        settings.remoteType = "MINIO";

        await rebuilder.$fetchLocalDBFast(false);

        expect(runBoundedRemoteActivity).toHaveBeenCalledTimes(1);
        expect(runBoundedRemoteActivity).toHaveBeenCalledWith(expect.any(Function), {
            label: "rebuild-fetch",
        });
    });

    it("uses Standard Fetch when the internal Request API is enabled", async () => {
        fetchChangesForInitialSyncMock.mockReset().mockResolvedValue(undefined);
        const { rebuilder, services, settings, runBoundedRemoteActivity } = createRebuilder();
        settings.useRequestAPI = true;
        settings.additionalSuffixOfDatabaseName = "app";
        services.setting.setSmallConfig(
            "fast-fetch-checkpoint",
            JSON.stringify({ remote: "https://example.com/db", sequence: "10-g1" })
        );

        await rebuilder.$fetchLocalDBFast(false);

        expect(fetchChangesForInitialSyncMock).not.toHaveBeenCalled();
        expect(services.replication.replicateAllFromRemote).not.toHaveBeenCalled();
        expect(services.replication.replicateAllFromRemoteForRebuild).toHaveBeenCalledTimes(2);
        expect(services.setting.deleteSmallConfig).toHaveBeenCalledWith("fast-fetch-checkpoint");
        expect(services.database.resetDatabaseForCurrentSettings.mock.invocationCallOrder[0]).toBeLessThan(
            services.setting.deleteSmallConfig.mock.invocationCallOrder[0]
        );
        expect(runBoundedRemoteActivity).toHaveBeenCalledTimes(1);
        expect(runBoundedRemoteActivity).toHaveBeenCalledWith(expect.any(Function), {
            label: "rebuild-fetch",
        });
    });
});

describe("ServiceRebuilder readiness boundary", () => {
    it("uses the rebuild-only pull and marks Standard Fetch ready after finalisation", async () => {
        const { rebuilder, services } = createRebuilder();

        await rebuilder.$fetchLocal(false, true);

        expect(services.replication.replicateAllFromRemote).not.toHaveBeenCalled();
        expect(services.replication.replicateAllFromRemoteForRebuild).toHaveBeenCalledTimes(2);
        expect(services.appLifecycle.resetIsReady).toHaveBeenCalled();
        expect(services.appLifecycle.markIsReady).toHaveBeenCalledOnce();
        expect(services.replication.replicateAllFromRemoteForRebuild.mock.invocationCallOrder[1]).toBeLessThan(
            services.vault.scanVault.mock.invocationCallOrder[0]
        );
        expect(services.databaseEvents.onDatabaseInitialised).not.toHaveBeenCalled();
        expect(services.fileProcessing.commitPendingFileEvents.mock.invocationCallOrder[0]).toBeLessThan(
            services.appLifecycle.markIsReady.mock.invocationCallOrder[0]
        );
    });

    it("runs local preparation hooks before Standard Fetch when local files must be preserved", async () => {
        const { rebuilder, services } = createRebuilder();

        await rebuilder.$fetchLocal(false, false);

        expect(services.vault.scanVault).toHaveBeenNthCalledWith(1, true, true);
        expect(services.vault.scanVault).toHaveBeenNthCalledWith(2, true);
        expect(services.databaseEvents.onDatabaseInitialised).toHaveBeenCalledOnce();
        expect(services.vault.scanVault.mock.invocationCallOrder[0]).toBeLessThan(
            services.databaseEvents.onDatabaseInitialised.mock.invocationCallOrder[0]
        );
        expect(services.databaseEvents.onDatabaseInitialised.mock.invocationCallOrder[0]).toBeLessThan(
            services.fileProcessing.commitPendingFileEvents.mock.invocationCallOrder[0]
        );
        expect(services.fileProcessing.commitPendingFileEvents.mock.invocationCallOrder[0]).toBeLessThan(
            services.replication.replicateAllFromRemoteForRebuild.mock.invocationCallOrder[0]
        );
        expect(services.replication.replicateAllFromRemoteForRebuild.mock.invocationCallOrder[1]).toBeLessThan(
            services.vault.scanVault.mock.invocationCallOrder[1]
        );
        expect(services.fileProcessing.commitPendingFileEvents.mock.invocationCallOrder[1]).toBeLessThan(
            services.appLifecycle.markIsReady.mock.invocationCallOrder[0]
        );
    });

    it("leaves Fast Fetch unready when completion belongs to the host", async () => {
        fetchChangesForInitialSyncMock.mockReset().mockResolvedValue(undefined);
        const { rebuilder, services } = createRebuilder();

        await rebuilder.$fetchLocalDBFast(false);

        expect(services.appLifecycle.resetIsReady).toHaveBeenCalled();
        expect(services.appLifecycle.markIsReady).not.toHaveBeenCalled();
        expect(services.databaseEvents.onDatabaseInitialised).not.toHaveBeenCalled();
        expect(services.fileProcessing.commitPendingFileEvents).not.toHaveBeenCalled();
    });

    it("does not reopen the settings-selected database after Standard Fetch has reset it", async () => {
        const { rebuilder, services } = createRebuilder();

        await rebuilder.fetchLocal(false, true, false);

        expect(services.database.resetDatabaseForCurrentSettings).toHaveBeenCalledOnce();
        expect(services.database.openDatabase).not.toHaveBeenCalled();
    });

    it("does not reopen the settings-selected database after a fresh Fast Fetch has reset it", async () => {
        fetchChangesForInitialSyncMock.mockReset().mockResolvedValue(undefined);
        const { rebuilder, services } = createRebuilder();

        await rebuilder.$fetchLocalDBFast(false);

        expect(services.database.resetDatabaseForCurrentSettings).toHaveBeenCalledOnce();
        expect(services.database.openDatabase).not.toHaveBeenCalled();
    });

    it("uses the rebuild-only push and completes Rebuild Everything last", async () => {
        const { rebuilder, services } = createRebuilder();

        await rebuilder.$rebuildEverything();

        expect(services.replication.replicateAllToRemote).not.toHaveBeenCalled();
        expect(services.replication.replicateAllToRemoteForRebuild).toHaveBeenCalledTimes(2);
        expect(services.appLifecycle.markIsReady).toHaveBeenCalledOnce();
        expect(services.replication.replicateAllToRemoteForRebuild.mock.invocationCallOrder[1]).toBeLessThan(
            services.appLifecycle.markIsReady.mock.invocationCallOrder[0]
        );
    });

    it("keeps application readiness and reflection suspended when final scanning fails", async () => {
        const { rebuilder, services, settings } = createRebuilder();
        services.vault.scanVault.mockResolvedValueOnce(false);

        await expect(rebuilder.finishRebuild()).resolves.toBe(false);

        expect(services.databaseEvents.onDatabaseInitialised).not.toHaveBeenCalled();
        expect(services.fileProcessing.commitPendingFileEvents).not.toHaveBeenCalled();
        expect(services.setting.saveSettingData).not.toHaveBeenCalled();
        expect(services.appLifecycle.markIsReady).not.toHaveBeenCalled();
        expect(settings.suspendFileWatching).toBe(true);
        expect(settings.suspendParseReplicationResult).toBe(true);
    });

    it("finalises a rebuild in remediation mode and keeps the host restricted", async () => {
        const { rebuilder, services, settings } = createRebuilder();
        settings.maxMTimeForReflectEvents = Date.parse("2026-09-01T00:00:00Z");
        // Remediation mode refuses every reconciliation scan, so requesting one can only fail.
        services.vault.scanVault.mockResolvedValue(false);

        await expect(rebuilder.finishRebuild()).resolves.toBe(true);

        expect(services.vault.scanVault).not.toHaveBeenCalled();
        expect(services.setting.saveSettingData).toHaveBeenCalled();
        expect(settings.suspendParseReplicationResult).toBe(false);
        expect(settings.suspendFileWatching).toBe(false);
        expect(services.appLifecycle.markIsReady).not.toHaveBeenCalled();
    });

    it("fetches in remediation mode without storing the current files of the Vault first", async () => {
        const { rebuilder, services, settings } = createRebuilder();
        settings.maxMTimeForReflectEvents = Date.parse("2026-09-01T00:00:00Z");
        services.vault.scanVault.mockResolvedValue(false);
        // The user keeps the configured limit instead of clearing it.
        services.UI.confirm.askSelectStringDialogue.mockResolvedValue("I understand, proceed");

        await rebuilder.$fetchLocal();

        expect(services.vault.scanVault).not.toHaveBeenCalled();
        expect(services.fileHandler.createAllChunks).not.toHaveBeenCalled();
        expect(services.databaseEvents.onDatabaseInitialised).not.toHaveBeenCalled();
        expect(services.replication.replicateAllFromRemoteForRebuild).toHaveBeenCalledTimes(2);
        expect(settings.suspendParseReplicationResult).toBe(false);
        expect(services.appLifecycle.markIsReady).not.toHaveBeenCalled();
    });

    it("resumes ordinary fetch behaviour when the restriction is cleared instead of kept", async () => {
        const { rebuilder, services, settings } = createRebuilder();
        settings.maxMTimeForReflectEvents = Date.parse("2026-09-01T00:00:00Z");
        services.UI.confirm.askSelectStringDialogue.mockResolvedValue("Clear restriction and proceed");

        await rebuilder.$fetchLocal();

        expect(settings.maxMTimeForReflectEvents).toBe(0);
        expect(services.vault.scanVault).toHaveBeenCalled();
        expect(services.appLifecycle.markIsReady).toHaveBeenCalled();
    });

    it("refuses to rebuild in remediation mode before the local database is reset", async () => {
        const { rebuilder, services, settings } = createRebuilder();
        settings.maxMTimeForReflectEvents = Date.parse("2026-09-01T00:00:00Z");

        await expect(rebuilder.$rebuildEverything()).rejects.toThrow(/remediation mode/i);

        expect(services.database.resetDatabase).not.toHaveBeenCalled();
        expect(services.database.resetDatabaseForCurrentSettings).not.toHaveBeenCalled();
        expect(services.replication.replicateAllToRemoteForRebuild).not.toHaveBeenCalled();
    });

    it("keeps application readiness and reflection suspended when the final replication pre-check rejects", async () => {
        const { rebuilder, services, settings } = createRebuilder();
        services.replication.onBeforeReplicate.mockResolvedValueOnce(false);

        await expect(rebuilder.finishRebuild()).resolves.toBe(false);

        expect(services.fileProcessing.commitPendingFileEvents).not.toHaveBeenCalled();
        expect(services.databaseEvents.onDatabaseInitialised).not.toHaveBeenCalled();
        expect(services.setting.saveSettingData).not.toHaveBeenCalled();
        expect(services.appLifecycle.markIsReady).not.toHaveBeenCalled();
        expect(settings.suspendFileWatching).toBe(true);
        expect(settings.suspendParseReplicationResult).toBe(true);
    });

    it("persists staged reflection only after every final gate and marks application readiness last", async () => {
        const { rebuilder, services, settings } = createRebuilder();
        const timeline: string[] = [];
        let applicationReady = true;
        services.appLifecycle.resetIsReady.mockImplementation(() => {
            applicationReady = false;
            timeline.push("reset-ready");
        });
        services.setting.applyPartial.mockImplementation(async (partial: any) => {
            Object.assign(settings, partial);
            timeline.push("stage-reflection");
        });
        services.vault.scanVault.mockImplementation(async () => {
            expect(applicationReady).toBe(false);
            expect(settings.suspendFileWatching).toBe(false);
            timeline.push("scan-vault");
            return true;
        });
        services.replication.onBeforeReplicate.mockImplementation(async () => {
            expect(applicationReady).toBe(false);
            timeline.push("replication-pre-check");
            return true;
        });
        services.fileProcessing.commitPendingFileEvents.mockImplementation(async () => {
            expect(applicationReady).toBe(false);
            timeline.push("release-current-batch");
            return true;
        });
        services.setting.saveSettingData.mockImplementation(async () => {
            expect(applicationReady).toBe(false);
            timeline.push("persist-reflection");
        });
        services.appLifecycle.markIsReady.mockImplementation(() => {
            applicationReady = true;
            timeline.push("mark-ready");
        });

        await expect(rebuilder.finishRebuild()).resolves.toBe(true);

        expect(timeline).toEqual([
            "reset-ready",
            "stage-reflection",
            "scan-vault",
            "replication-pre-check",
            "release-current-batch",
            "persist-reflection",
            "mark-ready",
        ]);
    });

    it("restores in-memory suspension and remains unready when persisting resumed reflection fails", async () => {
        const { rebuilder, services, settings } = createRebuilder();
        const error = new Error("setting storage failed");
        services.setting.saveSettingData.mockRejectedValueOnce(error);

        await expect(rebuilder.finishRebuild()).rejects.toBe(error);

        expect(services.appLifecycle.markIsReady).not.toHaveBeenCalled();
        expect(settings.suspendFileWatching).toBe(true);
        expect(settings.suspendParseReplicationResult).toBe(true);
    });

    it("keeps application readiness and reflection suspended when current batch waits cannot be released", async () => {
        const { rebuilder, services, settings } = createRebuilder();
        services.fileProcessing.commitPendingFileEvents.mockResolvedValueOnce(false);

        await expect(rebuilder.finishRebuild()).resolves.toBe(false);

        expect(services.setting.saveSettingData).not.toHaveBeenCalled();
        expect(services.appLifecycle.markIsReady).not.toHaveBeenCalled();
        expect(settings.suspendFileWatching).toBe(true);
        expect(settings.suspendParseReplicationResult).toBe(true);
    });

    it("does not finalise Standard Fetch after an incomplete maintenance transfer", async () => {
        const { rebuilder, services } = createRebuilder();
        services.replication.replicateAllFromRemoteForRebuild.mockResolvedValueOnce(false);

        await expect(rebuilder.$fetchLocal(false, true)).rejects.toThrow(
            "The first Standard Fetch pass did not complete."
        );

        expect(services.vault.scanVault).not.toHaveBeenCalled();
        expect(services.databaseEvents.onDatabaseInitialised).not.toHaveBeenCalled();
        expect(services.appLifecycle.markIsReady).not.toHaveBeenCalled();
    });

    it("stops Rebuild Everything before remote mutation when local preparation hooks reject", async () => {
        const { rebuilder, services } = createRebuilder();
        services.databaseEvents.onDatabaseInitialised.mockResolvedValueOnce(false);

        await expect(rebuilder.$rebuildEverything()).rejects.toThrow(
            "The local database completion hooks failed during rebuild preparation."
        );

        expect(services.replication.markLocked).not.toHaveBeenCalled();
        expect(services.replication.replicateAllToRemoteForRebuild).not.toHaveBeenCalled();
        expect(services.appLifecycle.markIsReady).not.toHaveBeenCalled();
    });

    it("leaves Standard Fetch unready when the host owns completion", async () => {
        const { rebuilder, services } = createRebuilder();

        await rebuilder.fetchLocal(false, true, false);

        expect(services.replication.replicateAllFromRemoteForRebuild).toHaveBeenCalledTimes(2);
        expect(services.vault.scanVault).not.toHaveBeenCalled();
        expect(services.databaseEvents.onDatabaseInitialised).not.toHaveBeenCalled();
        expect(services.fileProcessing.commitPendingFileEvents).not.toHaveBeenCalled();
        expect(services.appLifecycle.markIsReady).not.toHaveBeenCalled();
    });

    it("keeps the local-chunk Standard Fetch branch behind the final readiness boundary", async () => {
        const { rebuilder, services } = createRebuilder();

        await rebuilder.$fetchLocal(true, false);

        expect(services.fileHandler.createAllChunks).toHaveBeenCalledWith(true);
        expect(services.replication.replicateAllFromRemoteForRebuild).toHaveBeenCalledTimes(2);
        expect(services.databaseEvents.onDatabaseInitialised).not.toHaveBeenCalled();
        expect(services.appLifecycle.markIsReady).toHaveBeenCalledOnce();
        expect(services.replication.replicateAllFromRemoteForRebuild.mock.invocationCallOrder[1]).toBeLessThan(
            services.appLifecycle.markIsReady.mock.invocationCallOrder[0]
        );
    });

    it("does not introduce the ordinary initialisation hook into a completed Fast Fetch", async () => {
        fetchChangesForInitialSyncMock.mockReset().mockResolvedValue(undefined);
        const { rebuilder, services } = createRebuilder();

        await rebuilder.$fetchLocalDBFast(true);

        expect(services.vault.scanVault).toHaveBeenCalledOnce();
        expect(services.databaseEvents.onDatabaseInitialised).not.toHaveBeenCalled();
        expect(services.fileProcessing.commitPendingFileEvents).toHaveBeenCalledOnce();
        expect(services.appLifecycle.markIsReady).toHaveBeenCalledOnce();
    });
});
