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
import { createCheckPointInfoDefault, type CheckPointInfo } from "./JournalSyncTypes.ts";
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
    let store: SimpleStore<CheckPointInfo>;
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
            isAvailable: vi.fn(async () => true),
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

        store = {
            get: vi.fn(async () => createCheckPointInfoDefault()),
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

    it("does not share a missing checkpoint's mutable sets between Journal cores", async () => {
        const createEmptyStore = () =>
            ({
                delete: vi.fn(async () => {}),
                get: vi.fn(async () => undefined),
                keys: vi.fn(async () => []),
                set: vi.fn(async () => {}),
            }) as unknown as SimpleStore<CheckPointInfo>;
        const settings: BucketSyncSetting = pickBucketSyncSettings(DEFAULT_SETTINGS);
        const first = new JournalSyncCore(settings, createEmptyStore(), env, mockStorage);
        const second = new JournalSyncCore(settings, createEmptyStore(), env, mockStorage);

        const firstCheckpoint = await first.getCheckpointInfo();
        firstCheckpoint.sentFiles.add("sent-by-first.jsonl.gz");

        expect((await second.getCheckpointInfo()).sentFiles).not.toContain("sent-by-first.jsonl.gz");
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

    describe("Opaque control records", () => {
        it("refuses to read or write them when Adaptive data is present", async () => {
            mockStorage.inspectRemoteFormat = vi.fn(async () => "adaptive-v1");

            await expect(core.downloadJson("_00000000-milestone.json")).rejects.toMatchObject({
                code: "journal-storage-format-mismatch",
            });
            await expect(core.uploadJson("_00000000-milestone.json", {})).rejects.toMatchObject({
                code: "journal-storage-format-mismatch",
            });
            expect(mockStorage.download).not.toHaveBeenCalled();
            expect(mockStorage.upload).not.toHaveBeenCalled();
        });
    });

    describe("availability", () => {
        it("uses successful format inspection without issuing a redundant availability request", async () => {
            mockStorage.inspectRemoteFormat = vi.fn(async () => "opaque-v1");

            await expect(core.isAvailable()).resolves.toBe(true);
            expect(mockStorage.isAvailable).not.toHaveBeenCalled();
        });

        it("reuses one successful format inspection throughout an Opaque preflight", async () => {
            mockStorage.inspectRemoteFormat = vi.fn(async () => "opaque-v1");

            await expect(core.isAvailable()).resolves.toBe(true);
            await expect(core.uploadJson("_control.json", { ready: true })).resolves.toBe(true);
            await expect(core.downloadJson("_control.json")).resolves.toEqual({ ready: true });

            expect(mockStorage.inspectRemoteFormat).toHaveBeenCalledOnce();
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
        it("refuses to read an Adaptive remote through the Opaque Journal engine", async () => {
            mockStorage.inspectRemoteFormat = vi.fn(async () => "adaptive-v1");

            await expect(core.receiveRemoteJournal(true)).rejects.toMatchObject({
                code: "journal-storage-format-mismatch",
            });
            expect(mockStorage.listFiles).not.toHaveBeenCalled();
        });

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

        it("does not apply Metadata when a Chunk write returns an error", async () => {
            vi.spyOn(localDB, "bulkDocs").mockResolvedValueOnce([
                {
                    id: "h:chunk",
                    error: "forbidden",
                    status: 403,
                    name: "forbidden",
                    message: "forbidden",
                },
            ] as never);
            const processReplication = vi.fn(async () => true);
            core.processReplication = processReplication;

            const applied = await core.processDocuments([
                {
                    _id: "h:chunk" as DocumentID,
                    _rev: "1-chunk",
                    type: "leaf",
                    data: "chunk-data",
                },
                {
                    _id: "remote_doc" as DocumentID,
                    _rev: "1-remote",
                    _revisions: { start: 1, ids: ["remote"] },
                    type: "plain",
                    path: "remote.md" as FilePathWithPrefix,
                    children: ["h:chunk" as DocumentID],
                    ctime: 1,
                    mtime: 1,
                    size: 10,
                    eden: {},
                } as PlainEntry,
            ]);

            expect(applied).toBe(false);
            await expect(localDB.get("remote_doc")).rejects.toMatchObject({ status: 404 });
            expect(processReplication).not.toHaveBeenCalled();
        });

        it("does not apply Metadata when the Chunk write throws", async () => {
            vi.spyOn(localDB, "bulkDocs").mockRejectedValueOnce(new Error("Chunk database unavailable"));
            const processReplication = vi.fn(async () => true);
            core.processReplication = processReplication;

            const applied = await core.processDocuments([
                {
                    _id: "h:chunk" as DocumentID,
                    _rev: "1-chunk",
                    type: "leaf",
                    data: "chunk-data",
                },
                {
                    _id: "remote_doc" as DocumentID,
                    _rev: "1-remote",
                    _revisions: { start: 1, ids: ["remote"] },
                    type: "plain",
                    path: "remote.md" as FilePathWithPrefix,
                    children: ["h:chunk" as DocumentID],
                    ctime: 1,
                    mtime: 1,
                    size: 10,
                    eden: {},
                } as PlainEntry,
            ]);

            expect(applied).toBe(false);
            await expect(localDB.get("remote_doc")).rejects.toMatchObject({ status: 404 });
            expect(processReplication).not.toHaveBeenCalled();
        });
    });
});
