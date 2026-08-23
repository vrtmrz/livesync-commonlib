import { describe, expect, it, vi } from "vitest";
import { REMOTE_COUCHDB, REMOTE_P2P } from "@lib/common/models/setting.const";
import { FlagFilesHumanReadable } from "@lib/common/models/redflag.const";
import { ServiceRebuilder } from "./Rebuilder";
import { createLiveSyncEventHub } from "@lib/hub/hub";
import { EVENT_DATABASE_REBUILT } from "@lib/events/coreEvents";

const fetchChangesForInitialSyncMock = vi.hoisted(() => vi.fn());

vi.mock("@lib/pouchdb/StreamingFetch", () => ({
    fetchChangesForInitialSync: fetchChangesForInitialSyncMock,
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
    const localDB = {
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
            localDatabase: { localDatabase: localDB },
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
        remote: {},
        storageAccess: {
            clearTouched: vi.fn(),
            writeFileAuto: vi.fn(async () => undefined),
            delete: vi.fn(async () => undefined),
        },
        vault: {
            scanVault: vi.fn(async () => true),
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
    };
}

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
        expect(services.appLifecycle.markIsReady).not.toHaveBeenCalled();
        expect(settings.suspendFileWatching).toBe(true);
        expect(settings.suspendParseReplicationResult).toBe(true);
    });

    it("keeps application readiness and reflection suspended when the final replication pre-check rejects", async () => {
        const { rebuilder, services, settings } = createRebuilder();
        services.replication.onBeforeReplicate.mockResolvedValueOnce(false);

        await expect(rebuilder.finishRebuild()).resolves.toBe(false);

        expect(services.fileProcessing.commitPendingFileEvents).not.toHaveBeenCalled();
        expect(services.databaseEvents.onDatabaseInitialised).not.toHaveBeenCalled();
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
