import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { ChunkFetcher, EVENT_MISSING_CHUNKS, EVENT_CHUNK_FETCHED, EVENT_MISSING_CHUNK_REMOTE } from "./ChunkFetcher";
import type { ChunkFetcherOptions } from "./ChunkFetcher";
import type { DocumentID, EntryLeaf } from "../common/types";
import type { ChunkManager } from "./ChunkManager";
import type { IReplicatorService, ISettingService } from "../services/base/IService";

function createMockLeaf(id: string, data: string = `data-${id}`): EntryLeaf {
    return {
        _id: id as DocumentID,
        type: "leaf" as any,
        data: data,
    } as EntryLeaf;
}

describe("ChunkFetcher", () => {
    let chunkFetcher: ChunkFetcher;
    let mockChunkManager: Partial<ChunkManager>;
    let mockSettingService: Partial<ISettingService>;
    let mockReplicatorService: Partial<IReplicatorService> & { getActiveReplicator: ReturnType<typeof vi.fn> };
    let eventListeners: Map<string, ((...args: any[]) => void)[]>;

    beforeEach(() => {
        // Reset event listeners
        eventListeners = new Map();

        // Mock ChunkManager
        mockChunkManager = {
            addListener: vi.fn((event: string, handler: (...args: any[]) => void, options?: any) => {
                if (!eventListeners.has(event)) {
                    eventListeners.set(event, []);
                }
                eventListeners.get(event)!.push(handler);
            }),
            emitEvent: vi.fn((event: string, ...args: any[]) => {
                const handlers = eventListeners.get(event);
                if (handlers) {
                    handlers.forEach((handler) => handler(...args));
                }
            }),
            write: vi.fn().mockResolvedValue({
                result: true,
                processed: { written: 1 },
            }),
        } as any;

        // Mock SettingService
        mockSettingService = {
            currentSettings: vi.fn(() => ({
                minimumIntervalOfReadChunksOnline: 100,
                concurrencyOfReadChunksOnline: 2,
            })),
        } as any;

        // Mock ReplicatorService
        mockReplicatorService = {
            getActiveReplicator: vi.fn(),
        } as any;

        const options: ChunkFetcherOptions = {
            settingService: mockSettingService as ISettingService,
            chunkManager: mockChunkManager as ChunkManager,
            replicatorService: mockReplicatorService as IReplicatorService,
        };

        chunkFetcher = new ChunkFetcher(options);
    });

    afterEach(() => {
        chunkFetcher.destroy();
        vi.clearAllMocks();
    });

    describe("Initialization", () => {
        it("should initialize successfully", () => {
            expect(chunkFetcher).toBeDefined();
            expect(chunkFetcher.options).toBeDefined();
            expect(chunkFetcher.queue).toEqual([]);
        });

        it("should register event listener for EVENT_MISSING_CHUNKS", () => {
            expect(mockChunkManager.addListener).toHaveBeenCalledWith(
                EVENT_MISSING_CHUNKS,
                expect.any(Function),
                expect.objectContaining({ signal: expect.any(AbortSignal) })
            );
        });

        it("should return correct interval from settings", () => {
            expect(chunkFetcher.interval).toBe(100);
        });

        it("should return correct concurrency from settings", () => {
            expect(chunkFetcher.concurrency).toBe(2);
        });

        it("should return chunkManager from options", () => {
            expect(chunkFetcher.chunkManager).toBe(mockChunkManager);
        });
    });

    describe("Destroy", () => {
        it("should clear queue and abort on destroy", () => {
            chunkFetcher.queue = ["id1" as DocumentID, "id2" as DocumentID];
            const abortSpy = vi.spyOn(chunkFetcher.abort, "abort");

            chunkFetcher.destroy();

            expect(chunkFetcher.queue).toEqual([]);
            expect(abortSpy).toHaveBeenCalled();
        });
    });

    describe("Event Handling", () => {
        it("should add IDs to queue when receiving EVENT_MISSING_CHUNKS", () => {
            const ids = ["chunk-1" as DocumentID, "chunk-2" as DocumentID];

            chunkFetcher.onEvent(ids);

            expect(chunkFetcher.queue).toEqual(ids);
        });

        it("should deduplicate IDs in queue", () => {
            const ids1 = ["chunk-1" as DocumentID, "chunk-2" as DocumentID];
            const ids2 = ["chunk-2" as DocumentID, "chunk-3" as DocumentID];

            chunkFetcher.onEvent(ids1);
            chunkFetcher.onEvent(ids2);

            expect(chunkFetcher.queue).toHaveLength(3);
            expect(chunkFetcher.queue).toContain("chunk-1" as DocumentID);
            expect(chunkFetcher.queue).toContain("chunk-2" as DocumentID);
            expect(chunkFetcher.queue).toContain("chunk-3" as DocumentID);
        });

        it("should trigger requestMissingChunks when canRequestMore returns true", async () => {
            vi.spyOn(chunkFetcher, "canRequestMore").mockReturnValue(true);
            const requestSpy = vi.spyOn(chunkFetcher, "requestMissingChunks").mockResolvedValue();

            chunkFetcher.onEvent(["chunk-1" as DocumentID]);

            // Wait for setTimeout to trigger
            await new Promise((resolve) => setTimeout(resolve, 10));

            expect(requestSpy).toHaveBeenCalled();
        });
    });

    describe("canRequestMore", () => {
        it("should return true when processing is below concurrency and queue has items", () => {
            chunkFetcher.currentProcessing = 1;
            chunkFetcher.queue = ["chunk-1" as DocumentID];

            expect(chunkFetcher.canRequestMore()).toBe(true);
        });

        it("should return false when processing equals concurrency", () => {
            chunkFetcher.currentProcessing = 2;
            chunkFetcher.queue = ["chunk-1" as DocumentID];

            expect(chunkFetcher.canRequestMore()).toBe(false);
        });

        it("should return false when queue is empty", () => {
            chunkFetcher.currentProcessing = 0;
            chunkFetcher.queue = [];

            expect(chunkFetcher.canRequestMore()).toBe(false);
        });
    });

    describe("requestMissingChunks", () => {
        it("should return early if canRequestMore returns false", async () => {
            chunkFetcher.currentProcessing = 2;
            chunkFetcher.queue = [];

            await chunkFetcher.requestMissingChunks();

            expect(mockReplicatorService.getActiveReplicator).not.toHaveBeenCalled();
        });

        it("should request chunks from active replicator", async () => {
            const mockReplicator = {
                fetchRemoteChunks: vi.fn().mockResolvedValue([createMockLeaf("chunk-1")]),
            };
            mockReplicatorService.getActiveReplicator.mockReturnValue(mockReplicator as any);

            chunkFetcher.queue = ["chunk-1" as DocumentID];

            await chunkFetcher.requestMissingChunks();

            expect(mockReplicatorService.getActiveReplicator).toHaveBeenCalled();
            expect(mockReplicator.fetchRemoteChunks).toHaveBeenCalledWith(["chunk-1"], false);
        });

        it("should handle no active replicator", async () => {
            mockReplicatorService.getActiveReplicator.mockReturnValue(null);

            chunkFetcher.queue = ["chunk-1" as DocumentID];

            await chunkFetcher.requestMissingChunks();

            expect(mockReplicatorService.getActiveReplicator).toHaveBeenCalled();
            expect(mockChunkManager.write).not.toHaveBeenCalled();
        });

        it("should write fetched chunks to database", async () => {
            const chunks = [createMockLeaf("chunk-1"), createMockLeaf("chunk-2")];
            const mockReplicator = {
                fetchRemoteChunks: vi.fn().mockResolvedValue(chunks),
            };
            mockReplicatorService.getActiveReplicator.mockReturnValue(mockReplicator as any);

            chunkFetcher.queue = ["chunk-1" as DocumentID, "chunk-2" as DocumentID];

            await chunkFetcher.requestMissingChunks();

            expect(mockChunkManager.write).toHaveBeenCalledWith(
                chunks,
                { skipCache: true, force: true },
                "ChunkFetcher" as DocumentID
            );
        });

        it("should emit EVENT_CHUNK_FETCHED for successfully fetched chunks", async () => {
            const chunks = [createMockLeaf("chunk-1")];
            const mockReplicator = {
                fetchRemoteChunks: vi.fn().mockResolvedValue(chunks),
            };
            mockReplicatorService.getActiveReplicator.mockReturnValue(mockReplicator as any);

            chunkFetcher.queue = ["chunk-1" as DocumentID];

            await chunkFetcher.requestMissingChunks();

            expect(mockChunkManager.emitEvent).toHaveBeenCalledWith(EVENT_CHUNK_FETCHED, chunks[0]);
        });

        it("should emit EVENT_MISSING_CHUNK_REMOTE for missing chunks", async () => {
            const chunks = [createMockLeaf("chunk-1")];
            const mockReplicator = {
                fetchRemoteChunks: vi.fn().mockResolvedValue(chunks),
            };
            mockReplicatorService.getActiveReplicator.mockReturnValue(mockReplicator as any);

            chunkFetcher.queue = ["chunk-1" as DocumentID, "chunk-2" as DocumentID];

            await chunkFetcher.requestMissingChunks();

            expect(mockChunkManager.emitEvent).toHaveBeenCalledWith(
                EVENT_MISSING_CHUNK_REMOTE,
                "chunk-2" as DocumentID
            );
        });

        it("should filter out invalid chunks", async () => {
            const chunks = [
                createMockLeaf("chunk-1"),
                { _id: "chunk-2" }, // Missing data field
                { data: "some-data" }, // Missing _id field
            ];
            const mockReplicator = {
                fetchRemoteChunks: vi.fn().mockResolvedValue(chunks),
            };
            mockReplicatorService.getActiveReplicator.mockReturnValue(mockReplicator as any);

            chunkFetcher.queue = ["chunk-1" as DocumentID, "chunk-2" as DocumentID];

            await chunkFetcher.requestMissingChunks();

            expect(mockChunkManager.write).toHaveBeenCalledWith(
                [chunks[0]],
                { skipCache: true, force: true },
                "ChunkFetcher" as DocumentID
            );
        });

        it("should respect interval between requests", async () => {
            const mockReplicator = {
                fetchRemoteChunks: vi.fn().mockResolvedValue([createMockLeaf("chunk-1")]),
            };
            mockReplicatorService.getActiveReplicator.mockReturnValue(mockReplicator as any);

            chunkFetcher.queue = ["chunk-1" as DocumentID];
            chunkFetcher.previousRequestTime = Date.now() - 50; // 50ms ago

            const startTime = Date.now();
            await chunkFetcher.requestMissingChunks();
            const endTime = Date.now();

            // Should have waited at least 50ms (100ms interval - 50ms since last request)
            expect(endTime - startTime).toBeGreaterThanOrEqual(40);
        });

        it("should handle write errors gracefully", async () => {
            const chunks = [createMockLeaf("chunk-1")];
            const mockReplicator = {
                fetchRemoteChunks: vi.fn().mockResolvedValue(chunks),
            };
            mockReplicatorService.getActiveReplicator.mockReturnValue(mockReplicator as any);
            (mockChunkManager.write as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("Write failed"));

            chunkFetcher.queue = ["chunk-1" as DocumentID];

            await expect(chunkFetcher.requestMissingChunks()).resolves.not.toThrow();
        });

        it("should decrement currentProcessing after completion", async () => {
            const mockReplicator = {
                fetchRemoteChunks: vi.fn().mockResolvedValue([createMockLeaf("chunk-1")]),
            };
            mockReplicatorService.getActiveReplicator.mockReturnValue(mockReplicator as any);

            chunkFetcher.queue = ["chunk-1" as DocumentID];

            expect(chunkFetcher.currentProcessing).toBe(0);
            const promise = chunkFetcher.requestMissingChunks();
            expect(chunkFetcher.currentProcessing).toBe(1);
            await promise;
            expect(chunkFetcher.currentProcessing).toBe(0);
        });

        it("should trigger next request if queue has remaining items", async () => {
            // Create more than BATCH_SIZE (100) items to force multiple requests
            const chunkIds = Array.from({ length: 150 }, (_, i) => `chunk-${i}` as DocumentID);
            const firstBatch = chunkIds.slice(0, 100).map((id) => createMockLeaf(id));

            const mockReplicator = {
                fetchRemoteChunks: vi.fn().mockResolvedValue(firstBatch),
            };
            mockReplicatorService.getActiveReplicator.mockReturnValue(mockReplicator as any);

            chunkFetcher.queue = [...chunkIds];

            await chunkFetcher.requestMissingChunks();

            // Wait for setTimeout to trigger the next request
            await new Promise((resolve) => setTimeout(resolve, 150));

            // Should have been called twice: once for first 100, once for remaining 50
            expect(mockReplicator.fetchRemoteChunks).toHaveBeenCalledTimes(2);
        });

        it("should handle batch size correctly", async () => {
            const chunks = Array.from({ length: 150 }, (_, i) => createMockLeaf(`chunk-${i}`));
            const mockReplicator = {
                fetchRemoteChunks: vi.fn().mockResolvedValue(chunks.slice(0, 100)),
            };
            mockReplicatorService.getActiveReplicator.mockReturnValue(mockReplicator as any);

            chunkFetcher.queue = chunks.map((c) => c._id);

            await chunkFetcher.requestMissingChunks();

            // Should request only 100 chunks (BATCH_SIZE)
            expect(mockReplicator.fetchRemoteChunks).toHaveBeenCalledWith(
                expect.arrayContaining(chunks.slice(0, 100).map((c) => c._id)),
                false
            );
            expect(mockReplicator.fetchRemoteChunks.mock.calls[0][0]).toHaveLength(100);
            // Remaining 50 chunks should still be in queue
            expect(chunkFetcher.queue).toHaveLength(50);
        });

        it("should emit EVENT_MISSING_CHUNK_REMOTE when no chunks are fetched", async () => {
            const mockReplicator = {
                fetchRemoteChunks: vi.fn().mockResolvedValue(false),
            };
            mockReplicatorService.getActiveReplicator.mockReturnValue(mockReplicator as any);

            const requestIDs = ["chunk-1" as DocumentID, "chunk-2" as DocumentID];
            chunkFetcher.queue = [...requestIDs];

            await chunkFetcher.requestMissingChunks();

            expect(mockChunkManager.emitEvent).toHaveBeenCalledWith(EVENT_MISSING_CHUNK_REMOTE, "chunk-1");
            expect(mockChunkManager.emitEvent).toHaveBeenCalledWith(EVENT_MISSING_CHUNK_REMOTE, "chunk-2");
        });
    });
});
