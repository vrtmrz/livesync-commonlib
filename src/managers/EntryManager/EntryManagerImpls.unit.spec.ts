import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import PouchDB from "pouchdb-core";
import MemoryAdapter from "pouchdb-adapter-memory";
import {
    createChunks,
    putDBEntry,
    isTargetFile,
    prepareChunk,
    getDBEntryMetaByPath,
    getDBEntryFromMeta,
    getDBEntryByPath,
    deleteDBEntryByPath,
    canUseOnDemandChunking,
    isLegacyNote,
} from "./EntryManagerImpls";
import type {
    DocumentID,
    EntryDoc,
    FilePathWithPrefix,
    LoadedEntry,
    SavingEntry,
    ObsidianLiveSyncSettings,
    NewEntry,
} from "@lib/common/types";
import { DEFAULT_SETTINGS, REMOTE_COUCHDB, IDPrefixes, ChunkAlgorithms } from "@lib/common/types";
import { LayeredChunkManager } from "../LayeredChunkManager";
import { HashManager } from "../HashManager/HashManager";
import type { IPathService, ISettingService } from "@lib/services/base/IService";
import { ContentSplitter } from "@lib/ContentSplitter/ContentSplitters";
import { createTextBlob, isDocContentSame } from "@lib/common/utils";
import type { NecessaryServicesInterfaces } from "@lib/interfaces/ServiceModule";
import type { WriteResult } from "../LayeredChunkManager/types";
import { ICHeader, ICXHeader, PSCHeader } from "@lib/common/models/fileaccess.const";

// Set up PouchDB with memory adapter
PouchDB.plugin(MemoryAdapter);
let dbCounter = 0;

/**
 * Create mock services for testing
 */
function createMockServices(settings: Partial<ObsidianLiveSyncSettings> = {}) {
    const fullSettings = {
        ...DEFAULT_SETTINGS,
        ...settings,
    } as ObsidianLiveSyncSettings;

    const mockSettingService: ISettingService = {
        currentSettings: vi.fn(() => fullSettings),
    } as unknown as ISettingService;

    const mockPathService: IPathService = {
        path2id: vi.fn((path: FilePathWithPrefix | string) => {
            return Promise.resolve(path as DocumentID);
        }),
        id2path: vi.fn((id: DocumentID) => {
            return id as unknown as FilePathWithPrefix;
        }),
    } as unknown as IPathService;

    return { mockSettingService, mockPathService, fullSettings };
}

/**
 * Create host object for functions that need NecessaryServicesInterfaces
 */
function createHost(mockSettingService: ISettingService, mockPathService?: IPathService) {
    return {
        services: {
            setting: mockSettingService,
            ...(mockPathService && { path: mockPathService }),
        },
        serviceModules: {},
    } as NecessaryServicesInterfaces<"setting" | "path", any>;
}

/**
 * Create a test SavingEntry
 */
function createSavingEntry(id: string, data: string | Blob, path?: FilePathWithPrefix): SavingEntry {
    return {
        _id: id as DocumentID,
        path: (path || id) as FilePathWithPrefix,
        data: data instanceof Blob ? data : createTextBlob(data),
        ctime: Date.now(),
        mtime: Date.now(),
        size: data instanceof Blob ? data.size : data.length,
        datatype: "plain",
        type: "plain",
        eden: {},
    } as SavingEntry;
}

describe("EntryManagerImpls", () => {
    let db: PouchDB.Database<EntryDoc>;
    let chunkManager: LayeredChunkManager;
    let hashManager: HashManager;
    let splitter: ContentSplitter;
    let mockSettingService: ISettingService;
    let mockPathService: IPathService;
    let changeManagerCallbacks: Set<(change: PouchDB.Core.ChangesResponseChange<EntryDoc>) => void>;

    beforeEach(async () => {
        // Create a unique in-memory database for each test
        dbCounter++;
        db = new PouchDB(`test-entry-impl-${dbCounter}`, { adapter: "memory" });

        // Create mock services
        const services = createMockServices({
            hashAlg: "xxhash64",
            chunkSplitterVersion: ChunkAlgorithms.RabinKarp,
            remoteType: REMOTE_COUCHDB,
            hashCacheMaxCount: 10,
            disableWorkerForGeneratingChunks: true, // Disable workers in unit tests
        });
        mockSettingService = services.mockSettingService;
        mockPathService = services.mockPathService;

        // Mock ChangeManager
        changeManagerCallbacks = new Set();
        const mockChangeManager = {
            addCallback: vi.fn((callback) => {
                changeManagerCallbacks.add(callback);
                return () => {
                    changeManagerCallbacks.delete(callback);
                };
            }),
        };

        // Create ChunkManager
        chunkManager = new LayeredChunkManager({
            database: db,
            changeManager: mockChangeManager as any,
            settingService: mockSettingService,
        });

        // Create HashManager
        hashManager = new HashManager({ settingService: mockSettingService });
        await hashManager.initialise();

        // Create ContentSplitter
        splitter = new ContentSplitter({ settingService: mockSettingService });
        await splitter.initialised;
    });

    afterEach(async () => {
        chunkManager?.destroy();
        await db.destroy();
    });

    describe("isTargetFile", () => {
        it("should return true for normal files", () => {
            const host = createHost(mockSettingService);
            const result = isTargetFile(host, "test.md");
            expect(result).toBe(true);
        });

        it("should return false for files with colon", () => {
            const host = createHost(mockSettingService);
            const result = isTargetFile(host, "test:invalid.md");
            expect(result).toBe(false);
        });

        it("should respect syncOnlyRegEx setting", () => {
            const services = createMockServices({
                syncOnlyRegEx: "^allowed/.*" as any,
            });
            const host = createHost(services.mockSettingService);

            expect(isTargetFile(host, "allowed/file.md")).toBe(true);
            expect(isTargetFile(host, "notallowed/file.md")).toBe(false);
        });

        it("should respect syncIgnoreRegEx setting", () => {
            const services = createMockServices({
                syncIgnoreRegEx: "^ignored/.*" as any,
            });
            const host = createHost(services.mockSettingService);

            expect(isTargetFile(host, "ignored/file.md")).toBe(false);
            expect(isTargetFile(host, "normal/file.md")).toBe(true);
        });
    });

    describe("prepareChunk", () => {
        it("should generate new chunk ID for new piece", async () => {
            const piece = "test data for chunk";
            const result = await prepareChunk({ chunkManager, hashManager }, piece);

            expect(result.isNew).toBe(true);
            expect(result.piece).toBe(piece);
            expect(result.id).toContain(IDPrefixes.Chunk);
        });

        it("should return cached chunk ID for duplicate piece", async () => {
            const piece = "test data for chunk";

            // First call - should be new
            const result1 = await prepareChunk({ chunkManager, hashManager }, piece);
            expect(result1.isNew).toBe(true);

            // Write chunk to manager to cache it
            await chunkManager.write([{ _id: result1.id, data: piece, type: "leaf" }], {}, "test" as DocumentID);

            // Second call - should be cached
            const result2 = await prepareChunk({ chunkManager, hashManager }, piece);
            expect(result2.isNew).toBe(false);
            expect(result2.id).toBe(result1.id);
        });

        it("should generate different IDs for different pieces", async () => {
            const piece1 = "first piece";
            const piece2 = "second piece";

            const result1 = await prepareChunk({ chunkManager, hashManager }, piece1);
            const result2 = await prepareChunk({ chunkManager, hashManager }, piece2);

            expect(result1.id).not.toBe(result2.id);
        });
    });

    describe("createChunks", () => {
        it("should create chunks from a SavingEntry", async () => {
            const entry = createSavingEntry("test-doc", "This is test data for creating chunks");

            const chunks = await createChunks({ chunkManager, hashManager, splitter }, "test.md", entry);

            expect(chunks).not.toBe(false);
            expect(Array.isArray(chunks)).toBe(true);
            if (Array.isArray(chunks)) {
                expect(chunks.length).toBeGreaterThan(0);
                chunks.forEach((chunkId) => {
                    expect(chunkId).toContain(IDPrefixes.Chunk);
                });
            }
        });

        it("should write chunks to database", async () => {
            const entry = createSavingEntry("test-doc", "Data to be chunked and stored");

            const chunks = await createChunks({ chunkManager, hashManager, splitter }, "test.md", entry);

            expect(chunks).not.toBe(false);
            if (Array.isArray(chunks)) {
                // Verify chunks are in database
                for (const chunkId of chunks) {
                    const doc = await db.get(chunkId);
                    expect(doc._id).toBe(chunkId);
                    expect(doc.type).toBe("leaf");
                }
            }
        });

        it("should handle large data by flushing buffered chunks", async () => {
            // Create a large entry that exceeds MAX_WRITE_SIZE (2MB)
            const largeData = "x".repeat(3 * 1024 * 1024); // 3MB
            const entry = createSavingEntry("large-doc", largeData);

            const chunks = await createChunks({ chunkManager, hashManager, splitter }, "large.md", entry);

            expect(chunks).not.toBe(false);
            expect(Array.isArray(chunks)).toBe(true);
            if (Array.isArray(chunks)) {
                expect(chunks.length).toBeGreaterThan(0);
            }
        });

        it("should handle empty data", async () => {
            const entry = createSavingEntry("empty-doc", "");

            const chunks = await createChunks({ chunkManager, hashManager, splitter }, "empty.md", entry);

            // Empty data should still succeed but may have 0 or minimal chunks
            expect(chunks).not.toBe(false);
        });
    });

    describe("putDBEntry", () => {
        it("should save entry to database", async () => {
            const entry = createSavingEntry("test-entry", "Test content for database");
            const host = createHost(mockSettingService, mockPathService);

            const result = await putDBEntry(host, { localDatabase: db, chunkManager, hashManager, splitter }, entry);

            expect(result).not.toBe(false);
            if (result !== false) {
                expect(result.ok).toBe(true);
                expect(result.id).toBe(entry._id);

                // Verify entry is in database
                const doc = await db.get(entry._id);
                expect(doc._id).toBe(entry._id);
                expect(doc.type).toBe("plain");
            }
        });

        it("should save only chunks when onlyChunks is true", async () => {
            const entry = createSavingEntry("chunks-only", "Only chunks should be saved");
            const host = createHost(mockSettingService, mockPathService);

            const result = await putDBEntry(
                host,
                { localDatabase: db, chunkManager, hashManager, splitter },
                entry,
                true // onlyChunks
            );

            expect(result).not.toBe(false);
            if (result !== false) {
                expect(result.ok).toBe(true);
                expect(result.rev).toBe("dummy");

                // Entry should NOT be in database (only chunks)
                await expect(db.get(entry._id)).rejects.toThrow();
            }
        });

        it("should update existing entry", async () => {
            const entry = createSavingEntry("update-test", "Initial content");
            const host = createHost(mockSettingService, mockPathService);

            // First save
            const result1 = await putDBEntry(host, { localDatabase: db, chunkManager, hashManager, splitter }, entry);
            expect(result1).not.toBe(false);

            // Update entry
            const updatedEntry = {
                ...entry,
                data: createTextBlob("Updated content"),
            };
            const result2 = await putDBEntry(
                host,
                { localDatabase: db, chunkManager, hashManager, splitter },
                updatedEntry as SavingEntry
            );

            expect(result2).not.toBe(false);
            if (result2 !== false && result1 !== false) {
                expect(result2.ok).toBe(true);
                expect(result2.id).toBe(entry._id);
                expect(result2.rev).not.toBe(result1.rev);
            }
        });

        it("should skip non-target files", async () => {
            const entry = createSavingEntry("invalid:file", "Should be skipped");
            const host = createHost(mockSettingService, mockPathService);

            const result = await putDBEntry(host, { localDatabase: db, chunkManager, hashManager, splitter }, entry);

            expect(result).toBe(false);
        });
    });

    describe("getDBEntryMetaByPath", () => {
        it("should retrieve entry metadata", async () => {
            const entry = createSavingEntry("meta-test", "Test data");
            const host = createHost(mockSettingService, mockPathService);

            // Save entry first
            await putDBEntry(host, { localDatabase: db, chunkManager, hashManager, splitter }, entry);

            // Get metadata
            const meta = await getDBEntryMetaByPath(host, { localDatabase: db }, entry.path);

            expect(meta).not.toBe(false);
            if (meta !== false) {
                expect(meta._id).toBe(entry._id);
                expect(meta.path).toBe(entry.path);
                expect(meta.type).toBe("plain");
                expect((meta as any).children).toBeDefined();
                expect(Array.isArray((meta as any).children)).toBe(true);
            }
        });

        it("should return false for non-existent path", async () => {
            const host = createHost(mockSettingService, mockPathService);

            const meta = await getDBEntryMetaByPath(
                host,
                { localDatabase: db },
                "non-existent.md" as FilePathWithPrefix
            );

            expect(meta).toBe(false);
        });

        it("should return false for non-target files", async () => {
            const host = createHost(mockSettingService, mockPathService);

            const meta = await getDBEntryMetaByPath(
                host,
                { localDatabase: db },
                "invalid:path.md" as FilePathWithPrefix
            );

            expect(meta).toBe(false);
        });

        it("should exclude deleted entries by default", async () => {
            const entry = createSavingEntry("deleted-test", "Will be deleted");
            const host = createHost(mockSettingService, mockPathService);

            // Save and then delete
            await putDBEntry(host, { localDatabase: db, chunkManager, hashManager, splitter }, entry);
            await deleteDBEntryByPath(host, { localDatabase: db }, entry.path);

            const meta = await getDBEntryMetaByPath(host, { localDatabase: db }, entry.path);

            expect(meta).toBe(false);
            const metaWithDeleted = await getDBEntryMetaByPath(
                host,
                { localDatabase: db },
                entry.path,
                undefined,
                true // includeDeleted
            );
            expect(metaWithDeleted).not.toBe(false);
        });
        it("should exclude deleted entries if real deletion requested", async () => {
            const entry = createSavingEntry("deleted-test", "Will be deleted");
            const services = createMockServices({
                deleteMetadataOfDeletedFiles: true,
            });
            const host = createHost(services.mockSettingService, mockPathService);

            // Save and then delete
            await putDBEntry(host, { localDatabase: db, chunkManager, hashManager, splitter }, entry);
            await deleteDBEntryByPath(host, { localDatabase: db }, entry.path);

            const meta = await getDBEntryMetaByPath(host, { localDatabase: db }, entry.path);

            expect(meta).toBe(false);
            const metaWithDeleted = await getDBEntryMetaByPath(
                host,
                { localDatabase: db },
                entry.path,
                undefined,
                true // includeDeleted
            );
            expect(metaWithDeleted).toBe(false);
        });

        it("should include deleted entries when requested", async () => {
            const entry = createSavingEntry("deleted-include", "Will be deleted");
            const host = createHost(mockSettingService, mockPathService);

            // Save and then delete
            await putDBEntry(host, { localDatabase: db, chunkManager, hashManager, splitter }, entry);
            await deleteDBEntryByPath(host, { localDatabase: db }, entry.path);

            const meta = await getDBEntryMetaByPath(
                host,
                { localDatabase: db },
                entry.path,
                undefined,
                true // includeDeleted
            );

            expect(meta).not.toBe(false);
            if (meta !== false) {
                expect(meta._id).toBe(entry._id);
                expect(meta.deleted).toBe(true);
            }
        });
    });

    describe("getDBEntryFromMeta", () => {
        it("should load full entry from metadata", async () => {
            const entry = createSavingEntry("full-load", "Test data to load");
            const host = createHost(mockSettingService, mockPathService);

            // Save entry
            await putDBEntry(host, { localDatabase: db, chunkManager, hashManager, splitter }, entry);

            // Get metadata
            const meta = await getDBEntryMetaByPath(host, { localDatabase: db }, entry.path);
            expect(meta).not.toBe(false);

            if (meta !== false) {
                // Load full entry
                const loaded = await getDBEntryFromMeta(host, { localDatabase: db, chunkManager }, meta, false, true);

                expect(loaded).not.toBe(false);
                if (loaded !== false) {
                    expect(loaded._id).toBe(entry._id);
                    expect(loaded.path).toBe(entry.path);
                    expect(loaded.type).toBe("plain");
                    expect(loaded.data).toBeDefined();
                    // Data should be an array of strings
                    expect(Array.isArray(loaded.data)).toBe(true);
                }
            }
        });

        it("should handle non-target files", async () => {
            const host = createHost(mockSettingService, mockPathService);

            const fakeMeta: LoadedEntry = {
                _id: "invalid:file" as DocumentID,
                path: "invalid:file" as FilePathWithPrefix,
                type: "plain",
                datatype: "plain",
                data: "",
                ctime: Date.now(),
                mtime: Date.now(),
                size: 0,
                children: [],
                eden: {},
            } as LoadedEntry;

            const result = await getDBEntryFromMeta(host, { localDatabase: db, chunkManager }, fakeMeta);

            expect(result).toBe(false);
        });
    });

    describe("getDBEntryByPath", () => {
        it("should retrieve full entry by path", async () => {
            const entry = createSavingEntry("path-load", "Data loaded by path");
            const host = createHost(mockSettingService, mockPathService);

            // Save entry
            await putDBEntry(host, { localDatabase: db, chunkManager, hashManager, splitter }, entry);

            // Load by path
            const loaded = await getDBEntryByPath(host, { localDatabase: db, chunkManager }, entry.path);

            expect(loaded).not.toBe(false);
            if (loaded !== false) {
                expect(loaded._id).toBe(entry._id);
                expect(loaded.path).toBe(entry.path);
                expect(Array.isArray(loaded.data)).toBe(true);
            }
        });

        it("should return false for non-existent path", async () => {
            const host = createHost(mockSettingService, mockPathService);

            const loaded = await getDBEntryByPath(
                host,
                { localDatabase: db, chunkManager },
                "non-existent.md" as FilePathWithPrefix
            );

            expect(loaded).toBe(false);
        });
    });

    describe("deleteDBEntryByPath", () => {
        it("should delete entry by path", async () => {
            const entry = createSavingEntry("delete-me", "Will be deleted");
            const host = createHost(mockSettingService, mockPathService);

            // Save entry
            await putDBEntry(host, { localDatabase: db, chunkManager, hashManager, splitter }, entry);

            // Delete entry
            const result = await deleteDBEntryByPath(host, { localDatabase: db }, entry.path);
            expect(result).toBe(true);

            // Verify deletion
            const meta = await getDBEntryMetaByPath(host, { localDatabase: db }, entry.path);
            expect(meta).toBe(false);
        });

        it("should return false for non-existent entry", async () => {
            const host = createHost(mockSettingService, mockPathService);

            const result = await deleteDBEntryByPath(
                host,
                { localDatabase: db },
                "non-existent.md" as FilePathWithPrefix
            );

            expect(result).toBe(false);
        });

        it("should return false for non-target files", async () => {
            const host = createHost(mockSettingService, mockPathService);

            const result = await deleteDBEntryByPath(
                host,
                { localDatabase: db },
                "invalid:file.md" as FilePathWithPrefix
            );

            expect(result).toBe(false);
        });
    });

    describe("isOnDemandChunkEnabled", () => {
        it("should return true for CouchDB without useOnlyLocalChunk", () => {
            const settings = {
                ...DEFAULT_SETTINGS,
                remoteType: REMOTE_COUCHDB,
                useOnlyLocalChunk: false,
            } as ObsidianLiveSyncSettings;

            expect(canUseOnDemandChunking(settings)).toBe(true);
        });

        it("should return false when useOnlyLocalChunk is true", () => {
            const settings = {
                ...DEFAULT_SETTINGS,
                remoteType: REMOTE_COUCHDB,
                useOnlyLocalChunk: true,
            } as ObsidianLiveSyncSettings;

            expect(canUseOnDemandChunking(settings)).toBe(false);
        });

        it("should return false for non-CouchDB remote types", () => {
            const settings = {
                ...DEFAULT_SETTINGS,
                remoteType: "minio" as any,
                useOnlyLocalChunk: false,
            } as ObsidianLiveSyncSettings;

            expect(canUseOnDemandChunking(settings)).toBe(false);
        });
    });

    describe("isNoteEntry", () => {
        it("should return true for legacy note entries", () => {
            const meta: LoadedEntry = {
                _id: "test" as DocumentID,
                path: "test.md" as FilePathWithPrefix,
                type: "notes",
                datatype: "newnote",
                data: "",
                ctime: Date.now(),
                mtime: Date.now(),
                size: 0,
                children: [],
                eden: {},
            } as LoadedEntry;

            expect(isLegacyNote(meta)).toBe(true);
        });

        it("should return true for entries without type", () => {
            const meta = {
                _id: "test" as DocumentID,
                path: "test.md" as FilePathWithPrefix,
                data: "",
                ctime: Date.now(),
                mtime: Date.now(),
                size: 0,
            } as any;

            expect(isLegacyNote(meta)).toBe(true);
        });

        it("should return false for plain entries", () => {
            const meta: LoadedEntry = {
                _id: "test" as DocumentID,
                path: "test.md" as FilePathWithPrefix,
                type: "plain",
                datatype: "plain",
                data: "",
                ctime: Date.now(),
                mtime: Date.now(),
                size: 0,
                children: [],
                eden: {},
            } as LoadedEntry;

            expect(isLegacyNote(meta)).toBe(false);
        });
    });
    const encryption = [true, false];
    const sizes = [0, 10, 1024, 1024 * 1024, 3 * 1024 * 1024, 10 * 1024 * 1024];
    const extensions = ["md", "bin"];
    function getSeededRandomString(seed: string | number, length = 8) {
        let s = 0;
        if (typeof seed === "string") {
            for (let i = 0; i < seed.length; i++) {
                s = (Math.imul(31, s) + seed.charCodeAt(i)) | 0;
            }
        } else {
            s = seed;
        }

        // Mulberry32 PRNG
        const nextRand = () => {
            s |= 0;
            s = (s + 0x6d2b79f5) | 0;
            let t = Math.imul(s ^ (s >>> 15), 1 | s);
            t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
        // A charset that includes a variety of characters, including multi-byte ones
        const chars = `#\n\n\n\n         abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789あいうえおかきくけこさしすせそたちつてとなにぬねの烽火連三月，家書抵萬金。📜🖋️ 🏺 🏛️ 春望𠮷‌ché🇷🇺Аa‮RTLO🏳️‍🌈👨‍👩‍👧‍👦lʼanatraｱｲｳｴｵ白頭搔更短，渾欲不勝簪`;
        let result = "";
        for (let i = 0; i < length; i++) {
            result += chars.charAt(Math.floor(nextRand() * chars.length));
        }
        return result;
    }
    describe.each(encryption)("Encryption: %s", (isEncrypted) => {
        describe.each(extensions)("Size and Extension Handling for .%s files", (extension) => {
            it.each(sizes)("should handle entries of size %i bytes", async (size) => {
                const services = createMockServices({
                    encrypt: isEncrypted,
                    passphrase: isEncrypted ? "test-passphrase" : undefined,
                });
                const mockSettingService = services.mockSettingService;
                const mockPathService = services.mockPathService;
                const data = getSeededRandomString(size);
                const saveData = extension === "bin" ? createTextBlob(data) : data;
                const entry = createSavingEntry(`size-test-${size}.${extension}`, saveData);
                const host = createHost(mockSettingService, mockPathService);
                // Save entry
                await putDBEntry(host, { localDatabase: db, chunkManager, hashManager, splitter }, entry);

                // Load by path
                const loaded = await getDBEntryByPath(host, { localDatabase: db, chunkManager }, entry.path);

                expect(loaded).not.toBe(false);
                if (loaded !== false) {
                    expect(loaded._id).toBe(entry._id);
                    expect(loaded.path).toBe(entry.path);
                    const isSame = await isDocContentSame(entry.data, loaded.data);
                    expect(isSame).toBe(true);
                }
            });
        });
    });
    const splitters = [ChunkAlgorithms.RabinKarp, ChunkAlgorithms.V1, ChunkAlgorithms.V2, ChunkAlgorithms.V2Segmenter];
    const chunkSizeRatios = [0, 10, 100];
    const sizes2 = [1024, 1024 * 1024, 3 * 1024 * 1024, 10 * 1024 * 1024];

    describe.each(splitters)("Chunk Splitter: %s", (splitterVersion) => {
        describe.each(chunkSizeRatios)("should create correct chunks with chunk size ratio %i", (ratio) => {
            describe.each(sizes2)("for entry size %i bytes", (size) => {
                it.each(extensions)("and extension .%s", async (extension) => {
                    const services = createMockServices({
                        chunkSplitterVersion: splitterVersion,
                        customChunkSize: ratio,
                    });
                    const mockSettingService = services.mockSettingService;
                    const mockPathService = services.mockPathService;
                    const data = getSeededRandomString(size);
                    const saveData = extension === "bin" ? createTextBlob(data) : data;
                    const entry = createSavingEntry(`size-test-${size}.${extension}`, saveData);
                    const host = createHost(mockSettingService, mockPathService);
                    // Save entry
                    await putDBEntry(host, { localDatabase: db, chunkManager, hashManager, splitter }, entry);

                    // Load by path
                    const loaded = await getDBEntryByPath(host, { localDatabase: db, chunkManager }, entry.path);

                    expect(loaded).not.toBe(false);
                    if (loaded !== false) {
                        expect(loaded._id).toBe(entry._id);
                        expect(loaded.path).toBe(entry.path);
                        const isSame = await isDocContentSame(entry.data, loaded.data);
                        expect(isSame).toBe(true);
                    }
                });
            });
        });
    });
    describe("Edge Cases", () => {
        it("should report error while chunk cannot be saved", async () => {
            const services = createMockServices();
            const mockSettingService = services.mockSettingService;
            const mockPathService = services.mockPathService;
            const entry = createSavingEntry(`chunk-save-error.md`, "XX".repeat(2 * 1024 * 1024)); // Large data to ensure chunking
            const host = createHost(mockSettingService, mockPathService);
            const mockChunkManager = new LayeredChunkManager({
                database: db,
                changeManager: { addCallback: () => () => {} } as any,
                settingService: mockSettingService,
            });
            const failedResult: WriteResult = {
                result: false,
                processed: {
                    cached: 0,
                    hotPack: 0,
                    written: 0,
                    duplicated: 0,
                },
            };
            mockChunkManager.write = vi.fn().mockResolvedValue(failedResult);
            const result = await putDBEntry(
                host,
                { localDatabase: db, chunkManager: mockChunkManager, hashManager, splitter },
                entry
            );
            expect(result).toBe(false);
        });
        it("should handle deleted entries correctly when includeDeleted is true", async () => {
            const services = createMockServices();
            const mockSettingService = services.mockSettingService;
            const mockPathService = services.mockPathService;
            const entry = createSavingEntry(`deleted-entry.md`, "This entry will be deleted");
            const host = createHost(mockSettingService, mockPathService);
            // Save entry
            await putDBEntry(host, { localDatabase: db, chunkManager, hashManager, splitter }, entry);
            // Delete entry
            await deleteDBEntryByPath(host, { localDatabase: db }, entry.path);
            // Get metadata with includeDeleted = true
            const meta = await getDBEntryMetaByPath(
                host,
                { localDatabase: db },
                entry.path,
                undefined,
                true // includeDeleted
            );
            expect(meta).not.toBe(false);
            if (meta !== false) {
                expect(meta._id).toBe(entry._id);
                expect(meta.deleted).toBe(true);
            }
        });
        it("should handle deleted entries correctly when passing options", async () => {
            const services = createMockServices();
            const mockSettingService = services.mockSettingService;
            const mockPathService = services.mockPathService;
            const entry = createSavingEntry(`deleted-entry.md`, "This entry will be deleted");
            const host = createHost(mockSettingService, mockPathService);
            // Save entry
            const v = await putDBEntry(host, { localDatabase: db, chunkManager, hashManager, splitter }, entry);

            // Delete entry
            await deleteDBEntryByPath(host, { localDatabase: db }, entry.path);

            const normalResult = await getDBEntryMetaByPath(host, { localDatabase: db }, entry.path);
            expect(normalResult).toBe(false);
            // Get metadata with includeDeleted = true
            const meta = await getDBEntryMetaByPath(host, { localDatabase: db }, entry.path, { rev: (v as any).rev });
            expect(meta).not.toBe(false);
            if (meta !== false) {
                expect(meta._id).toBe(entry._id);
                expect(meta.deleted).not.toBe(true);
            }
        });
        it("should handle non-target files correctly in getDBEntryMetaByPath", async () => {
            const services = createMockServices();
            const mockSettingService = services.mockSettingService;
            const mockPathService = services.mockPathService;
            const entry = createSavingEntry(`file.md`, "This entry will be saved");
            const host = createHost(mockSettingService, mockPathService);
            // Save entry
            await putDBEntry(host, { localDatabase: db, chunkManager, hashManager, splitter }, entry);
            // Get metadata
            const meta = await getDBEntryMetaByPath(host, { localDatabase: db }, entry.path);
            expect(meta).not.toBe(false);
            const chunkID = (meta as NewEntry)?.children?.[0];
            const r = await getDBEntryByPath(host, { localDatabase: db, chunkManager }, chunkID as FilePathWithPrefix);
            expect(r).toBe(false);
        });
        it("should handle corrupted documents (having invalid chunk) gracefully", async () => {
            const services = createMockServices();
            const mockSettingService = services.mockSettingService;
            const mockPathService = services.mockPathService;
            const entry = createSavingEntry(`file.md`, "This entry will be saved");
            const host = createHost(mockSettingService, mockPathService);
            // Save entry
            await putDBEntry(host, { localDatabase: db, chunkManager, hashManager, splitter }, entry);
            // Get metadata
            const meta = await getDBEntryMetaByPath(host, { localDatabase: db }, entry.path);
            expect(meta).not.toBe(false);
            const chunkID = (meta as NewEntry)?.children?.[0];
            // Corrupt the chunk document
            const chunkDoc = await db.get(chunkID);
            const chunkResponse = await db.put({
                _id: chunkID,
                data: "corrupted data",
                type: "xxxxxxx",
                _rev: chunkDoc._rev,
            } as any);
            const r = await getDBEntryByPath(host, { localDatabase: db, chunkManager }, chunkID as FilePathWithPrefix);
            expect(r).toBe(false);
            // Delete the chunk document
            await db.put({
                _id: chunkID,
                data: "corrupted data",
                type: "leaf",
                _rev: chunkResponse.rev,
                _deleted: true,
            } as any);
            const r2 = await getDBEntryByPath(host, { localDatabase: db, chunkManager }, chunkID as FilePathWithPrefix);
            expect(r2).toBe(false);
        });
        it("should handle corrupted documents (of invalid type) gracefully", async () => {
            const services = createMockServices();
            const mockSettingService = services.mockSettingService;
            const mockPathService = services.mockPathService;
            const entry = createSavingEntry(`file.md`, "This entry will be saved");
            const host = createHost(mockSettingService, mockPathService);
            // Save entry
            await putDBEntry(host, { localDatabase: db, chunkManager, hashManager, splitter }, entry);
            // Get metadata
            const meta = await getDBEntryMetaByPath(host, { localDatabase: db }, entry.path);
            expect(meta).not.toBe(false);
            // put a document with the same id but invalid type to corrupt the entry
            await db.put({ ...meta, type: "leaf" } as any);
            // const chunkID = (meta as NewEntry)?.children?.[0];
            // Corrupt the chunk document
            // const chunkDoc = await db.get(chunkID);
            const r = await getDBEntryByPath(host, { localDatabase: db, chunkManager }, entry.path);
            expect(r).toBe(false);
            const r2 = await deleteDBEntryByPath(host, { localDatabase: db }, entry.path);
            expect(r2).toBe(false);
            const r3 = await getDBEntryMetaByPath(host, { localDatabase: db }, entry.path);
            expect(r3).toBe(false);
        });
        it("should handle corrupted documents (of truly invalid type) gracefully", async () => {
            const services = createMockServices();
            const mockSettingService = services.mockSettingService;
            const mockPathService = services.mockPathService;
            const entry = createSavingEntry(`file.md`, "This entry will be saved");
            const host = createHost(mockSettingService, mockPathService);
            // Save entry
            await putDBEntry(host, { localDatabase: db, chunkManager, hashManager, splitter }, entry);
            // Get metadata
            const meta = await getDBEntryMetaByPath(host, { localDatabase: db }, entry.path);
            expect(meta).not.toBe(false);
            // put a document with the same id but invalid type to corrupt the entry
            await db.put({ ...meta, type: "fancy" } as any);
            // const chunkID = (meta as NewEntry)?.children?.[0];
            // Corrupt the chunk document
            // const chunkDoc = await db.get(chunkID);
            const r = await getDBEntryByPath(host, { localDatabase: db, chunkManager }, entry.path);
            expect(r).toBe(false);
            const r2 = await deleteDBEntryByPath(host, { localDatabase: db }, entry.path);
            expect(r2).toBe(false);
            const r3 = await getDBEntryMetaByPath(host, { localDatabase: db }, entry.path);
            expect(r3).toBe(false);
        });
        const prefixMap = {
            [ICHeader]: true,
            [ICXHeader]: false,
            [PSCHeader]: false,
        };
        it("should handle specific special files by default", async () => {
            const services = createMockServices();
            const mockSettingService = services.mockSettingService;
            const mockPathService = services.mockPathService;
            const host = createHost(mockSettingService, mockPathService);
            for (const prefix in prefixMap) {
                const path = `${prefix}:test.md` as FilePathWithPrefix;
                const entry = createSavingEntry(path, "This entry will be saved");
                // Save entry
                const rawResult = await putDBEntry(
                    host,
                    { localDatabase: db, chunkManager, hashManager, splitter },
                    entry
                );
                // Get metadata
                const result = !rawResult;
                // console.log(`Testing path: ${path}, expected: ${prefixMap[prefix as keyof typeof prefixMap]}, got: ${result}`);
                expect(result).toBe(prefixMap[prefix as keyof typeof prefixMap]);
            }
        });
        it("should handle specific revision to deleted entries", async () => {
            const services = createMockServices();
            const mockSettingService = services.mockSettingService;
            const mockPathService = services.mockPathService;
            const entry = createSavingEntry(`fancy-entry.md`, "This entry will be modified");
            const host = createHost(mockSettingService, mockPathService);
            const raw = await putDBEntry(host, { localDatabase: db, chunkManager, hashManager, splitter }, entry);
            if (raw === false) {
                throw new Error("Failed to save entry");
            }

            const rawDoc = await db.get(raw.id);
            const rev1 = raw.rev;
            const rev2a = await db.put({ ...rawDoc, mtime: 1, _rev: rev1 } as any, { force: true });
            const rev2b = await db.put({ ...rawDoc, mtime: 2, _rev: rev1 } as any, { force: true });

            const p2 = await deleteDBEntryByPath(host, { localDatabase: db }, entry.path, {
                rev: (rev2a as any).rev,
            } as any);
            expect(p2).toBe(true);
            // then the rev2 should be returned when trying to get the deleted entry with rev2, and the deleted flag should not be true
            const meta = await getDBEntryByPath(host, { localDatabase: db, chunkManager }, entry.path);
            expect(meta).not.toBe(false);
            if (meta !== false) {
                expect(meta._id).toBe(entry._id);
                expect(meta.path).toBe(entry.path);
                expect(meta.deleted).not.toBe(true);
                expect(meta._rev).toBe((rev2b as any).rev);
                expect(meta.mtime).toBe(2);
            }
        });
    });
});
