import { describe, expect, it } from "vitest";
import PouchDB from "pouchdb-core";
import MemoryAdapter from "pouchdb-adapter-memory";
import { reactiveSource } from "octagonal-wheels/dataobject/reactive";
import {
    DEFAULT_SETTINGS,
    REMOTE_MINIO,
    VERSIONING_DOCID,
    type EntryDoc,
    type DocumentID,
    type FilePathWithPrefix,
    type PlainEntry,
    type RemoteDBSettings,
    type EntryLeaf,
} from "@lib/common/types.ts";
import { createServiceContext, ServiceContext } from "@lib/services/base/ServiceBase.ts";
import { PathServiceCompat } from "@lib/services/implements/injectable/InjectablePathService.ts";
import type { ISettingService } from "@lib/services/base/IService.ts";
import { LiveSyncJournalReplicator } from "../LiveSyncJournalReplicator.ts";
import { MinioStorageAdapter } from "./MinioStorageAdapter.ts";
import type { LiveSyncJournalReplicatorEnv } from "../LiveSyncJournalReplicatorEnv.ts";

PouchDB.plugin(MemoryAdapter);

describe.each([false, true])("NFC Journal transport with encryption and obfuscation %s", (encrypted) => {
    it("preserves IDs, contents, revision ancestry, and conflicts across transfer and restart", async () => {
        const nonce = crypto.randomUUID();
        const settings: RemoteDBSettings = {
            ...DEFAULT_SETTINGS,
            remoteType: REMOTE_MINIO,
            endpoint: process.env.minioEndpoint ?? "http://127.0.0.1:9000",
            accessKey: process.env.accessKey ?? "minioadmin",
            secretKey: process.env.secretKey ?? "minioadmin",
            bucket: process.env.bucketName ?? "livesync-test-bucket",
            bucketPrefix: `unicode-paths-${nonce}/`,
            region: "us-east-1",
            forcePathStyle: true,
            useCustomRequestHandler: false,
            pathNormalizationVersion: 1,
            encrypt: encrypted,
            usePathObfuscation: encrypted,
            passphrase: "journal-unicode-integration",
        };
        const source = new PouchDB<EntryDoc>(`nfc-source-${nonce}`, { adapter: "memory" });
        const target = new PouchDB<EntryDoc>(`nfc-target-${nonce}`, { adapter: "memory" });
        const sourceStore = new Map<string, unknown>();
        const targetStore = new Map<string, unknown>();
        const replicators: LiveSyncJournalReplicator[] = [];
        function createReplicator(
            db: PouchDB.Database<EntryDoc>,
            store: Map<string, unknown>,
            config: RemoteDBSettings,
            node: string
        ) {
            const env = {
                services: {
                    API: {
                        getAppVersion: () => "test",
                        getPluginVersion: () => "test",
                        getPlatform: () => "test",
                        getCustomFetchHandler: () => undefined,
                        requestCount: reactiveSource(0),
                        responseCount: reactiveSource(0),
                    },
                    context: createServiceContext(),
                    database: { localDatabase: { localDatabase: db } },
                    keyValueDB: {
                        simpleStore: {
                            get: async (key: string) =>
                                store.get(key) ?? {
                                    lastLocalSeq: 0,
                                    journalEpoch: "",
                                    knownIDs: new Set<string>(),
                                    sentIDs: new Set<string>(),
                                    receivedFiles: new Set<string>(),
                                    sentFiles: new Set<string>(),
                                },
                            set: async (key: string, value: unknown) => {
                                store.set(key, value);
                            },
                        },
                    },
                    replication: { parseSynchroniseResult: async () => true },
                    replicator: { replicationStatics: reactiveSource({}) },
                    setting: { currentSettings: () => config },
                    vault: { getVaultName: () => node, vaultName: () => node },
                },
            } as unknown as LiveSyncJournalReplicatorEnv;
            const replicator = new LiveSyncJournalReplicator(env);
            replicator.nodeid = node;
            replicators.push(replicator);
            return replicator;
        }
        const sender = createReplicator(source, sourceStore, settings, "source");
        let receiver = createReplicator(target, targetStore, settings, "target");
        const admin = new MinioStorageAdapter(settings, sender.env);
        const path = new PathServiceCompat(new ServiceContext(), {
            settingService: { currentSettings: () => settings } as ISettingService,
        });
        const physicalPath = "Cafe\u0301/re\u0301sume\u0301.md" as FilePathWithPrefix;
        const id = await path.path2id(physicalPath);
        expect(await path.path2id(physicalPath.normalize("NFC") as FilePathWithPrefix)).toBe(id);
        const firstChunk = { _id: "h:nfc-first" as DocumentID, type: "leaf", data: "first body" } as EntryLeaf;
        const secondChunk = { _id: "h:nfc-second" as DocumentID, type: "leaf", data: "edited body" } as EntryLeaf;
        const metadata: PlainEntry = {
            _id: id,
            type: "plain",
            path: physicalPath,
            children: [firstChunk._id],
            ctime: 1,
            mtime: 2,
            size: firstChunk.data.length,
            eden: {},
        };
        const sendAndReceive = async () => {
            expect(await sender.replicateAllToServer(settings)).toBe(true);
            expect(await receiver.replicateAllFromServer(settings)).toBe(true);
        };
        try {
            await source.put({
                _id: VERSIONING_DOCID,
                type: "versioninfo",
                version: 13,
                used_features: ["nfc-path-identity-v1"],
            } as EntryDoc);
            await source.put(firstChunk);
            const created = await source.put(metadata);
            await sendAndReceive();
            expect(await target.get(id)).toMatchObject({
                _rev: created.rev,
                path: physicalPath,
                children: [firstChunk._id],
            });
            expect((await target.get<EntryLeaf>(firstChunk._id)).data).toBe(firstChunk.data);

            await source.put(secondChunk);
            const edited = await source.put({
                ...metadata,
                _rev: created.rev,
                children: [secondChunk._id],
                mtime: 3,
                size: secondChunk.data.length,
            });
            await sendAndReceive();
            const received = await target.get(id, { revs: true });
            expect(received._rev).toBe(edited.rev);
            expect(received._revisions?.ids).toContain(created.rev.split("-")[1]);
            expect((await target.get<EntryLeaf>(secondChunk._id)).data).toBe(secondChunk.data);

            receiver.closeReplication();
            receiver = createReplicator(target, targetStore, settings, "target");
            const beforeRestart = (await target.info()).update_seq;
            await sendAndReceive();
            expect((await target.info()).update_seq).toBe(beforeRestart);

            const renamedPath = "Cafe\u0301/renamed.md" as FilePathWithPrefix;
            const renamedID = await path.path2id(renamedPath);
            const renamed = { ...metadata, _id: renamedID, path: renamedPath, children: [secondChunk._id], mtime: 4 };
            const renamedRev = await source.put(renamed);
            await source.put({ ...metadata, _rev: edited.rev, deleted: true, mtime: 4 });
            await sendAndReceive();
            expect(await target.get(id)).toMatchObject({ deleted: true });
            expect(await target.get(renamedID)).toMatchObject({ path: renamedPath, children: [secondChunk._id] });

            await source.bulkDocs(
                ["a", "b"].map((letter, index) => ({
                    ...renamed,
                    _rev: `2-${letter.repeat(32)}`,
                    _revisions: { start: 2, ids: [letter.repeat(32), renamedRev.rev.split("-")[1]] },
                    children: [index === 0 ? firstChunk._id : secondChunk._id],
                })),
                { new_edits: false }
            );
            await sendAndReceive();
            const leaves = await target.get<PlainEntry>(renamedID, { open_revs: "all", revs: true });
            const docs = leaves.flatMap((leaf) => ("ok" in leaf ? [leaf.ok] : []));
            expect(docs.map((doc) => doc.children[0]).sort()).toEqual([firstChunk._id, secondChunk._id].sort());
            expect(docs.every((doc) => doc._revisions?.ids.includes(renamedRev.rev.split("-")[1]))).toBe(true);

            const legacy = createReplicator(
                new PouchDB<EntryDoc>(`nfc-legacy-${nonce}`, { adapter: "memory" }),
                new Map(),
                { ...settings, pathNormalizationVersion: 0, disableCheckingConfigMismatch: true },
                "legacy"
            );
            try {
                expect(
                    await legacy.checkReplicationConnectivity(false, false, false, {
                        ...settings,
                        pathNormalizationVersion: 0,
                        disableCheckingConfigMismatch: true,
                    })
                ).toBe(false);
                const milestoneBefore = await admin.download("_00000000-milestone.json");
                const legacySettings = { ...settings, pathNormalizationVersion: 0 };
                await expect(legacy.markRemoteResolved(legacySettings)).rejects.toThrow(/path identity/i);
                await expect(legacy.markRemoteLocked(legacySettings, false, false)).rejects.toThrow(/path identity/i);
                expect(await admin.download("_00000000-milestone.json")).toEqual(milestoneBefore);
                expect(await receiver.checkReplicationConnectivity(false, false, false, settings)).toBe(true);
            } finally {
                await legacy.env.services.database.localDatabase.localDatabase.destroy();
            }
            await sender.tryResetRemoteDatabase(settings);
            expect(await sender.replicateAllToServer(settings)).toBe(true);
            const rebuilt = new PouchDB<EntryDoc>(`nfc-rebuilt-${nonce}`, { adapter: "memory" });
            try {
                const rebuiltReceiver = createReplicator(rebuilt, new Map(), settings, "rebuilt");
                expect(await rebuiltReceiver.replicateAllFromServer(settings)).toBe(true);
                expect(await rebuilt.get(id)).toMatchObject({ deleted: true });
                expect((await rebuilt.get<EntryLeaf>(firstChunk._id)).data).toBe(firstChunk.data);
                expect((await rebuilt.get<EntryLeaf>(secondChunk._id)).data).toBe(secondChunk.data);
                const rebuiltLeaves = await rebuilt.get<PlainEntry>(renamedID, { open_revs: "all", revs: true });
                const rebuiltDocs = rebuiltLeaves.flatMap((leaf) => ("ok" in leaf ? [leaf.ok] : []));
                expect(rebuiltDocs.map((doc) => doc.children[0]).sort()).toEqual([firstChunk._id, secondChunk._id].sort());
                expect(rebuiltDocs.every((doc) => doc._revisions?.ids.includes(renamedRev.rev.split("-")[1]))).toBe(true);
            } finally {
                await rebuilt.destroy();
            }
        } finally {
            for (const replicator of replicators) replicator.closeReplication();
            const files = await admin.listFiles("");
            if (files.length) await admin.deleteFiles(files);
            admin.dispose();
            await source.destroy();
            await target.destroy();
        }
    }, 60_000);
});
