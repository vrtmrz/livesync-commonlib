import { describe, expect, it } from "vitest";
import { reactiveSource } from "octagonal-wheels/dataobject/reactive";

import {
    DEFAULT_SETTINGS,
    DEVICE_ID_PREFERRED,
    MILESTONE_DOCID,
    NODEINFO_DOCID,
    type EntryDoc,
    type EntryMilestoneInfo,
    type RemoteDBSettings,
} from "@lib/common/types.ts";
import type { PouchDBConstructor } from "@lib/pouchdb/PouchDBConstructor.ts";
import { PouchDB } from "@lib/pouchdb/pouchdb-test.ts";
import { LiveSyncCouchDBReplicator } from "@lib/replication/couchdb/LiveSyncReplicator.ts";
import { LiveSyncJournalReplicator } from "@lib/replication/journal/LiveSyncJournalReplicator.ts";
import { MinioStorageAdapter } from "@lib/replication/journal/objectstore/MinioStorageAdapter.ts";
import { InjectableRemoteService } from "@lib/services/implements/injectable/InjectableRemoteService.ts";
import { ServiceContext } from "@lib/services/base/ServiceBase.ts";

const hostname = process.env.hostname ?? "http://127.0.0.1:5989/";
const username = process.env.username ?? "admin";
const password = process.env.password ?? "testpassword";
const endpoint = process.env.minioEndpoint ?? "http://127.0.0.1:9000";
const accessKey = process.env.accessKey ?? "minioadmin";
const secretKey = process.env.secretKey ?? "minioadmin";
const bucket = process.env.bucketName ?? "livesync-test-bucket";
const ownDeviceId = "joined-devices-local-node";
const targetDeviceId = "joined-devices-forgotten-node";
const otherDeviceId = "joined-devices-retained-node";

function uniqueSuffix(): string {
    return `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function createMilestone(): EntryMilestoneInfo {
    return {
        _id: MILESTONE_DOCID,
        type: "milestoneinfo",
        created: Date.now(),
        locked: true,
        cleaned: true,
        accepted_nodes: [ownDeviceId, targetDeviceId, otherDeviceId],
        node_info: {
            [ownDeviceId]: { plugin_version: "local" },
            [targetDeviceId]: { plugin_version: "target" },
            [otherDeviceId]: { plugin_version: "other" },
        },
        node_chunk_info: {
            [ownDeviceId]: { min: 0, max: 2400, current: 2 },
            [targetDeviceId]: { min: 0, max: 2400, current: 2 },
            [otherDeviceId]: { min: 0, max: 2400, current: 2 },
        },
        tweak_values: {
            [targetDeviceId]: { handleFilenameCaseSensitive: true },
            [otherDeviceId]: { handleFilenameCaseSensitive: false },
            [DEVICE_ID_PREFERRED]: { handleFilenameCaseSensitive: false },
        },
        unknown_joined_devices_field: { retained: true },
    } as unknown as EntryMilestoneInfo;
}

function createLocalDatabase(name: string) {
    return new PouchDB<EntryDoc>(name, { adapter: "memory" });
}

async function seedNodeInfo(database: PouchDB.Database<EntryDoc>) {
    await database.put({
        _id: NODEINFO_DOCID,
        type: "nodeinfo",
        nodeid: ownDeviceId,
    } as EntryDoc);
}

function createRemoteService() {
    const api = {
        isOnline: true,
        isMobile: () => false,
        getCustomFetchHandler: () => undefined,
        webCompatFetch: (request: string | Request, init?: RequestInit) => fetch(request, init),
        nativeFetch: (request: string | Request, init?: RequestInit) => fetch(request, init),
        addLog: () => {},
        requestCount: reactiveSource(0),
        responseCount: reactiveSource(0),
    };
    const getUnresolvedMessages = Object.assign(async () => [], { addHandler: () => () => {} });
    const remote = new InjectableRemoteService(new ServiceContext(), {
        pouchDB: PouchDB as unknown as PouchDBConstructor,
        APIService: api as never,
        appLifecycle: { getUnresolvedMessages } as never,
        setting: { currentSettings: () => DEFAULT_SETTINGS } as never,
    });
    return remote;
}

function createJournalEnvironment(settings: RemoteDBSettings, local: PouchDB.Database<EntryDoc>) {
    const values = new Map<string, unknown>();
    return {
        services: {
            API: {
                getCustomFetchHandler: () => undefined,
                requestCount: reactiveSource(0),
                responseCount: reactiveSource(0),
                getAppVersion: () => "integration-test",
                getPluginVersion: () => "integration-test",
                getPlatform: () => "integration-test",
            },
            context: { translate: (key: string) => key },
            database: { localDatabase: { localDatabase: local } },
            keyValueDB: {
                simpleStore: {
                    db: undefined,
                    get: async (key: string) => values.get(key),
                    set: async (key: string, value: unknown) => void values.set(key, value),
                    delete: async (key: string) => void values.delete(key),
                    keys: async () => [...values.keys()],
                },
            },
            replication: { parseSynchroniseResult: async () => true },
            replicator: { replicationStatics: reactiveSource(undefined) },
            setting: { currentSettings: () => settings },
            vault: { getVaultName: () => "integration-vault", vaultName: () => "integration-vault" },
        },
    } as never;
}

function createBucketSettings(bucketPrefix: string): RemoteDBSettings {
    return {
        ...DEFAULT_SETTINGS,
        endpoint,
        accessKey,
        secretKey,
        bucket,
        region: "us-east-1",
        bucketPrefix,
        forcePathStyle: true,
        useCustomRequestHandler: false,
        bucketCustomHeaders: "",
        pathNormalizationVersion: 0,
    } as RemoteDBSettings;
}

describe("joined-device management with CouchDB and RustFS", () => {
    it.each(["read", "forget"] as const)("does not create a missing CouchDB database during %s", async (operation) => {
        const databaseName = `joined-devices-missing-${uniqueSuffix()}`.toLowerCase();
        const uri = new URL(databaseName, hostname).toString();
        const headers = { authorization: `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}` };
        const localDatabase = createLocalDatabase(`joined-devices-missing-local-${uniqueSuffix()}`);
        const setting: RemoteDBSettings = {
            ...DEFAULT_SETTINGS,
            couchDB_URI: hostname,
            couchDB_USER: username,
            couchDB_PASSWORD: password,
            couchDB_DBNAME: databaseName,
        };
        const replicator = new LiveSyncCouchDBReplicator({
            services: {
                API: { isMobile: () => false },
                database: { localDatabase: { localDatabase } },
                remote: createRemoteService(),
            },
        } as never);
        try {
            await seedNodeInfo(localDatabase);
            expect((await fetch(uri, { headers })).status).toBe(404);
            const result = await (
                operation === "read"
                    ? replicator.getJoinedDevices(setting)
                    : replicator.forgetJoinedDevice(setting, targetDeviceId)
            );
            expect((await fetch(uri, { headers })).status).toBe(404);
            expect(result).toEqual(
                operation === "read"
                    ? { milestonePresent: false, locked: false, cleaned: false, devices: [] }
                    : "not-found"
            );
        } finally {
            await localDatabase.destroy();
            await fetch(uri, { method: "DELETE", headers });
        }
    });

    it("forgets only the selected device through CouchDB and records the local-document concurrency limitation", async () => {
        const databaseName = `joined-devices-${uniqueSuffix()}`.toLowerCase();
        const uri = new URL(databaseName, hostname).toString();
        const auth = { username, password };
        const remoteDatabase = new PouchDB<EntryDoc>(uri, { adapter: "http", auth });
        const localDatabase = createLocalDatabase(`joined-devices-local-${uniqueSuffix()}`);
        const remote = createRemoteService();
        const setting: RemoteDBSettings = {
            ...DEFAULT_SETTINGS,
            couchDB_URI: hostname,
            couchDB_USER: username,
            couchDB_PASSWORD: password,
            couchDB_DBNAME: databaseName,
            encrypt: false,
        };
        const replicator = new LiveSyncCouchDBReplicator({
            services: {
                API: { isMobile: () => false },
                database: { localDatabase: { localDatabase } },
                remote,
            },
        } as never);

        try {
            await remoteDatabase.info();
            await seedNodeInfo(localDatabase);
            const seeded = createMilestone();
            await remoteDatabase.put(seeded as EntryDoc);

            const connectionResult = await replicator.connectRemoteCouchDBWithSetting(setting, false, true);
            if (typeof connectionResult === "string") {
                throw new Error(`CouchDB integration fixture connection failed: ${connectionResult}`);
            }
            await connectionResult.close();

            const snapshot = await replicator.getJoinedDevices(setting);
            expect(snapshot).toMatchObject({
                milestonePresent: true,
                locked: true,
                cleaned: true,
            });
            expect(snapshot.devices.map(({ id }) => id)).toEqual([ownDeviceId, otherDeviceId, targetDeviceId].sort());

            await expect(replicator.forgetJoinedDevice(setting, ownDeviceId)).rejects.toThrow(
                "The current device cannot be forgotten"
            );
            await expect(replicator.forgetJoinedDevice(setting, targetDeviceId)).resolves.toBe("forgotten");

            const stored = (await remoteDatabase.get(MILESTONE_DOCID)) as EntryMilestoneInfo & {
                unknown_joined_devices_field: { retained: boolean };
            };
            expect(stored.accepted_nodes).toEqual([ownDeviceId, otherDeviceId]);
            expect(stored.node_info).toHaveProperty(ownDeviceId);
            expect(stored.node_info).toHaveProperty(otherDeviceId);
            expect(stored.node_info).not.toHaveProperty(targetDeviceId);
            expect(stored.node_chunk_info).toHaveProperty(otherDeviceId);
            expect(stored.node_chunk_info).not.toHaveProperty(targetDeviceId);
            expect(stored.tweak_values).toHaveProperty(otherDeviceId);
            expect(stored.tweak_values).not.toHaveProperty(targetDeviceId);
            expect(stored.tweak_values).toHaveProperty(DEVICE_ID_PREFERRED);
            expect(stored).toMatchObject({
                locked: true,
                cleaned: true,
                unknown_joined_devices_field: { retained: true },
            });

            const stale = await remoteDatabase.get(MILESTONE_DOCID);
            await remoteDatabase.put({ ...stale, unknown_joined_devices_field: { retained: false } });
            // CouchDB local documents accept stale revisions. Keep this actual
            // milestone fixture so it cannot be mistaken for an atomic update.
            await expect(remoteDatabase.put({ ...stale, locked: false })).resolves.toMatchObject({ ok: true });
            const overwritten = await remoteDatabase.get(MILESTONE_DOCID);
            expect(overwritten).toMatchObject({
                locked: false,
                unknown_joined_devices_field: { retained: true },
            });
        } finally {
            await localDatabase.destroy();
            await remoteDatabase.destroy();
        }
    }, 30_000);

    it("forgets only the selected device through the Journal Replicator and rejects stale ETags", async () => {
        const bucketPrefix = `joined-devices-${uniqueSuffix()}/`;
        const setting = createBucketSettings(bucketPrefix);
        const localDatabase = createLocalDatabase(`joined-devices-journal-local-${uniqueSuffix()}`);
        const env = createJournalEnvironment(setting, localDatabase);
        const replicator = new LiveSyncJournalReplicator(env);
        const administration = new MinioStorageAdapter(setting as never, env);
        const milestoneKey = "_00000000-milestone.json";
        const staleKey = "stale-etag-check.json";

        try {
            await seedNodeInfo(localDatabase);
            expect(
                await administration.upload(
                    milestoneKey,
                    new TextEncoder().encode(JSON.stringify(createMilestone())),
                    "application/json"
                )
            ).toBe(true);

            const snapshot = await replicator.getJoinedDevices(setting);
            expect(snapshot).toMatchObject({
                milestonePresent: true,
                locked: true,
                cleaned: true,
            });
            expect(snapshot.devices.map(({ id }) => id)).toEqual([ownDeviceId, otherDeviceId, targetDeviceId].sort());
            await expect(replicator.forgetJoinedDevice(setting, ownDeviceId)).rejects.toThrow(
                "The current device cannot be forgotten"
            );
            await expect(replicator.forgetJoinedDevice(setting, targetDeviceId)).resolves.toBe("forgotten");

            const storedResult = await administration.downloadWithResult(milestoneKey, true);
            expect(storedResult.status).toBe("available");
            if (storedResult.status !== "available") throw new Error("Journal milestone was not available");
            const stored = JSON.parse(new TextDecoder().decode(storedResult.value)) as EntryMilestoneInfo & {
                unknown_joined_devices_field: { retained: boolean };
            };
            expect(stored.accepted_nodes).toEqual([ownDeviceId, otherDeviceId]);
            expect(stored.node_info).toHaveProperty(ownDeviceId);
            expect(stored.node_info).toHaveProperty(otherDeviceId);
            expect(stored.node_info).not.toHaveProperty(targetDeviceId);
            expect(stored.node_chunk_info).toHaveProperty(otherDeviceId);
            expect(stored.node_chunk_info).not.toHaveProperty(targetDeviceId);
            expect(stored.tweak_values).toHaveProperty(otherDeviceId);
            expect(stored.tweak_values).not.toHaveProperty(targetDeviceId);
            expect(stored.tweak_values).toHaveProperty(DEVICE_ID_PREFERRED);
            expect(stored).toMatchObject({
                locked: true,
                cleaned: true,
                unknown_joined_devices_field: { retained: true },
            });

            expect(await administration.upload(staleKey, new TextEncoder().encode("initial"), "text/plain")).toBe(true);
            const oldObject = await administration.downloadWithResult(staleKey, true);
            expect(oldObject.status).toBe("available");
            if (oldObject.status !== "available" || !oldObject.revision) {
                throw new Error("RustFS did not return an ETag for the uploaded object");
            }
            expect(await administration.upload(staleKey, new TextEncoder().encode("newer"), "text/plain")).toBe(true);
            await expect(
                administration.uploadIfUnchanged(
                    staleKey,
                    new TextEncoder().encode("stale write"),
                    "text/plain",
                    oldObject.revision
                )
            ).resolves.toBe("conflict");
        } finally {
            await localDatabase.destroy();
            const files = await administration.listFiles("").catch(() => []);
            if (files.length > 0) await administration.deleteFiles(files);
            administration.dispose();
        }
    }, 30_000);
});
