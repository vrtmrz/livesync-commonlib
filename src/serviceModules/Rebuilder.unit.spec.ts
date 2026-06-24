import { describe, expect, it, vi } from "vitest";
import { REMOTE_COUCHDB } from "@lib/common/models/setting.const";
import { ServiceRebuilder } from "./Rebuilder";

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
    const services = {
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
        databaseEvents: {},
        replicator: {
            getActiveReplicator: vi.fn(() => ({
                getReplicationPBKDF2Salt: vi.fn(async () => "salt"),
            })),
            getNewReplicator: vi.fn(),
        },
        replication: {
            markResolved: vi.fn(async () => undefined),
        },
        appLifecycle: {
            markIsReady: vi.fn(),
        },
        UI: {},
        remote: {},
        storageAccess: {
            clearTouched: vi.fn(),
        },
        vault: {
            scanVault: vi.fn(async () => undefined),
        },
        fileHandler: {},
    };

    return { rebuilder: new ServiceRebuilder(services as any), services };
}

describe("ServiceRebuilder fast fetch retry", () => {
    it("retries from the latest checkpoint after a transient fast fetch failure", async () => {
        const { rebuilder } = createRebuilder();

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
    });
});
