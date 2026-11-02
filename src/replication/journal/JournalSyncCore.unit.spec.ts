import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import PouchDB from "pouchdb-core";
import MemoryAdapter from "pouchdb-adapter-memory";
import { JournalSyncCore } from "./JournalSyncCore.ts";
import type { IJournalStorage } from "./objectstore/JournalStorageAdapter.ts";
import type { LiveSyncJournalReplicatorEnv } from "./LiveSyncJournalReplicatorEnv.ts";
import {
    DEFAULT_SETTINGS,
    VERSIONING_DOCID,
    type BucketSyncSetting,
    type EntryDoc,
    ProtocolVersions,
    DOCID_JOURNAL_SYNC_PARAMETERS,
    type DocumentID,
    type FilePathWithPrefix,
    type PlainEntry,
    type EntryLeaf,
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
            listFiles: vi.fn(async (from: string, limit?: number) => {
                return Array.from(virtualStorage.keys())
                    .sort()
                    .filter((key) => key > (from || ""))
                    .slice(0, limit);
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

    it.each(["sendLocalJournal", "receiveRemoteJournal"] as const)(
        "%s rejects incompatible local identity before a Journal transfer",
        async (operation) => {
            await localDB.put({
                _id: VERSIONING_DOCID,
                type: "versioninfo",
                version: 13,
                used_features: ["nfc-path-identity-v1"],
            } as EntryDoc);

            await expect(core[operation]()).rejects.toThrow(/path identity/);
            expect(mockStorage.upload).not.toHaveBeenCalled();
            expect(mockStorage.listFiles).not.toHaveBeenCalled();
        }
    );

    it.each(["sendLocalJournal", "receiveRemoteJournal"] as const)(
        "%s requires Rebuild for legacy local Metadata before NFC transfer",
        async (operation) => {
            env.services.setting.currentSettings = () => ({ ...DEFAULT_SETTINGS, pathNormalizationVersion: 1 });
            await localDB.put({ _id: "cafe\u0301.md", type: "plain", path: "cafe\u0301.md" } as EntryDoc);

            await expect(core[operation]()).rejects.toThrow(/path identity/);
            expect(mockStorage.upload).not.toHaveBeenCalled();
            expect(mockStorage.listFiles).not.toHaveBeenCalled();
        }
    );

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

    describe("chunk data round trips", () => {
        it.each([
            ["empty data", ""],
            ["ordinary text", "plain chunk data"],
            ["literal escape sequences", String.raw`before\x1f\u001fafter`],
            ["a leading unit separator", "\u001fbefore"],
            ["an embedded unit separator", "before\u001fafter"],
            ["a trailing unit separator", "before\u001f"],
            ["consecutive unit separators", "before\u001f\u001fafter"],
            ["newlines, backslashes, and Unicode", "先頭\n\r\\\u001f末尾😀\u001f\n"],
            ["the reported chunk dimensions", "a".repeat(503) + "\u001f" + "b".repeat(3912)],
        ])("preserves %s through upload and reception", async (_description, data) => {
            const chunkId = `h:round-trip-${dbCounter}` as DocumentID;
            const chunk: EntryLeaf = { _id: chunkId, type: "leaf", data };
            await localDB.put(chunk);
            await expect(core.sendLocalJournal()).resolves.toBe(true);

            const receiverDB = new PouchDB<EntryDoc>(`receiver_db_${dbCounter}`, { adapter: "memory" });
            let checkpoint: CheckPointInfo = {
                ...CheckPointInfoDefault,
                knownIDs: new Set(),
                sentIDs: new Set(),
                receivedFiles: new Set(),
                sentFiles: new Set(),
            };
            const receiverStore: SimpleStore<CheckPointInfo> = {
                get: async () => checkpoint,
                set: async (_key, value) => {
                    checkpoint = value;
                },
                keys: async () => [],
                delete: async () => {},
            };
            const receiverEnv = {
                services: {
                    ...env.services,
                    database: { localDatabase: { localDatabase: receiverDB } },
                },
            } as unknown as LiveSyncJournalReplicatorEnv;
            const receiver = new JournalSyncCore(core._settings, receiverStore, receiverEnv, mockStorage);
            receiver.processReplication = async () => true;
            try {
                await expect(receiver.receiveRemoteJournal()).resolves.toBe(true);
                const received = await receiverDB.get<EntryLeaf>(chunkId);
                expect(received.type).toBe("leaf");
                expect(new TextEncoder().encode(received.data)).toEqual(new TextEncoder().encode(data));
            } finally {
                await receiverDB.destroy();
            }
        });
    });

    describe("receiveRemoteJournal", () => {
        it("rejects a chunk record without its ID separator without acknowledging the batch", async () => {
            virtualStorage.set(
                `malformed-${dbCounter}.jsonl.gz`,
                await wrappedDeflate(new TextEncoder().encode("~h:missing-separator\n"), {})
            );
            core.processReplication = async () => true;

            await expect(core.receiveRemoteJournal()).resolves.toBe(false);

            expect((await localDB.allDocs()).rows).toEqual([]);
            expect(core.store.set).not.toHaveBeenCalled();
        });

        it("preserves unit separators in an existing batch alongside escaped and JSON records", async () => {
            const firstId = `h:legacy-raw-${dbCounter}`;
            const secondId = `h:legacy-escaped-${dbCounter}`;
            const metadata = {
                _id: `legacy-file-${dbCounter}`,
                _rev: "1-legacy",
                type: "plain",
                path: "legacy.md",
                children: [firstId, secondId],
                _revisions: { start: 1, ids: ["legacy"] },
            };
            const rawBatch =
                `~${firstId}\u001fbefore\u001fafter\u001f\n` +
                `~${secondId}\u001f\\fline\\n\\r\\\\\u001ftail\n` +
                JSON.stringify(metadata) +
                "\n";
            virtualStorage.set(
                `legacy-${dbCounter}.jsonl.gz`,
                await wrappedDeflate(new TextEncoder().encode(rawBatch), {})
            );
            core.processReplication = async () => true;

            await expect(core.receiveRemoteJournal()).resolves.toBe(true);

            expect((await localDB.get<EntryLeaf>(firstId)).data).toBe("before\u001fafter\u001f");
            expect((await localDB.get<EntryLeaf>(secondId)).data).toBe("line\n\r\\\u001ftail");
            expect(await localDB.get(metadata._id, { revs: true })).toMatchObject(metadata);
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
    });

    describe("resetBucket", () => {
        it.each(["partial response", "transport error"])(
            "retains control documents and checkpoints after a failed Journal deletion: %s",
            async (failure) => {
                const journal = "1793597000000-docs.jsonl.gz";
                const deletedJournal = "1793596999000-docs.jsonl.gz";
                const milestone = "_00000000-milestone.json";
                const control = new Uint8Array([2]);
                virtualStorage.set(journal, new Uint8Array([1]));
                virtualStorage.set(deletedJournal, new Uint8Array([3]));
                virtualStorage.set(milestone, control);
                virtualStorage.set(DOCID_JOURNAL_SYNC_PARAMETERS, control);
                mockStorage.deleteFiles = vi.fn(async (files) => {
                    for (const file of files) {
                        if (file !== journal) virtualStorage.delete(file);
                    }
                    if (failure === "transport error") throw new Error("Interrupted deletion");
                    return !files.includes(journal);
                });

                await expect(core.resetBucket()).resolves.toBe(false);
                expect(virtualStorage.has(deletedJournal)).toBe(false);
                expect(virtualStorage.get(journal)).toEqual(new Uint8Array([1]));
                expect(virtualStorage.get(milestone)).toEqual(control);
                expect(virtualStorage.get(DOCID_JOURNAL_SYNC_PARAMETERS)).toEqual(control);
                expect(core.store.set).not.toHaveBeenCalled();

                mockStorage.deleteFiles = vi.fn(async (files) => {
                    for (const file of files) virtualStorage.delete(file);
                    return true;
                });
                await expect(core.resetBucket()).resolves.toBe(true);
                expect(virtualStorage.size).toBe(0);
                expect(core.store.set).toHaveBeenCalledOnce();
            }
        );

        it("deletes all Journal pages before any control document, including after a page of controls", async () => {
            for (let index = 0; index < 105; index++) {
                virtualStorage.set(`${1793597000000 + index}-docs.jsonl.gz`, new Uint8Array([index]));
                virtualStorage.set(`_control-${String(index).padStart(3, "0")}.json`, new Uint8Array([index]));
            }
            virtualStorage.set("z-last-journal.jsonl.gz", new Uint8Array([1]));
            virtualStorage.set("_00000000-milestone.json", new Uint8Array([2]));
            mockStorage.deleteFiles = vi.fn(async (files) => {
                expect(files.length).toBeLessThanOrEqual(100);
                if (files.some((file) => file.startsWith("_"))) {
                    expect([...virtualStorage.keys()].filter((key) => !key.startsWith("_"))).toEqual([]);
                }
                for (const file of files) virtualStorage.delete(file);
                return true;
            });

            await expect(core.resetBucket()).resolves.toBe(true);
            expect(virtualStorage.size).toBe(0);
            expect(core.store.set).toHaveBeenCalledOnce();
            expect(vi.mocked(mockStorage.listFiles).mock.calls.filter(([from]) => from === "")).toHaveLength(1);
        });

        it.each(["repeated", "backwards"])(
            "rejects a %s listing cursor without deleting retained control documents",
            async (cursor) => {
                const milestone = "_00000000-milestone.json";
                const journal = "z-journal.jsonl.gz";
                const control = new Uint8Array([2]);
                virtualStorage.set(milestone, control);
                virtualStorage.set(journal, new Uint8Array([1]));
                vi.mocked(mockStorage.listFiles)
                    .mockResolvedValueOnce([milestone, journal])
                    .mockResolvedValueOnce(cursor === "repeated" ? [milestone, journal] : [milestone])
                    .mockResolvedValue([]);
                mockStorage.deleteFiles = vi.fn(async (files) => {
                    for (const file of files) virtualStorage.delete(file);
                    return true;
                });

                await expect(core.resetBucket()).resolves.toBe(false);
                expect(mockStorage.listFiles).toHaveBeenCalledTimes(2);
                expect(mockStorage.deleteFiles).toHaveBeenCalledExactlyOnceWith([journal]);
                expect(virtualStorage.get(milestone)).toEqual(control);
                expect(core.store.set).not.toHaveBeenCalled();
            }
        );

        it("retains checkpoints until control document deletion also succeeds", async () => {
            virtualStorage.set("1793597000000-docs.jsonl.gz", new Uint8Array([1]));
            virtualStorage.set("_00000000-milestone.json", new Uint8Array([2]));
            mockStorage.deleteFiles = vi.fn(async (files) => {
                for (const file of files) {
                    if (!file.startsWith("_")) virtualStorage.delete(file);
                }
                return !files.some((file) => file.startsWith("_"));
            });

            await expect(core.resetBucket()).resolves.toBe(false);
            expect([...virtualStorage.keys()]).toEqual(["_00000000-milestone.json"]);
            expect(core.store.set).not.toHaveBeenCalled();
        });

        it.each([false, true])("resets transfer progress after clearing a bucket (populated: %s)", async (populated) => {
            let checkpoint = { ...CheckPointInfoDefault };
            vi.spyOn(core.store, "get").mockImplementation(async () => checkpoint);
            vi.spyOn(core.store, "set").mockImplementation(async (_key, value) => {
                checkpoint = value;
            });
            await core.updateCheckPointInfo(() => ({
                lastLocalSeq: 42,
                journalEpoch: "old-epoch",
                knownIDs: new Set(["known"]),
                sentIDs: new Set(["sent"]),
                receivedFiles: new Set(["received.jsonl.gz"]),
                sentFiles: new Set(["sent.jsonl.gz"]),
            }));
            if (populated) virtualStorage.set("journal.jsonl.gz", new Uint8Array([1]));
            mockStorage.deleteFiles = vi.fn(async (files) => {
                for (const file of files) virtualStorage.delete(file);
                return true;
            });

            await expect(core.resetBucket()).resolves.toBe(true);

            expect(await core.getCheckpointInfo()).toEqual({
                lastLocalSeq: 0,
                journalEpoch: "",
                knownIDs: new Set(),
                sentIDs: new Set(),
                receivedFiles: new Set(),
                sentFiles: new Set(),
            });
            expect(virtualStorage.size).toBe(0);
        });

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
