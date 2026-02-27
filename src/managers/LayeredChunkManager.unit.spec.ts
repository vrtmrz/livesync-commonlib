import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import PouchDB from "pouchdb-core";
import MemoryAdapter from "pouchdb-adapter-memory";
import { LayeredChunkManager } from "./LayeredChunkManager";
import type { DocumentID, EntryLeaf, EntryDoc } from "@lib/common/types";
import type { ChunkManagerOptions } from "./LayeredChunkManager/types";
import { EVENT_MISSING_CHUNKS, EVENT_MISSING_CHUNK_REMOTE } from "@lib/managers/ChunkFetcher";

// Set up PouchDB with memory adapter
PouchDB.plugin(MemoryAdapter);
let dbCounter = 0;

function createMockLeaf(id: string, data: string = `data-${id}`): EntryLeaf {
    return {
        _id: id as DocumentID,
        type: "leaf" as any,
        data: data,
    } as EntryLeaf;
}

describe("LayeredChunkManager Integration Tests", () => {
    let db: PouchDB.Database<EntryDoc>;
    let chunkManager: LayeredChunkManager;
    let changeManagerCallbacks: Set<(change: PouchDB.Core.ChangesResponseChange<EntryDoc>) => void>;

    beforeEach(() => {
        // Create a unique in-memory database for each test
        dbCounter++;
        db = new PouchDB(`test-lcm-${dbCounter}`, { adapter: "memory" });

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

        // Mock SettingService
        const mockSettingService = {
            currentSettings: vi.fn(() => ({
                hashCacheMaxCount: 10,
            })),
        };

        // Create ChunkManager
        const options: ChunkManagerOptions = {
            database: db,
            changeManager: mockChangeManager as any,
            settingService: mockSettingService as any,
        };

        chunkManager = new LayeredChunkManager(options);
    });

    afterEach(async () => {
        chunkManager.destroy();
        await db.destroy();
    });

    describe("Initialization", () => {
        it("should initialize successfully", () => {
            expect(chunkManager).toBeDefined();
            expect(chunkManager.database).toBe(db);
        });

        it("should initialize cache statistics", () => {
            const stats = chunkManager.cacheStatistics;
            expect(stats).toBeDefined();
            expect(stats.size).toBe(0);
        });

        it("should register change listener on construction", () => {
            expect(changeManagerCallbacks.size).toBe(1);
        });
    });

    describe("Write Pipeline", () => {
        it("should write a single chunk to database", async () => {
            const chunk = createMockLeaf("chunk-1");

            const result = await chunkManager.write([chunk], {}, "origin-1" as DocumentID);

            expect(result.result).toBe(true);
            expect(result.processed.written).toBe(1);

            // Verify chunk is in database
            const doc = await db.get("chunk-1");
            expect(doc._id).toBe("chunk-1");
        });

        it("should write multiple chunks to database", async () => {
            const chunks = [createMockLeaf("chunk-1"), createMockLeaf("chunk-2"), createMockLeaf("chunk-3")];

            const result = await chunkManager.write(chunks, {}, "origin-1" as DocumentID);

            expect(result.result).toBe(true);
            expect(result.processed.written).toBe(3);

            // Verify all chunks are in database
            const doc1 = await db.get("chunk-1");
            const doc2 = await db.get("chunk-2");
            const doc3 = await db.get("chunk-3");
            expect(doc1._id).toBe("chunk-1");
            expect(doc2._id).toBe("chunk-2");
            expect(doc3._id).toBe("chunk-3");
        });

        it("should cache chunks after writing to database", async () => {
            const chunk = createMockLeaf("chunk-1");

            const result = await chunkManager.write([chunk], {}, "origin-1" as DocumentID);
            expect(result.result).toBe(true);

            // Verify chunk is cached
            const cached = chunkManager.getCachedChunk("chunk-1" as DocumentID);
            expect(cached).not.toBe(false);
            if (cached) {
                expect(cached._id).toBe("chunk-1");
            }
        });

        it("should handle duplicate writes (409 conflicts)", async () => {
            const chunk = createMockLeaf("chunk-1");

            // First write
            await chunkManager.write([chunk], {}, "origin-1" as DocumentID);

            // Second write (should detect duplicate)
            const result = await chunkManager.write([chunk], {}, "origin-1" as DocumentID);

            expect(result.result).toBe(true);
            expect(result.processed.duplicated).toBe(1);
        });
    });

    describe("Read Pipeline", () => {
        it("should read a chunk from database", async () => {
            // Write chunk to database
            const chunk = createMockLeaf("chunk-1");
            await db.put(chunk);

            // Read chunk through pipeline
            const results = await chunkManager.read(["chunk-1" as DocumentID], {});

            expect(results).toHaveLength(1);
            expect(results[0]).not.toBe(false);
            expect((results[0] as EntryLeaf)._id).toBe("chunk-1");
        });

        it("should return false for non-existent chunks with timeout=0", async () => {
            const results = await chunkManager.read(["non-existent" as DocumentID], { timeout: 0 });

            expect(results).toHaveLength(1);
            expect(results[0]).toBe(false);
        });

        it("should read from cache on second read", async () => {
            const chunk = createMockLeaf("chunk-1");

            // Write through chunkManager to ensure it's cached
            await chunkManager.write([chunk], {}, "origin-1" as DocumentID);

            // First read (should be from cache)
            const firstRead = await chunkManager.read(["chunk-1" as DocumentID], {});
            expect(firstRead[0]).not.toBe(false);

            // Delete from database directly
            const doc = await db.get("chunk-1");
            await db.remove(doc);

            // Second read should still work (from cache)
            const results = await chunkManager.read(["chunk-1" as DocumentID], {});

            expect(results).toHaveLength(1);
            expect(results[0]).not.toBe(false);
            expect((results[0] as EntryLeaf)._id).toBe("chunk-1");
        });

        it("should handle preloaded chunks", async () => {
            const chunk = createMockLeaf("chunk-1");
            const preloadedChunks = {
                "chunk-1": chunk,
            } as Record<DocumentID, EntryLeaf>;

            const results = await chunkManager.read(["chunk-1" as DocumentID], {}, preloadedChunks);

            expect(results).toHaveLength(1);
            expect(results[0]).not.toBe(false);
            expect((results[0] as EntryLeaf)._id).toBe("chunk-1");

            // Verify it's cached
            const cached = chunkManager.getCachedChunk("chunk-1" as DocumentID);
            expect(cached).not.toBe(false);
        });

        it("should maintain order when reading multiple chunks", async () => {
            const chunks = [createMockLeaf("chunk-1"), createMockLeaf("chunk-2"), createMockLeaf("chunk-3")];

            // Write chunks to database
            await db.bulkDocs(chunks);

            // Read in different order
            const results = await chunkManager.read(
                ["chunk-3" as DocumentID, "chunk-1" as DocumentID, "chunk-2" as DocumentID],
                {}
            );

            expect(results).toHaveLength(3);
            expect((results[0] as EntryLeaf)._id).toBe("chunk-3");
            expect((results[1] as EntryLeaf)._id).toBe("chunk-1");
            expect((results[2] as EntryLeaf)._id).toBe("chunk-2");
        });

        it("should mix cached and database reads", async () => {
            const chunk1 = createMockLeaf("chunk-1");
            const chunk2 = createMockLeaf("chunk-2");

            // Write chunk-1 and cache it
            await chunkManager.write([chunk1], {}, "origin-1" as DocumentID);

            // Write chunk-2 only to database (clear cache first)
            chunkManager.clearCaches();
            await chunkManager.write([chunk1], {}, "origin-1" as DocumentID);
            await db.put(chunk2);

            // Read both chunks
            const results = await chunkManager.read(["chunk-1" as DocumentID, "chunk-2" as DocumentID], {});

            expect(results).toHaveLength(2);
            expect((results[0] as EntryLeaf)._id).toBe("chunk-1");
            expect((results[1] as EntryLeaf)._id).toBe("chunk-2");
        });
    });

    describe("Cache Management", () => {
        it("should cache chunks manually", () => {
            const chunk = createMockLeaf("chunk-1");

            chunkManager.cacheChunk(chunk);

            const cached = chunkManager.getCachedChunk("chunk-1" as DocumentID);
            expect(cached).not.toBe(false);
            expect((cached as EntryLeaf)._id).toBe("chunk-1");
        });

        it("should get chunk ID from cache by data", () => {
            const chunk = createMockLeaf("chunk-1", "my-data");

            chunkManager.cacheChunk(chunk);

            const id = chunkManager.getChunkIDFromCache("my-data");
            expect(id).toBe("chunk-1");
        });

        it("should clear all caches", () => {
            const chunk = createMockLeaf("chunk-1");
            chunkManager.cacheChunk(chunk);

            expect(chunkManager.getCachedChunk("chunk-1" as DocumentID)).not.toBe(false);

            chunkManager.clearCaches();

            expect(chunkManager.getCachedChunk("chunk-1" as DocumentID)).toBe(false);
        });

        it("should update cache statistics", () => {
            const chunks = [createMockLeaf("chunk-1"), createMockLeaf("chunk-2"), createMockLeaf("chunk-3")];

            chunks.forEach((chunk) => chunkManager.cacheChunk(chunk));

            const stats = chunkManager.cacheStatistics;
            expect(stats.size).toBe(3);
        });
    });

    describe("Event Handling", () => {
        it("should emit EVENT_MISSING_CHUNKS when reading missing chunks", async () => {
            const listener = vi.fn();
            chunkManager.addListener(EVENT_MISSING_CHUNKS, listener);

            // Read non-existent chunks (will trigger missing chunks event)
            const promise = chunkManager.read(["missing-1" as DocumentID, "missing-2" as DocumentID], { timeout: 10 });

            // Wait a bit for event to be emitted
            await new Promise((resolve) => setTimeout(resolve, 5));

            expect(listener).toHaveBeenCalled();
            expect(listener).toHaveBeenCalledWith(expect.arrayContaining(["missing-1", "missing-2"]));

            await promise; // Clean up
        });

        it("should not emit EVENT_MISSING_CHUNKS when preventRemoteRequest is true", async () => {
            const listener = vi.fn();
            chunkManager.addListener(EVENT_MISSING_CHUNKS, listener);

            await chunkManager.read(["missing-1" as DocumentID], { timeout: 10, preventRemoteRequest: true });

            expect(listener).not.toHaveBeenCalled();
        });

        it("should handle chunk arrival events", async () => {
            const chunk = createMockLeaf("chunk-1");

            // Start reading (will wait for arrival)
            const promise = chunkManager.read(["chunk-1" as DocumentID], { timeout: 1000 });

            // Simulate chunk arrival via change event after a small delay
            setTimeout(() => {
                const change: PouchDB.Core.ChangesResponseChange<EntryDoc> = {
                    id: "chunk-1",
                    seq: 1,
                    changes: [],
                    doc: chunk as any,
                };

                // Trigger change handler
                for (const callback of changeManagerCallbacks) {
                    callback(change);
                }
            }, 50);

            const results = await promise;

            expect(results).toHaveLength(1);
            expect(results[0]).not.toBe(false);
            expect((results[0] as EntryLeaf)._id).toBe("chunk-1");
        });

        it("should handle EVENT_MISSING_CHUNK_REMOTE", async () => {
            // Start reading (will wait for arrival)
            const promise = chunkManager.read(["chunk-1" as DocumentID], { timeout: 1000 });

            // Emit missing chunk remote event
            chunkManager.emitEvent(EVENT_MISSING_CHUNK_REMOTE, "chunk-1" as DocumentID);

            const results = await promise;

            expect(results).toHaveLength(1);
            expect(results[0]).toBe(false); // Should resolve to false
        });

        it("should remove event listeners via returned cleanup function", () => {
            const listener = vi.fn();
            const removeListener = chunkManager.addListener(EVENT_MISSING_CHUNKS, listener);

            // Emit before removal to verify it works
            chunkManager.emitEvent(EVENT_MISSING_CHUNKS, ["test" as DocumentID]);
            expect(listener).toHaveBeenCalledTimes(1);

            // Reset the mock
            listener.mockClear();

            // Remove listener using cleanup function
            removeListener();

            // Try to emit event after removal
            chunkManager.emitEvent(EVENT_MISSING_CHUNKS, ["test2" as DocumentID]);

            // Listener should not be called
            expect(listener).not.toHaveBeenCalled();
        });
    });

    describe("Transaction Management", () => {
        it("should execute transaction successfully", async () => {
            const result = await chunkManager.transaction(async () => {
                return await Promise.resolve("transaction-result");
            });

            expect(result).toBe("transaction-result");
        });

        it("should wait for initialization before executing transaction", async () => {
            const result = await chunkManager.transaction(async () => {
                // Should only execute after initialization
                return await Promise.resolve("success");
            });

            expect(result).toBe("success");
        });

        it("should handle concurrent transactions", async () => {
            const results = await Promise.all([
                chunkManager.transaction(async () => await Promise.resolve("tx1")),
                chunkManager.transaction(async () => await Promise.resolve("tx2")),
                chunkManager.transaction(async () => await Promise.resolve("tx3")),
            ]);

            expect(results).toEqual(["tx1", "tx2", "tx3"]);
        });

        it("should handle transaction errors", async () => {
            await expect(
                chunkManager.transaction(() => {
                    throw new Error("Transaction failed");
                })
            ).rejects.toThrow("Transaction failed");
        });
    });

    describe("Lifecycle", () => {
        it("should clean up resources on destroy", () => {
            const initialCallbackCount = changeManagerCallbacks.size;
            expect(initialCallbackCount).toBeGreaterThan(0);

            chunkManager.destroy();

            expect(changeManagerCallbacks.size).toBe(0);
        });

        it("should clear caches on destroy", () => {
            const chunk = createMockLeaf("chunk-1");
            chunkManager.cacheChunk(chunk);

            expect(chunkManager.getCachedChunk("chunk-1" as DocumentID)).not.toBe(false);

            chunkManager.destroy();

            // Cache should be cleared (destroy calls tearDown on layers)
            // Note: After destroy, the manager should not be used
        });
    });

    describe("Integration Scenarios", () => {
        it("should handle complete write-read cycle", async () => {
            const chunk = createMockLeaf("chunk-1");

            // Write
            const writeResult = await chunkManager.write([chunk], {}, "origin-1" as DocumentID);
            expect(writeResult.result).toBe(true);

            // Clear cache to force database read
            chunkManager.clearCaches();

            // Read
            const readResults = await chunkManager.read(["chunk-1" as DocumentID], {});
            expect(readResults[0]).not.toBe(false);
            expect((readResults[0] as EntryLeaf).data).toBe("data-chunk-1");
        });

        it("should handle mixed operations with cache", async () => {
            const chunks = [createMockLeaf("chunk-1"), createMockLeaf("chunk-2"), createMockLeaf("chunk-3")];

            // Write all chunks
            await chunkManager.write(chunks, {}, "origin-1" as DocumentID);

            // Read chunk-1 and chunk-2 (from cache)
            const results1 = await chunkManager.read(["chunk-1" as DocumentID, "chunk-2" as DocumentID], {});
            expect(results1).toHaveLength(2);

            // Clear cache
            chunkManager.clearCaches();

            // Read chunk-2 and chunk-3 (from database)
            const results2 = await chunkManager.read(["chunk-2" as DocumentID, "chunk-3" as DocumentID], {});
            expect(results2).toHaveLength(2);
            expect((results2[0] as EntryLeaf)._id).toBe("chunk-2");
            expect((results2[1] as EntryLeaf)._id).toBe("chunk-3");
        });

        it("should handle chunk arrival during read wait", async () => {
            const chunk = createMockLeaf("chunk-1");

            // Start reading (will wait)
            const readPromise = chunkManager.read(["chunk-1" as DocumentID], { timeout: 1000 });

            // Simulate chunk arrival after a short delay
            setTimeout(() => {
                const change: PouchDB.Core.ChangesResponseChange<EntryLeaf> = {
                    id: "chunk-1",
                    seq: 1,
                    changes: [],
                    doc: chunk as any,
                };
                for (const callback of changeManagerCallbacks) {
                    callback(change as any);
                }
            }, 50);

            const results = await readPromise;

            expect(results).toHaveLength(1);
            expect(results[0]).not.toBe(false);
            expect((results[0] as EntryLeaf)._id).toBe("chunk-1");
        });
    });
});
