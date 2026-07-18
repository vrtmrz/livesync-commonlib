import { describe, expect, it, vi } from "vitest";
import { REMOTE_COUCHDB } from "@lib/common/models/setting.const";
import { FlagFilesHumanReadable } from "@lib/common/models/redflag.const";
import { ServiceRebuilder } from "./Rebuilder";
import { createLiveSyncEventHub } from "@lib/hub/hub";
import { EVENT_DATABASE_REBUILT } from "@lib/events/coreEvents";

const fetchChangesForInitialSyncMock = vi.hoisted(() => vi.fn());

vi.mock("@lib/pouchdb/StreamingFetch", () => ({
    fetchChangesForInitialSync: fetchChangesForInitialSyncMock,
}));

vi.mock("octagonal-wheels/promises", async (importOriginal) => {
    const original = (await importOriginal()) as Record<string, unknown>;
    return {
        ...original,
        delay: vi.fn(async () => undefined),
    };
});

function createRebuilder() {
    const smallConfig = new Map<string, string>();
    const settings = {
        isConfigured: true,
        additionalSuffixOfDatabaseName: "",
        remoteType: REMOTE_COUCHDB,
        couchDB_URI: "https://example.com",
        couchDB_DBNAME: "db",
        couchDB_USER: "user",
        couchDB_PASSWORD: "pass",
        useJWT: false,
        passphrase: "",
        E2EEAlgorithm: "",
        doNotSuspendOnFetching: false,
    } as any;
    const localDB = {
        info: vi.fn(async () => ({ doc_count: 1 })),
        allDocs: vi.fn(async () => ({ total_rows: 1 })),
    };
    const activityFinished = vi.fn();
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
            resetDatabase: vi.fn(async () => undefined),
            openDatabase: vi.fn(async () => undefined),
            localDatabase: { localDatabase: localDB },
        },
        databaseEvents: {
            initialiseDatabase: vi.fn(async () => undefined),
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
            onBeforeReplicate: vi.fn(async () => true),
        },
        appLifecycle: {
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
            scanVault: vi.fn(async () => undefined),
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
                throw new Error("network changed");
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
});

describe("ServiceRebuilder bounded remote activity", () => {
    it("protects a remote rebuild but releases the activity before the completion dialogue", async () => {
        const { rebuilder, services, activityFinished, runBoundedRemoteActivity } = createRebuilder();

        await rebuilder.$rebuildRemote();

        expect(runBoundedRemoteActivity).toHaveBeenCalledWith(expect.any(Function), {
            label: "rebuild-remote",
        });
        expect(services.replication.replicateAllToRemote).toHaveBeenCalledTimes(2);
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
        expect(services.databaseEvents.initialiseDatabase).toHaveBeenCalled();
        expect(services.replication.replicateAllToRemote).toHaveBeenCalledTimes(2);
        expect(services.replication.replicateAllToRemote.mock.invocationCallOrder[1]).toBeLessThan(
            activityFinished.mock.invocationCallOrder[0]
        );
    });

    it("protects a standard remote fetch through reflection resumption", async () => {
        const { rebuilder, services, activityFinished, runBoundedRemoteActivity } = createRebuilder();

        await rebuilder.$fetchLocal(false, true);

        expect(runBoundedRemoteActivity).toHaveBeenCalledWith(expect.any(Function), {
            label: "rebuild-fetch",
        });
        expect(services.replication.replicateAllFromRemote).toHaveBeenCalledTimes(2);
        expect(services.vault.scanVault).toHaveBeenCalledWith(true);
        expect(services.vault.scanVault.mock.invocationCallOrder[0]).toBeLessThan(
            activityFinished.mock.invocationCallOrder[0]
        );
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
});
