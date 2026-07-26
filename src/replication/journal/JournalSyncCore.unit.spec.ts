import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import PouchDB from "pouchdb-core";
import MemoryAdapter from "pouchdb-adapter-memory";
import { JournalSyncCore } from "./JournalSyncCore.ts";
import type { IJournalStorage } from "./objectstore/JournalStorageAdapter.ts";
import type { LiveSyncJournalReplicatorEnv } from "./LiveSyncJournalReplicatorEnv.ts";
import {
    DEFAULT_SETTINGS,
    type BucketSyncSetting,
    type EntryDoc,
    ProtocolVersions,
    DOCID_JOURNAL_SYNC_PARAMETERS,
    type DocumentID,
    type FilePathWithPrefix,
    type PlainEntry,
} from "@lib/common/types.ts";
import { type SimpleStore, pickBucketSyncSettings } from "@lib/common/utils.ts";
import { CheckPointInfoDefault, type CheckPointInfo } from "./JournalSyncTypes.ts";
import { wrappedDeflate, wrappedInflate } from "@lib/pouchdb/compress.ts";
import { REMOTE_CHUNK_FETCHED } from "@lib/pouchdb/LiveSyncLocalDB.ts";
import { createServiceContext } from "@lib/services/base/ServiceBase.ts";

PouchDB.plugin(MemoryAdapter);

describe("JournalSyncCore", () => {
    let dbCounter = 0;
    let localDB: PouchDB.Database<EntryDoc>;
    let env: LiveSyncJournalReplicatorEnv;
    let mockStorage: IJournalStorage;
    let core: JournalSyncCore;
    let virtualStorage: Map<string, Uint8Array>;
    let context: ReturnType<typeof createServiceContext>;

    beforeEach(async () => {
        dbCounter++;
        localDB = new PouchDB(`test_db_${dbCounter}`, { adapter: "memory" });
        virtualStorage = new Map();
        context = createServiceContext();

        mockStorage = {
            upload: vi.fn(async (file: string, buffer: Uint8Array) => {
                virtualStorage.set(file, buffer);
                return true;
            }),
            download: vi.fn(async (file: string) => {
                const data = virtualStorage.get(file);
                if (data === undefined) return false;
                return data;
            }),
            listFiles: vi.fn(async () => {
                return Array.from(virtualStorage.keys());
            }),
            deleteFile: vi.fn(async (file: string) => {
                virtualStorage.delete(file);
            }),
        } as unknown as IJournalStorage;

        env = {
            services: {
                context,
                database: {
                    localDatabase: {
                        localDatabase: localDB,
                    },
                },
                setting: {
                    currentSettings: () => ({ ...DEFAULT_SETTINGS }),
                },
                replicator: {
                    replicationStatics: {
                        value: {
                            sent: 0,
                            arrived: 0,
                            maxPullSeq: 0,
                            maxPushSeq: 0,
                            lastSyncPullSeq: 0,
                            lastSyncPushSeq: 0,
                            syncStatus: "NOT_CONNECTED",
                        },
                    },
                },
            },
        } as unknown as LiveSyncJournalReplicatorEnv;

        const store = {
            get: vi.fn(async () => ({ ...CheckPointInfoDefault })),
            set: vi.fn(async () => {}),
            keys: vi.fn(async () => []),
            delete: vi.fn(async () => {}),
        } as unknown as SimpleStore<CheckPointInfo>;

        const settings: BucketSyncSetting = pickBucketSyncSettings(DEFAULT_SETTINGS);
        core = new JournalSyncCore(settings, store, env, mockStorage);
    });

    afterEach(async () => {
        await localDB.destroy();
    });

    describe("getSyncParameters", () => {
        it("throws SyncParamsNotFoundError if sync parameters do not exist in storage", async () => {
            await expect(core.getSyncParameters()).rejects.toThrowError("Missing sync parameters");
        });

        it("returns downloaded sync parameters", async () => {
            const params = { ...DEFAULT_SETTINGS, protocolVersion: ProtocolVersions.ADVANCED_E2EE, pbkdf2salt: "salt" };
            virtualStorage.set(DOCID_JOURNAL_SYNC_PARAMETERS, new TextEncoder().encode(JSON.stringify(params)));

            const fetched = await core.getSyncParameters();
            expect(fetched.pbkdf2salt).toBe("salt");
        });
    });

    describe("sendLocalJournal", () => {
        it("should upload chunk properly via streams", async () => {
            // Insert some documents into local DB
            await localDB.bulkDocs([
                {
                    _id: "doc1" as DocumentID,
                    type: "plain",
                    path: "doc1" as FilePathWithPrefix,
                    children: [],
                    ctime: Date.now(),
                    mtime: Date.now(),
                    size: 0,
                    eden: {},
                } as PlainEntry,
                {
                    _id: "doc2" as DocumentID,
                    type: "plain",
                    path: "doc2" as FilePathWithPrefix,
                    children: [],
                    ctime: Date.now(),
                    mtime: Date.now(),
                    size: 0,
                    eden: {},
                } as PlainEntry,
            ]);

            core.processReplication = async () => true;

            await core.sendLocalJournal(true);

            // Check that it uploaded a chunk
            const uploadedFiles = Array.from(virtualStorage.keys());
            const chunks = uploadedFiles.filter((f) => f.endsWith(".jsonl.gz"));
            expect(chunks.length).toBe(1); // Should have created at least 1 chunk

            const compressedData = virtualStorage.get(chunks[0])!;
            expect(compressedData).toBeInstanceOf(Uint8Array);

            // Decompress and verify
            const decompressed = await wrappedInflate(compressedData as Uint8Array<ArrayBuffer>, {});
            const text = new TextDecoder().decode(decompressed);

            expect(text).toContain("doc1");
            expect(text).toContain("doc2");
        });
    });

    describe("receiveRemoteJournal", () => {
        it("should parse and apply incoming documents with new_edits: false", async () => {
            // Put a mock compressed chunk into virtual storage
            const mockDoc = {
                _id: "remote_doc",
                _rev: "1-abc",
                data: "remote data",
                _revisions: {
                    start: 1,
                    ids: ["abc"],
                },
            };
            const rawData = JSON.stringify(mockDoc) + "\n";
            const compressedData = await wrappedDeflate(new TextEncoder().encode(rawData), {});

            virtualStorage.set("test_hash-0000000000000-12345.md", compressedData);

            core.processReplication = async () => true;

            await core.receiveRemoteJournal(true);

            // Verify it was applied to the database
            const localDoc = await localDB.get("remote_doc");
            expect(localDoc).toBeDefined();
            expect(localDoc._rev).toBe("1-abc");
        });
    });

    describe("processDocuments", () => {
        it("announces fetched chunks through the owning service context", async () => {
            const listener = vi.fn();
            context.events.onEvent(REMOTE_CHUNK_FETCHED, listener);

            await core.processDocuments([
                {
                    _id: "h:chunk" as DocumentID,
                    _rev: "1-chunk",
                    type: "leaf",
                    data: "chunk-data",
                },
            ]);

            expect(listener).toHaveBeenCalledWith(expect.objectContaining({ _id: "h:chunk" }));
        });
    });
});
