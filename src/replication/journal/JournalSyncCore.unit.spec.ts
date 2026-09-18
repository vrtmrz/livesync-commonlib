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
import { LiveSyncError } from "@lib/common/LSError.ts";
import {
    createSyncParamsHanderForServer,
    SyncParamsFetchError,
    SyncParamsNotFoundError,
} from "@lib/replication/SyncParamsHandler.ts";

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
            applyNewConfig: vi.fn(),
            upload: vi.fn(async (file: string, buffer: Uint8Array) => {
                virtualStorage.set(file, buffer);
                return true;
            }),
            download: vi.fn(async (file: string) => {
                const data = virtualStorage.get(file);
                if (data === undefined) return false;
                return data;
            }),
            downloadWithResult: vi.fn(async (file: string) => {
                const data = virtualStorage.get(file);
                if (data === undefined) return { status: "not-found" as const };
                return { status: "available" as const, value: data };
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

        it("does not report an unavailable read as missing sync parameters", async () => {
            const unavailable = new Error("temporary object-storage failure");
            vi.mocked(mockStorage.downloadWithResult).mockResolvedValueOnce({
                status: "unavailable",
                error: unavailable,
            });

            const failure = await core.getSyncParameters().catch((error: unknown) => error);

            expect(LiveSyncError.isCausedBy(failure, SyncParamsFetchError)).toBe(true);
            expect(LiveSyncError.isCausedBy(failure, SyncParamsNotFoundError)).toBe(false);
            expect(mockStorage.downloadWithResult).toHaveBeenCalledWith(DOCID_JOURNAL_SYNC_PARAMETERS, true);
            expect(mockStorage.download).not.toHaveBeenCalled();
        });

        it("does not create or upload synchronisation parameters after an unavailable read", async () => {
            vi.mocked(mockStorage.downloadWithResult).mockResolvedValue({
                status: "unavailable",
                error: new Error("temporary object-storage failure"),
            });

            await expect(core.getReplicationPBKDF2Salt(true)).rejects.toThrow(SyncParamsFetchError);

            expect(mockStorage.upload).not.toHaveBeenCalled();
        });

        it("returns downloaded sync parameters", async () => {
            const params = { ...DEFAULT_SETTINGS, protocolVersion: ProtocolVersions.ADVANCED_E2EE, pbkdf2salt: "salt" };
            virtualStorage.set(DOCID_JOURNAL_SYNC_PARAMETERS, new TextEncoder().encode(JSON.stringify(params)));

            const fetched = await core.getSyncParameters();
            expect(fetched.pbkdf2salt).toBe("salt");
        });
    });

    it("reuses the fresh Journal parameter read for the first encrypted file", async () => {
        const params = {
            protocolVersion: ProtocolVersions.ADVANCED_E2EE,
            pbkdf2salt: btoa("0123456789abcdef0123456789abcdef"),
        };
        virtualStorage.set(DOCID_JOURNAL_SYNC_PARAMETERS, new TextEncoder().encode(JSON.stringify(params)));

        await core.ensureCheckpointCachesAreFresh();
        await core.getReplicationPBKDF2Salt();

        expect(mockStorage.downloadWithResult).toHaveBeenCalledTimes(1);
    });

    it("refreshes the Journal parameters for the next transfer", async () => {
        const firstSalt = btoa("0123456789abcdef0123456789abcdef");
        const nextSalt = btoa("fedcba9876543210fedcba9876543210");
        const storeParams = (pbkdf2salt: string) =>
            virtualStorage.set(
                DOCID_JOURNAL_SYNC_PARAMETERS,
                new TextEncoder().encode(
                    JSON.stringify({ protocolVersion: ProtocolVersions.ADVANCED_E2EE, pbkdf2salt })
                )
            );
        storeParams(firstSalt);
        await core.ensureCheckpointCachesAreFresh();
        expect(await core.getReplicationPBKDF2Salt()).toEqual(
            new TextEncoder().encode("0123456789abcdef0123456789abcdef")
        );

        core.resetAllCaches();
        storeParams(nextSalt);
        await core.ensureCheckpointCachesAreFresh();

        expect(await core.getReplicationPBKDF2Salt()).toEqual(
            new TextEncoder().encode("fedcba9876543210fedcba9876543210")
        );
        expect(mockStorage.downloadWithResult).toHaveBeenCalledTimes(2);
    });

    it("keeps one Journal client's prepared parameters when another client is constructed", async () => {
        const params = {
            protocolVersion: ProtocolVersions.ADVANCED_E2EE,
            pbkdf2salt: btoa("0123456789abcdef0123456789abcdef"),
        };
        virtualStorage.set(DOCID_JOURNAL_SYNC_PARAMETERS, new TextEncoder().encode(JSON.stringify(params)));

        await core.ensureCheckpointCachesAreFresh();
        new JournalSyncCore(core._settings, core.store, env, mockStorage);
        await core.getReplicationPBKDF2Salt();

        expect(mockStorage.downloadWithResult).toHaveBeenCalledTimes(1);
    });

    it("does not evict another server's parameter handler during Journal setup", () => {
        const key = `other-server-${dbCounter}`;
        const options = {
            get: vi.fn(async () => ({ protocolVersion: ProtocolVersions.ADVANCED_E2EE, pbkdf2salt: "salt" })),
            put: vi.fn(async () => true),
            create: vi.fn(async () => ({ protocolVersion: ProtocolVersions.ADVANCED_E2EE, pbkdf2salt: "" })),
        };
        const existingHandler = createSyncParamsHanderForServer(key, options);

        new JournalSyncCore(core._settings, core.store, env, mockStorage);
        core.applyNewConfig(core._settings, core.store, env);

        expect(createSyncParamsHanderForServer(key, options)).toBe(existingHandler);
    });

    it("stops before any remote write when Journal parameters are unavailable", async () => {
        vi.mocked(mockStorage.downloadWithResult).mockResolvedValue({
            status: "unavailable",
            error: new Error("temporary object-storage failure"),
        });

        await expect(core.ensureCheckpointCachesAreFresh()).rejects.toThrow(SyncParamsFetchError);

        expect(mockStorage.upload).not.toHaveBeenCalled();
    });

    it("keeps the fresh parameter snapshot when a changed epoch resets Journal checkpoints", async () => {
        const params = {
            protocolVersion: ProtocolVersions.ADVANCED_E2EE,
            pbkdf2salt: btoa("0123456789abcdef0123456789abcdef"),
        };
        virtualStorage.set(DOCID_JOURNAL_SYNC_PARAMETERS, new TextEncoder().encode(JSON.stringify(params)));
        vi.mocked(core.store.get).mockResolvedValue({
            ...CheckPointInfoDefault,
            journalEpoch: "old-epoch",
            sentFiles: new Set(["last-sent-file"]),
        });

        await core.ensureCheckpointCachesAreFresh();
        await core.getReplicationPBKDF2Salt();

        expect(mockStorage.downloadWithResult).toHaveBeenCalledTimes(1);
        expect(core.store.set).toHaveBeenCalledWith(
            expect.any(String),
            expect.objectContaining({
                journalEpoch: `${params.protocolVersion}:${params.pbkdf2salt}`,
                sentFiles: new Set(),
            })
        );
    });

    describe("downloadJsonWithResult", () => {
        it("preserves a missing-object result", async () => {
            await expect(core.downloadJsonWithResult("missing.json")).resolves.toEqual({ status: "not-found" });
        });

        it("parses available JSON", async () => {
            virtualStorage.set("available.json", new TextEncoder().encode('{"value":42}'));

            await expect(core.downloadJsonWithResult<{ value: number }>("available.json")).resolves.toEqual({
                status: "available",
                value: { value: 42 },
            });
        });

        it("reports invalid JSON as unavailable", async () => {
            virtualStorage.set("invalid.json", new TextEncoder().encode("not-json"));

            const result = await core.downloadJsonWithResult("invalid.json");

            expect(result.status).toBe("unavailable");
            if (result.status === "unavailable") expect(result.error).toBeInstanceOf(SyntaxError);
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

    describe("resetBucket", () => {
        it("reports failure when deleting listed files returns false", async () => {
            const listFiles = vi
                .spyOn(mockStorage, "listFiles")
                .mockResolvedValueOnce(["journal.jsonl.gz"])
                .mockResolvedValueOnce([])
                .mockResolvedValueOnce([]);
            const deleteFiles = vi.fn(async () => false);
            mockStorage.deleteFiles = deleteFiles;

            await expect(core.resetBucket()).resolves.toBe(false);

            expect(deleteFiles).toHaveBeenCalledOnce();
            expect(listFiles).toHaveBeenCalledWith("", 100);
        });
    });
});
