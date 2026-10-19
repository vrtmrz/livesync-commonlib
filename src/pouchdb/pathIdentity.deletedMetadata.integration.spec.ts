import { beforeAll, describe, expect, it } from "vitest";
import PouchDB from "pouchdb-core";
import MemoryAdapter from "pouchdb-adapter-memory";
import HttpAdapter from "pouchdb-adapter-http";
import replication from "pouchdb-replication";
import { existsSync, readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { DEFAULT_SETTINGS, type EntryDoc } from "@lib/common/types";
import type { ISettingService } from "@lib/services/base/IService";
import { ServiceContext } from "@lib/services/base/ServiceBase";
import { PathServiceCompat } from "@lib/services/implements/injectable/InjectablePathService";
import { assertMetadataPathIdentities } from "@lib/common/pathIdentity";
import { deleteDBEntryByPath } from "@lib/managers/EntryManager/EntryManagerImpls";
import { LiveSyncLocalDB } from "./LiveSyncLocalDB";
import {
    composedPath,
    decomposedPath,
    pathIdentityDeletionCases,
    seedPathIdentityDeletionCase,
} from "../../test/pathIdentityDeletionCases";

PouchDB.plugin(MemoryAdapter);
PouchDB.plugin(HttpAdapter);
PouchDB.plugin(replication);

function loadEnv() {
    const loadEnvFile = (path: string) => (existsSync(path) ? parseEnv(readFileSync(path, "utf-8")) : {});
    const defEnv = loadEnvFile(".env");
    const testEnv = loadEnvFile(".test.env");
    return Object.assign({}, defEnv, testEnv, process.env);
}

const env = loadEnv();
const hostname = env.hostname || "http://localhost:5989/";
const username = env.username || "admin";
const password = env.password || "testpassword";
const auth = { username, password };
let sequence = 0;
const pathService = new PathServiceCompat(new ServiceContext(), {
    settingService: {
        currentSettings: () => ({
            ...DEFAULT_SETTINGS,
            pathNormalizationVersion: 1,
            handleFilenameCaseSensitive: false,
            encrypt: false,
            usePathObfuscation: false,
        }),
    } as ISettingService,
});

function subjectFor(database: PouchDB.Database<EntryDoc>): LiveSyncLocalDB {
    const subject = Object.create(LiveSyncLocalDB.prototype) as LiveSyncLocalDB;
    Object.assign(subject, { localDatabase: database });
    return subject;
}

async function listMetadata(database: PouchDB.Database<EntryDoc>, conflicts = false) {
    const entries: EntryDoc[] = [];
    for await (const entry of subjectFor(database).findAllDocs({ conflicts })) entries.push(entry);
    return entries;
}

async function withDatabases(
    run: (remote: PouchDB.Database<EntryDoc>, local: PouchDB.Database<EntryDoc>) => Promise<void>
) {
    const name = `path-identity-deletion-${process.pid}-${++sequence}`;
    const remote = new PouchDB<EntryDoc>(new URL(name, hostname).toString(), { auth });
    const local = new PouchDB<EntryDoc>(`${name}-local`, { adapter: "memory" });
    try {
        await remote.info();
        await run(remote, local);
    } finally {
        await local.destroy();
        await remote.destroy();
    }
}

beforeAll(async () => {
    const deadline = Date.now() + 30_000;
    while (true) {
        try {
            const response = await fetch(hostname, {
                headers: {
                    Authorization: `Basic ${Buffer.from(`${auth.username}:${auth.password}`).toString("base64")}`,
                },
            });
            if (response.ok) {
                return;
            }
        } catch {
            // Allow the isolated test server to finish starting.
        }
        if (Date.now() >= deadline) throw new Error("The isolated CouchDB test server did not become ready");
        await delay(500);
    }
}, 35_000);

describe("NFC Metadata deletion preflight with CouchDB", () => {
    it.each(pathIdentityDeletionCases)("checks $name Metadata before local database replacement", async (scenario) => {
        await withDatabases(async (remote, local) => {
            await seedPathIdentityDeletionCase(remote, scenario);
            await remote.replicate.to(local);

            const remoteEntries = await listMetadata(remote);
            const localEntries = await listMetadata(local);
            expect(remoteEntries).toHaveLength(scenario.count);
            expect(localEntries).toHaveLength(scenario.count);
            expect(localEntries.map((entry) => entry._id)).toEqual(remoteEntries.map((entry) => entry._id));
            const conflictsAwareEntries = await listMetadata(local, true);
            const before = await local.info();
            const preflight = assertMetadataPathIdentities(conflictsAwareEntries, pathService, false);
            if (scenario.expectedCollision) await expect(preflight).rejects.toThrow(/File path identity collision/);
            else await expect(preflight).resolves.toBeUndefined();
            expect((await local.info()).update_seq).toBe(before.update_seq);

            if (scenario.name.startsWith("logically deleted winner")) {
                expect(conflictsAwareEntries.find((entry) => entry._id === decomposedPath)?._conflicts).toEqual([
                    "2-aaaa",
                ]);
                expect(conflictsAwareEntries.find((entry) => entry._id === decomposedPath)?.deleted).toBe(true);
            }
        });
    });

    it.each([false, true])(
        "uses the production deletion API with deleteMetadataOfDeletedFiles=%s",
        async (tombstone) => {
            await withDatabases(async (remote, local) => {
                await seedPathIdentityDeletionCase(remote, pathIdentityDeletionCases[0]);
                await remote.replicate.to(local);
                const settings = {
                    ...DEFAULT_SETTINGS,
                    pathNormalizationVersion: 0 as const,
                    encrypt: false,
                    usePathObfuscation: false,
                    handleFilenameCaseSensitive: false,
                    deleteMetadataOfDeletedFiles: tombstone,
                };
                const settingService = { currentSettings: () => settings } as ISettingService;
                const legacyPathService = new PathServiceCompat(new ServiceContext(), { settingService });
                expect(
                    await deleteDBEntryByPath(
                        { services: { path: legacyPathService, setting: settingService }, serviceModules: {} },
                        { localDatabase: local },
                        decomposedPath
                    )
                ).toBe(true);
                await local.replicate.to(remote);
                const localEntries = await listMetadata(local, true);
                const preflight = assertMetadataPathIdentities(localEntries, pathService, false);
                await expect(preflight).resolves.toBeUndefined();
                expect(localEntries).toHaveLength(tombstone ? 1 : 2);
                if (!tombstone) {
                    expect(localEntries.find((entry) => entry._id === decomposedPath)?.deleted).toBe(true);
                }
                expect(await listMetadata(remote)).toHaveLength(tombstone ? 1 : 2);
            });
        }
    );

    it("stops on a stale local duplicate even after the remote document has been tombstoned", async () => {
        await withDatabases(async (remote, local) => {
            await seedPathIdentityDeletionCase(remote, pathIdentityDeletionCases[0]);
            await remote.replicate.to(local);
            await remote.remove(await remote.get(decomposedPath));

            expect((await listMetadata(remote)).map((entry) => entry._id)).toEqual([composedPath]);
            expect(await listMetadata(local)).toHaveLength(2);
            await expect(
                assertMetadataPathIdentities(subjectFor(local).findAllDocs({ conflicts: true }), pathService, false)
            ).rejects.toThrow(/File path identity collision/);

            await remote.replicate.to(local);

            expect((await listMetadata(local)).map((entry) => entry._id)).toEqual([composedPath]);
            await expect(
                assertMetadataPathIdentities(subjectFor(local).findAllDocs({ conflicts: true }), pathService, false)
            ).resolves.toBeUndefined();
        });
    });

    it("continues to accept resolved logical deletion after its CouchDB deletion is replicated", async () => {
        await withDatabases(async (remote, local) => {
            await seedPathIdentityDeletionCase(remote, pathIdentityDeletionCases[1]);
            await remote.replicate.to(local);
            await expect(
                assertMetadataPathIdentities(subjectFor(local).findAllDocs({ conflicts: true }), pathService, false)
            ).resolves.toBeUndefined();

            await remote.remove(await remote.get(decomposedPath));
            await remote.replicate.to(local);

            await expect(
                assertMetadataPathIdentities(subjectFor(local).findAllDocs({ conflicts: true }), pathService, false)
            ).resolves.toBeUndefined();
        });
    });
});
