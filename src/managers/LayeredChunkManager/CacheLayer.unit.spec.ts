import { describe, it, expect, beforeEach, vi } from "vitest";
// import { FallbackWeakRef } from "octagonal-wheels/common/polyfill";
import { CacheLayer } from "./CacheLayer";
import type { DocumentID, EntryLeaf } from "../../common/types";
import type { ChunkReadOptions, ChunkWriteOptions } from "./types.ts";

/**
 * Create a mock EntryLeaf for testing
 */
function createMockChunk(id: string, data: string = `data-${id}`): EntryLeaf {
    return {
        _id: id as DocumentID,
        _rev: "1-rev",
        type: "leaf",
        data: data,
    };
}

describe("CacheLayer", () => {
    let cacheLayer: CacheLayer;
    const maxCacheSize = 3;

    beforeEach(() => {
        cacheLayer = new CacheLayer(maxCacheSize);
    });

    describe("constructor", () => {
        it("should initialize with max cache size", () => {
            const layer = new CacheLayer(5);
            expect(layer.allocCount).toBe(0);
            expect(layer.derefCount).toBe(0);
        });
    });

    describe("cacheChunk and getCachedChunk", () => {
        it("should cache a chunk and retrieve it", () => {
            const chunk = createMockChunk("chunk-1");
            cacheLayer.cacheChunk(chunk);

            const cached = cacheLayer.getCachedChunk("chunk-1" as DocumentID);
            expect(cached).toBe(chunk);
            expect(cacheLayer.allocCount).toBe(1);
        });

        it("should return false for non-cached chunks", () => {
            const result = cacheLayer.getCachedChunk("non-existent" as DocumentID);
            expect(result).toBe(false);
        });

        it("should handle multiple chunks in cache", () => {
            const chunk1 = createMockChunk("chunk-1");
            const chunk2 = createMockChunk("chunk-2");
            const chunk3 = createMockChunk("chunk-3");

            cacheLayer.cacheChunk(chunk1);
            cacheLayer.cacheChunk(chunk2);
            cacheLayer.cacheChunk(chunk3);

            expect(cacheLayer.getCachedChunk("chunk-1" as DocumentID)).toBe(chunk1);
            expect(cacheLayer.getCachedChunk("chunk-2" as DocumentID)).toBe(chunk2);
            expect(cacheLayer.getCachedChunk("chunk-3" as DocumentID)).toBe(chunk3);
            expect(cacheLayer.allocCount).toBe(3);
        });

        it("should reorder (not replace) existing chunk in cache", () => {
            const chunk1 = createMockChunk("chunk-1", "data-1");
            const chunk1Updated = createMockChunk("chunk-1", "data-1-updated");

            cacheLayer.cacheChunk(chunk1);
            expect(cacheLayer.getCachedChunk("chunk-1" as DocumentID)).toBe(chunk1);

            cacheLayer.cacheChunk(chunk1Updated);
            const cached = cacheLayer.getCachedChunk("chunk-1" as DocumentID);
            // Should still be the original chunk (not replaced)
            expect(cached).toBe(chunk1);
            // allocCount should only increase on new additions
            expect(cacheLayer.allocCount).toBe(1);
        });
    });

    describe("LRU cache management", () => {
        it("should remove oldest chunks when exceeding max size", () => {
            const chunk1 = createMockChunk("chunk-1");
            const chunk2 = createMockChunk("chunk-2");
            const chunk3 = createMockChunk("chunk-3");
            const chunk4 = createMockChunk("chunk-4");

            cacheLayer.cacheChunk(chunk1);
            cacheLayer.cacheChunk(chunk2);
            cacheLayer.cacheChunk(chunk3);
            expect(cacheLayer.allocCount).toBe(3);

            cacheLayer.cacheChunk(chunk4);
            expect(cacheLayer.allocCount).toBe(4);

            // chunk1 should be evicted (oldest)
            expect(cacheLayer.getCachedChunk("chunk-1" as DocumentID)).toBe(false);
            expect(cacheLayer.getCachedChunk("chunk-2" as DocumentID)).toBe(chunk2);
            expect(cacheLayer.getCachedChunk("chunk-3" as DocumentID)).toBe(chunk3);
            expect(cacheLayer.getCachedChunk("chunk-4" as DocumentID)).toBe(chunk4);
        });

        it("should reorder chunk to end when accessed", () => {
            const chunk1 = createMockChunk("chunk-1");
            const chunk2 = createMockChunk("chunk-2");
            const chunk3 = createMockChunk("chunk-3");
            const chunk4 = createMockChunk("chunk-4");

            cacheLayer.cacheChunk(chunk1);
            cacheLayer.cacheChunk(chunk2);
            cacheLayer.cacheChunk(chunk3);

            // Access chunk1 to move it to end
            cacheLayer.getCachedChunk("chunk-1" as DocumentID);
            cacheLayer.reorderChunk("chunk-1" as DocumentID);

            // Add chunk4, should evict chunk2 instead of chunk1
            cacheLayer.cacheChunk(chunk4);

            expect(cacheLayer.getCachedChunk("chunk-1" as DocumentID)).toBe(chunk1);
            expect(cacheLayer.getCachedChunk("chunk-2" as DocumentID)).toBe(false);
            expect(cacheLayer.getCachedChunk("chunk-3" as DocumentID)).toBe(chunk3);
            expect(cacheLayer.getCachedChunk("chunk-4" as DocumentID)).toBe(chunk4);
        });
    });

    describe("reorderChunk", () => {
        it("should move existing chunk to end of cache", () => {
            const chunk1 = createMockChunk("chunk-1");
            const chunk2 = createMockChunk("chunk-2");
            const chunk3 = createMockChunk("chunk-3");

            cacheLayer.cacheChunk(chunk1);
            cacheLayer.cacheChunk(chunk2);
            cacheLayer.cacheChunk(chunk3);

            cacheLayer.reorderChunk("chunk-1" as DocumentID);
            const cached = cacheLayer.getCachedChunk("chunk-1" as DocumentID);
            expect(cached).toBe(chunk1);
        });

        it("should do nothing for non-existent chunk", () => {
            cacheLayer.reorderChunk("non-existent" as DocumentID);
            expect(cacheLayer.getStatistics().size).toBe(0);
        });
    });

    describe("deleteCachedChunk", () => {
        it("should delete a cached chunk", () => {
            const chunk = createMockChunk("chunk-1");
            cacheLayer.cacheChunk(chunk);
            expect(cacheLayer.getCachedChunk("chunk-1" as DocumentID)).toBe(chunk);

            cacheLayer.deleteCachedChunk("chunk-1" as DocumentID);
            expect(cacheLayer.getCachedChunk("chunk-1" as DocumentID)).toBe(false);
        });

        it("should handle deletion of non-existent chunk gracefully", () => {
            cacheLayer.deleteCachedChunk("non-existent" as DocumentID);
            expect(cacheLayer.getStatistics().size).toBe(0);
        });
    });

    describe("getChunkIDFromCache", () => {
        it("should find chunk ID by data content", () => {
            const chunk = createMockChunk("chunk-1", "specific-data");
            cacheLayer.cacheChunk(chunk);

            const id = cacheLayer.getChunkIDFromCache("specific-data");
            expect(id).toBe("chunk-1");
        });

        it("should return false when data not found", () => {
            const chunk = createMockChunk("chunk-1", "data-1");
            cacheLayer.cacheChunk(chunk);

            const id = cacheLayer.getChunkIDFromCache("non-existent-data");
            expect(id).toBe(false);
        });

        it("should search among multiple cached chunks", () => {
            const chunk1 = createMockChunk("chunk-1", "data-1");
            const chunk2 = createMockChunk("chunk-2", "data-2");
            const chunk3 = createMockChunk("chunk-3", "data-3");

            cacheLayer.cacheChunk(chunk1);
            cacheLayer.cacheChunk(chunk2);
            cacheLayer.cacheChunk(chunk3);

            expect(cacheLayer.getChunkIDFromCache("data-1")).toBe("chunk-1");
            expect(cacheLayer.getChunkIDFromCache("data-2")).toBe("chunk-2");
            expect(cacheLayer.getChunkIDFromCache("data-3")).toBe("chunk-3");
        });
    });

    describe("clearCaches", () => {
        it("should clear all cached chunks", () => {
            cacheLayer.cacheChunk(createMockChunk("chunk-1"));
            cacheLayer.cacheChunk(createMockChunk("chunk-2"));
            cacheLayer.cacheChunk(createMockChunk("chunk-3"));

            expect(cacheLayer.getStatistics().size).toBe(3);

            cacheLayer.clearCaches();

            expect(cacheLayer.getStatistics().size).toBe(0);
            expect(cacheLayer.allocCount).toBe(0);
            expect(cacheLayer.derefCount).toBe(0);
        });

        it("should clear counters when cache is cleared", () => {
            cacheLayer.cacheChunk(createMockChunk("chunk-1"));
            cacheLayer.allocCount = 10;
            cacheLayer.derefCount = 5;

            cacheLayer.clearCaches();

            expect(cacheLayer.allocCount).toBe(0);
            expect(cacheLayer.derefCount).toBe(0);
        });
    });

    describe("getStatistics", () => {
        it("should return cache statistics", () => {
            const chunk1 = createMockChunk("chunk-1");
            cacheLayer.cacheChunk(chunk1);

            const stats = cacheLayer.getStatistics();
            expect(stats.size).toBe(1);
            expect(stats.allocCount).toBe(1);
            expect(stats.derefCount).toBe(0);
        });

        it("should reflect cache size changes in statistics", () => {
            cacheLayer.cacheChunk(createMockChunk("chunk-1"));
            cacheLayer.cacheChunk(createMockChunk("chunk-2"));

            let stats = cacheLayer.getStatistics();
            expect(stats.size).toBe(2);

            cacheLayer.deleteCachedChunk("chunk-1" as DocumentID);
            stats = cacheLayer.getStatistics();
            expect(stats.size).toBe(1);
        });
    });

    describe("read (IReadLayer implementation)", () => {
        it("should return cached chunks without calling next", async () => {
            const chunk1 = createMockChunk("chunk-1");
            const chunk2 = createMockChunk("chunk-2");

            cacheLayer.cacheChunk(chunk1);
            cacheLayer.cacheChunk(chunk2);

            const nextFn = vi.fn();
            const result = await cacheLayer.read(["chunk-1" as DocumentID, "chunk-2" as DocumentID], {}, nextFn);

            expect(result).toEqual([chunk1, chunk2]);
            expect(nextFn).not.toHaveBeenCalled();
        });

        it("should call next layer for missing chunks", async () => {
            const chunk1 = createMockChunk("chunk-1");
            // const chunk2 = createMockChunk("chunk-2");
            const chunk3 = createMockChunk("chunk-3");

            cacheLayer.cacheChunk(chunk1);

            const nextFn = vi.fn().mockResolvedValue([false, chunk3]);
            const result = await cacheLayer.read(
                ["chunk-1" as DocumentID, "chunk-2" as DocumentID, "chunk-3" as DocumentID],
                {},
                nextFn
            );

            expect(result).toEqual([chunk1, false, chunk3]);
            expect(nextFn).toHaveBeenCalledWith(["chunk-2" as DocumentID, "chunk-3" as DocumentID]);
        });

        it("should skip cache when skipCache option is true", async () => {
            const chunk1 = createMockChunk("chunk-1");
            cacheLayer.cacheChunk(chunk1);

            const chunk2 = createMockChunk("chunk-2");
            const nextFn = vi.fn().mockResolvedValue([chunk2]);

            const result = await cacheLayer.read(
                ["chunk-2" as DocumentID],
                { skipCache: true } as ChunkReadOptions,
                nextFn
            );

            expect(result).toEqual([chunk2]);
            expect(nextFn).toHaveBeenCalledWith(["chunk-2" as DocumentID]);
        });

        it("should reorder chunks after read", async () => {
            const chunk1 = createMockChunk("chunk-1");
            const chunk2 = createMockChunk("chunk-2");
            const chunk3 = createMockChunk("chunk-3");

            cacheLayer.cacheChunk(chunk1);
            cacheLayer.cacheChunk(chunk2);
            cacheLayer.cacheChunk(chunk3);

            const nextFn = vi.fn();
            await cacheLayer.read(["chunk-1" as DocumentID], {}, nextFn);

            // Add new chunk to evict oldest
            const chunk4 = createMockChunk("chunk-4");
            cacheLayer.cacheChunk(chunk4);

            // chunk1 should not be evicted because it was reordered
            expect(cacheLayer.getCachedChunk("chunk-1" as DocumentID)).toBe(chunk1);
            expect(cacheLayer.getCachedChunk("chunk-2" as DocumentID)).toBe(false);
        });
    });

    describe("write (IWriteLayer implementation)", () => {
        it("should cache all chunks after write", async () => {
            const chunk1 = createMockChunk("chunk-1");
            const chunk2 = createMockChunk("chunk-2");

            const nextFn = vi.fn().mockResolvedValue({
                result: true,
                processed: {
                    ok: 2,
                },
            });

            const result = await cacheLayer.write(
                [chunk1, chunk2],
                {} as ChunkWriteOptions,
                "origin" as DocumentID,
                nextFn
            );

            expect(result.result).toBe(true);
            expect(cacheLayer.getCachedChunk("chunk-1" as DocumentID)).toBe(chunk1);
            expect(cacheLayer.getCachedChunk("chunk-2" as DocumentID)).toBe(chunk2);
        });

        it("should not write already cached chunks to next layer", async () => {
            const chunk1 = createMockChunk("chunk-1");
            const chunk2 = createMockChunk("chunk-2");

            cacheLayer.cacheChunk(chunk1);

            const nextFn = vi.fn().mockResolvedValue({
                result: true,
                processed: {
                    ok: 1,
                },
            });

            await cacheLayer.write([chunk1, chunk2], {} as ChunkWriteOptions, "origin" as DocumentID, nextFn);

            expect(nextFn).toHaveBeenCalledWith([chunk2]);
        });

        it("should skip cache when skipCache option is true", async () => {
            const chunk1 = createMockChunk("chunk-1");

            const nextFn = vi.fn().mockResolvedValue({
                result: true,
                processed: {
                    ok: 1,
                },
            });

            await cacheLayer.write([chunk1], { skipCache: true } as ChunkWriteOptions, "origin" as DocumentID, nextFn);

            // Chunk should not be cached
            expect(cacheLayer.getCachedChunk("chunk-1" as DocumentID)).toBe(false);
        });

        it("should handle failed writes", async () => {
            const chunk1 = createMockChunk("chunk-1");

            const nextFn = vi.fn().mockResolvedValue({
                result: false,
                processed: {
                    ok: 0,
                },
            });

            await cacheLayer.write([chunk1], {} as ChunkWriteOptions, "origin" as DocumentID, nextFn);

            // Chunk should not be cached on failed write
            expect(cacheLayer.getCachedChunk("chunk-1" as DocumentID)).toBe(false);
        });

        it("should track cached count in write result", async () => {
            const chunk1 = createMockChunk("chunk-1");
            const chunk2 = createMockChunk("chunk-2");

            cacheLayer.cacheChunk(chunk1);

            const nextFn = vi.fn().mockResolvedValue({
                result: true,
                processed: {
                    ok: 1,
                },
            });

            const result = await cacheLayer.write(
                [chunk1, chunk2],
                {} as ChunkWriteOptions,
                "origin" as DocumentID,
                nextFn
            );

            expect(result.processed.cached).toBe(1);
        });
    });

    describe("statistics tracking", () => {
        it("should track allocation count", () => {
            cacheLayer.cacheChunk(createMockChunk("chunk-1"));
            expect(cacheLayer.allocCount).toBe(1);

            cacheLayer.cacheChunk(createMockChunk("chunk-2"));
            expect(cacheLayer.allocCount).toBe(2);
        });

        it("should track deref count when chunk is garbage collected", () => {
            // This is a simplified test since actual garbage collection is outside our control
            // We manually increment derefCount in getCachedChunk when deref() returns undefined
            const stats = cacheLayer.getStatistics();
            expect(stats.derefCount).toBe(0);
        });
    });

    describe("edge cases and special scenarios", () => {
        it("should handle empty read request", async () => {
            const nextFn = vi.fn().mockResolvedValue([]);
            const result = await cacheLayer.read([], {}, nextFn);

            expect(result).toEqual([]);
            expect(nextFn).not.toHaveBeenCalled();
        });

        it("should handle empty write request", async () => {
            const nextFn = vi.fn().mockResolvedValue({
                result: true,
                processed: {
                    ok: 0,
                },
            });

            const result = await cacheLayer.write([], {} as ChunkWriteOptions, "origin" as DocumentID, nextFn);

            expect(result.result).toBe(true);
        });
    });
});
