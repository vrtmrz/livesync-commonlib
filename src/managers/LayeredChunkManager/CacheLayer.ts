import { FallbackWeakRef } from "octagonal-wheels/common/polyfill";
import type { DocumentID, EntryLeaf } from "../../common/types";
import type { IReadLayer, IWriteLayer } from "./ChunkLayerInterfaces";
import type { ChunkReadOptions, ChunkWriteOptions, WriteResult } from "./types.ts";

/**
 * Cache layer - manages in-memory cache of chunks.
 * Implements both IReadLayer and IWriteLayer for unified cache management.
 * This layer is self-contained and handles cache operations for both read and write operations.
 */

export class CacheLayer implements IReadLayer, IWriteLayer {
    private caches: Map<DocumentID, FallbackWeakRef<EntryLeaf>> = new Map();
    private maxCacheSize: number;
    allocCount = 0;
    derefCount = 0;

    constructor(maxCacheSize: number) {
        this.maxCacheSize = maxCacheSize;
    }

    /**
     * Get a cached chunk
     */
    getCachedChunk(id: DocumentID): EntryLeaf | false {
        if (!this.caches.has(id)) {
            return false;
        }
        const weakRef = this.caches.get(id);
        if (weakRef) {
            const cachedChunk = weakRef.deref();
            if (cachedChunk) {
                return cachedChunk;
            } else {
                this.derefCount++;
                this.deleteCachedChunk(id);
                return false;
            }
        }
        return false;
    }

    /**
     * Find chunk ID by data content
     */
    getChunkIDFromCache(data: string): DocumentID | false {
        for (const [id, weakRef] of this.caches) {
            const chunk = weakRef.deref();
            if (chunk) {
                if (chunk.data === data) {
                    return id;
                }
            } else {
                this.derefCount++;
                this.deleteCachedChunk(id);
            }
        }
        return false;
    }

    /**
     * Cache a chunk
     */
    cacheChunk(chunk: EntryLeaf): void {
        if (this.getCachedChunk(chunk._id)) {
            this.reorderChunk(chunk._id);
            return;
        }
        this.caches.set(chunk._id, new FallbackWeakRef(chunk));
        this.allocCount++;
        // Limit cache size
        if (this.caches.size > this.maxCacheSize) {
            do {
                const firstKey = this.caches.keys().next().value;
                if (firstKey) {
                    this.caches.delete(firstKey);
                }
            } while (this.caches.size > this.maxCacheSize);
        }
    }

    /**
     * Reorder chunk for LRU (move to end)
     */
    reorderChunk(id: DocumentID): void {
        const chunk = this.getCachedChunk(id);
        if (chunk) {
            this.caches.delete(id);
            this.caches.set(id, new FallbackWeakRef(chunk));
        }
    }

    /**
     * Delete a cached chunk
     */
    deleteCachedChunk(id: DocumentID): void {
        if (this.caches.has(id)) {
            this.caches.delete(id);
        }
    }

    /**
     * Clear all caches
     */
    clearCaches(): void {
        this.caches.clear();
        this.allocCount = 0;
        this.derefCount = 0;
    }

    /**
     * Tear down the layer (clear caches on shutdown)
     */
    tearDown(): void {
        this.clearCaches();
    }

    /**
     * Get current cache statistics
     */
    getStatistics() {
        return {
            size: this.caches.size,
            allocCount: this.allocCount,
            derefCount: this.derefCount,
        };
    }

    /**
     * IReadLayer implementation - read from cache
     */
    async read(
        ids: DocumentID[],
        options: ChunkReadOptions,
        next: (remaining: DocumentID[]) => Promise<(EntryLeaf | false)[]>
    ): Promise<(EntryLeaf | false)[]> {
        if (options.skipCache) {
            return next(ids);
        }

        const resultMap = new Map<DocumentID, EntryLeaf | false>();
        const remainingIds: DocumentID[] = [];

        for (const id of ids) {
            const cached = this.getCachedChunk(id);
            if (cached) {
                this.reorderChunk(id);
                resultMap.set(id, cached);
            } else {
                remainingIds.push(id);
            }
        }

        // If all chunks were found in cache, return immediately
        if (remainingIds.length === 0) {
            return ids.map((id) => resultMap.get(id) || false);
        }

        // Get remaining chunks from next layer
        const nextResults = await next(remainingIds);
        const nextResultMap = new Map(remainingIds.map((id, index) => [id, nextResults[index]]));

        // Merge results
        return ids.map((id) => resultMap.get(id) ?? nextResultMap.get(id) ?? false);
    }

    /**
     * IWriteLayer implementation - cache chunks after database write
     */
    async write(
        chunks: EntryLeaf[],
        options: ChunkWriteOptions,
        origin: DocumentID,
        next: (remaining: EntryLeaf[]) => Promise<WriteResult>
    ): Promise<WriteResult> {
        // Filter out chunks already in cache
        const filtered: EntryLeaf[] = [];
        const cachedCount = chunks.length;

        for (const chunk of chunks) {
            const cached = this.getCachedChunk(chunk._id);
            if (!cached) {
                filtered.push(chunk);
            } else {
                this.reorderChunk(chunk._id);
            }
        }

        // Pass non-cached chunks to the next layer (database write)
        const result = await next(filtered);

        // Cache all chunks (both database-written and pre-cached)
        if (result.result && !options.skipCache) {
            for (const chunk of chunks) {
                this.cacheChunk(chunk);
            }
        }

        // Update cache count in the result
        if (result.processed) {
            result.processed.cached = cachedCount - filtered.length;
        }

        return result;
    }
}
