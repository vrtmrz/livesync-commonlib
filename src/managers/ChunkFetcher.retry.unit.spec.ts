import { reactiveSource } from "octagonal-wheels/dataobject/reactive";
import { promiseWithResolvers } from "octagonal-wheels/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DocumentID, EntryLeaf } from "@lib/common/types";
import { chunkFetchCounts, collectingChunks } from "@lib/mock_and_interop/stores";
import type { IReplicatorService, ISettingService } from "@lib/services/base/IService";
import { ChunkDeliveryCoordinator } from "./ChunkDeliveryCoordinator";
import { ChunkFetcher, EVENT_CHUNK_FETCHED, EVENT_MISSING_CHUNK_REMOTE } from "./ChunkFetcher";
import type { ChunkManager } from "./ChunkManager";

const firstId = "chunk-1" as DocumentID;
const secondId = "chunk-2" as DocumentID;
const leaf = (id: DocumentID): EntryLeaf => ({ _id: id, type: "leaf", data: `data-${id}` });

describe("ChunkFetcher retry queue", () => {
    let fetcher: ChunkFetcher;
    let coordinator: ChunkDeliveryCoordinator;
    let finiteActivity: ReturnType<typeof reactiveSource<number>>;
    let boundedActivity: ReturnType<typeof reactiveSource<number>>;
    let fetchRemoteChunks: ReturnType<typeof vi.fn>;
    let read: ReturnType<typeof vi.fn>;
    let emitEvent: ReturnType<typeof vi.fn>;
    let localChunks: Map<DocumentID, EntryLeaf>;
    let initialCount: number;
    let initialFetchCounts: { initial: number; retrying: number };
    let starts: { at: number; ids: DocumentID[] }[];

    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(100_000);
        initialCount = collectingChunks.value;
        initialFetchCounts = { ...chunkFetchCounts.value };
        finiteActivity = reactiveSource(0);
        boundedActivity = reactiveSource(0);
        coordinator = new ChunkDeliveryCoordinator(finiteActivity);
        localChunks = new Map();
        starts = [];
        fetchRemoteChunks = vi.fn(async (ids: DocumentID[]) => {
            starts.push({ at: Date.now(), ids: [...ids] });
            return [] as EntryLeaf[];
        });
        read = vi.fn(async (ids: DocumentID[]) => ids.map((id) => localChunks.get(id) ?? false));
        emitEvent = vi.fn();
        fetcher = new ChunkFetcher({
            chunkManager: {
                deliveryCoordinator: coordinator,
                addListener: vi.fn(),
                emitEvent,
                read,
                write: vi.fn(async () => ({ result: true, processed: { written: 1 } })),
            } as unknown as ChunkManager,
            settingService: {
                currentSettings: () => ({ concurrencyOfReadChunksOnline: 1, minimumIntervalOfReadChunksOnline: 100 }),
            } as unknown as ISettingService,
            replicatorService: {
                finiteReplicationActivityCount: finiteActivity,
                boundedRemoteActivityCount: boundedActivity,
                getActiveReplicator: () => ({ fetchRemoteChunks }),
                runBoundedRemoteActivity: async (task: () => Promise<unknown>) => {
                    boundedActivity.value++;
                    try {
                        return await task();
                    } finally {
                        boundedActivity.value--;
                    }
                },
            } as unknown as IReplicatorService,
        });
    });

    afterEach(async () => {
        fetcher.destroy();
        coordinator.dispose();
        await Promise.resolve();
        expect(collectingChunks.value).toBe(initialCount);
        expect(chunkFetchCounts.value).toEqual(initialFetchCounts);
        expect(boundedActivity.value).toBe(0);
        vi.clearAllTimers();
        vi.useRealTimers();
    });

    it("makes one autonomous retry after two seconds when no finite replication is active", async () => {
        fetcher.onEvent([firstId]);
        await vi.advanceTimersByTimeAsync(1);
        expect(fetchRemoteChunks).toHaveBeenCalledOnce();
        await vi.advanceTimersByTimeAsync(1_999);
        expect(fetchRemoteChunks).toHaveBeenCalledOnce();
        expect(coordinator.isClaimActiveFor(firstId)).toBe(true);

        await vi.advanceTimersByTimeAsync(1);

        expect(fetchRemoteChunks).toHaveBeenCalledTimes(2);
        expect(starts.map(({ at }) => at)).toEqual([100_001, 102_001]);
        expect(emitEvent).toHaveBeenCalledWith(EVENT_MISSING_CHUNK_REMOTE, firstId);
        expect(coordinator.isClaimActiveFor(firstId)).toBe(false);
        expect(collectingChunks.value).toBe(initialCount);
        await vi.advanceTimersByTimeAsync(20_000);
        expect(fetchRemoteChunks).toHaveBeenCalledTimes(2);
    });

    it("returns the concurrency slot during backoff without releasing the delivery claim", async () => {
        fetchRemoteChunks.mockImplementation(async (ids: DocumentID[]) =>
            ids.includes(secondId) ? [leaf(secondId)] : []
        );
        fetcher.onEvent([firstId]);
        await vi.advanceTimersByTimeAsync(1);
        expect(fetcher.currentProcessing).toBe(0);
        expect(coordinator.isClaimActiveFor(firstId)).toBe(true);
        expect(boundedActivity.value).toBe(1);

        fetcher.onEvent([secondId]);
        await vi.advanceTimersByTimeAsync(100);

        expect(fetchRemoteChunks).toHaveBeenNthCalledWith(2, [secondId], false);
        expect(coordinator.isClaimActiveFor(firstId)).toBe(true);
        expect(coordinator.isClaimActiveFor(secondId)).toBe(false);
        expect(collectingChunks.value).toBe(initialCount + 1);
    });

    it("backs off by two seconds up to ten seconds while finite replication remains active", async () => {
        finiteActivity.value = 1;
        fetcher.onEvent([firstId]);
        await vi.advanceTimersByTimeAsync(1);
        for (const wait of [2_000, 4_000, 6_000, 8_000, 10_000, 10_000]) {
            const previousAttempts = fetchRemoteChunks.mock.calls.length;
            await vi.advanceTimersByTimeAsync(wait - 1);
            expect(fetchRemoteChunks).toHaveBeenCalledTimes(previousAttempts);
            await vi.advanceTimersByTimeAsync(1);
            expect(fetchRemoteChunks).toHaveBeenCalledTimes(previousAttempts + 1);
            expect(fetcher.currentProcessing).toBe(0);
            expect(collectingChunks.value).toBe(initialCount + 1);
        }
        expect(starts.map(({ at }) => at)).toEqual([100_001, 102_001, 106_001, 112_001, 120_001, 130_001, 140_001]);
        expect(emitEvent).not.toHaveBeenCalledWith(EVENT_MISSING_CHUNK_REMOTE, firstId);
    });

    it("interrupts a six-second backoff with one final probe when finite replication ends", async () => {
        finiteActivity.value = 1;
        fetcher.onEvent([firstId]);
        await vi.advanceTimersByTimeAsync(6_001);
        expect(fetchRemoteChunks).toHaveBeenCalledTimes(3);
        await vi.advanceTimersByTimeAsync(1_000);

        finiteActivity.value = 0;
        await vi.advanceTimersByTimeAsync(0);

        expect(starts.map(({ at }) => at)).toEqual([100_001, 102_001, 106_001, 107_001]);
        expect(coordinator.isClaimActiveFor(firstId)).toBe(false);
        expect(collectingChunks.value).toBe(initialCount);
        await vi.advanceTimersByTimeAsync(10_000);
        expect(fetchRemoteChunks).toHaveBeenCalledTimes(4);
    });

    it("waits for the last overlapping finite replication and still respects the request interval", async () => {
        finiteActivity.value = 2;
        fetcher.onEvent([firstId]);
        await vi.advanceTimersByTimeAsync(1);
        finiteActivity.value = 1;
        await vi.advanceTimersByTimeAsync(10);
        expect(fetchRemoteChunks).toHaveBeenCalledOnce();
        finiteActivity.value = 0;
        await vi.advanceTimersByTimeAsync(89);
        expect(fetchRemoteChunks).toHaveBeenCalledOnce();

        await vi.advanceTimersByTimeAsync(1);

        expect(starts.map(({ at }) => at)).toEqual([100_001, 100_101]);
        expect(coordinator.isClaimActiveFor(firstId)).toBe(false);
    });

    it("rechecks local persistence before the final remote probe", async () => {
        finiteActivity.value = 1;
        fetcher.onEvent([firstId]);
        await vi.advanceTimersByTimeAsync(1);
        localChunks.set(firstId, leaf(firstId));

        finiteActivity.value = 0;
        await vi.advanceTimersByTimeAsync(0);

        expect(read).toHaveBeenCalledWith([firstId], {
            preventRemoteRequest: true,
            skipCache: true,
            waitForDelivery: false,
        });
        expect(fetchRemoteChunks).toHaveBeenCalledOnce();
        expect(emitEvent).toHaveBeenCalledWith(EVENT_CHUNK_FETCHED, leaf(firstId));
        expect(emitEvent).not.toHaveBeenCalledWith(EVENT_MISSING_CHUNK_REMOTE, firstId);
        expect(coordinator.isClaimActiveFor(firstId)).toBe(false);
    });

    it("does not let an in-flight pre-completion lookup stand in for the final probe", async () => {
        const inFlight = promiseWithResolvers<EntryLeaf[]>();
        fetchRemoteChunks
            .mockResolvedValueOnce([])
            .mockImplementationOnce(() => inFlight.promise)
            .mockResolvedValue([]);
        try {
            finiteActivity.value = 1;
            fetcher.onEvent([firstId]);
            await vi.advanceTimersByTimeAsync(2_001);
            expect(fetchRemoteChunks).toHaveBeenCalledTimes(2);

            finiteActivity.value = 0;
            await vi.advanceTimersByTimeAsync(1_000);
            expect(fetchRemoteChunks).toHaveBeenCalledTimes(2);
            expect(coordinator.isClaimActiveFor(firstId)).toBe(true);
            inFlight.resolve([]);
            await vi.advanceTimersByTimeAsync(0);
            expect(fetchRemoteChunks).toHaveBeenCalledTimes(2);
            await vi.advanceTimersByTimeAsync(100);

            expect(fetchRemoteChunks).toHaveBeenCalledTimes(3);
            expect(coordinator.isClaimActiveFor(firstId)).toBe(false);
        } finally {
            inFlight.resolve([]);
            await vi.advanceTimersByTimeAsync(0);
        }
    });

    it("rechecks local persistence if finite replication ends during the request-interval wait", async () => {
        fetcher.options.settingService.currentSettings = (() => ({
            concurrencyOfReadChunksOnline: 1,
            minimumIntervalOfReadChunksOnline: 3_000,
        })) as ISettingService["currentSettings"];
        finiteActivity.value = 1;
        fetcher.onEvent([firstId]);
        await vi.advanceTimersByTimeAsync(2_001);
        expect(read).toHaveBeenCalledOnce();
        expect(fetchRemoteChunks).toHaveBeenCalledOnce();
        localChunks.set(firstId, leaf(firstId));
        finiteActivity.value = 0;
        await vi.advanceTimersByTimeAsync(1_000);

        expect(fetchRemoteChunks).toHaveBeenCalledOnce();
        expect(emitEvent).toHaveBeenCalledWith(EVENT_CHUNK_FETCHED, leaf(firstId));
        expect(coordinator.isClaimActiveFor(firstId)).toBe(false);
    });

    it("does not reset the retry time when the same identifier is requested again", async () => {
        fetcher.onEvent([firstId]);
        await vi.advanceTimersByTimeAsync(1_001);
        fetcher.onEvent([firstId, firstId]);
        await vi.advanceTimersByTimeAsync(1_000);

        expect(fetchRemoteChunks).toHaveBeenCalledTimes(2);
        expect(starts.map(({ at }) => at)).toEqual([100_001, 102_001]);
        expect(collectingChunks.value).toBe(initialCount);
    });

    it("keeps per-identifier backoff when different retry stages share a batch", async () => {
        finiteActivity.value = 1;
        fetcher.onEvent([firstId]);
        await vi.advanceTimersByTimeAsync(4_000);
        fetcher.onEvent([secondId]);
        await vi.advanceTimersByTimeAsync(2_001);

        expect(starts).toEqual([
            { at: 100_001, ids: [firstId] },
            { at: 102_001, ids: [firstId] },
            { at: 104_001, ids: [secondId] },
            { at: 106_001, ids: [firstId, secondId] },
        ]);
        await vi.advanceTimersByTimeAsync(4_000);
        expect(starts.at(-1)).toEqual({ at: 110_001, ids: [secondId] });
        await vi.advanceTimersByTimeAsync(2_000);
        expect(starts.at(-1)).toEqual({ at: 112_001, ids: [firstId] });
        expect(collectingChunks.value).toBe(initialCount + 2);
    });

    it("includes an eligible retry before newer work and keeps the batch limit", async () => {
        finiteActivity.value = 1;
        fetcher.onEvent([firstId]);
        await vi.advanceTimersByTimeAsync(2_000);
        const freshIds = Array.from({ length: 250 }, (_, index) => `fresh-${index}` as DocumentID);
        fetcher.onEvent(freshIds);
        await vi.advanceTimersByTimeAsync(1);

        expect(starts[1]).toEqual({ at: 102_001, ids: [firstId, ...freshIds.slice(0, 99)] });
        await vi.advanceTimersByTimeAsync(200);
        expect(starts.slice(1).flatMap(({ ids }) => ids)).toEqual([firstId, ...freshIds]);
        expect(starts.every(({ ids }) => ids.length <= 100)).toBe(true);
        expect(collectingChunks.value).toBe(initialCount + 251);
    });

    it("requires a probe after the latest completion if a new finite activity ends during the final probe", async () => {
        const finalProbe = promiseWithResolvers<EntryLeaf[]>();
        fetchRemoteChunks
            .mockResolvedValueOnce([])
            .mockImplementationOnce(() => finalProbe.promise)
            .mockResolvedValue([]);
        try {
            finiteActivity.value = 1;
            fetcher.onEvent([firstId]);
            await vi.advanceTimersByTimeAsync(1_001);
            finiteActivity.value = 0;
            await vi.advanceTimersByTimeAsync(0);
            expect(fetchRemoteChunks).toHaveBeenCalledTimes(2);

            finiteActivity.value = 1;
            finiteActivity.value = 0;
            finalProbe.resolve([]);
            await vi.advanceTimersByTimeAsync(0);
            expect(emitEvent).not.toHaveBeenCalledWith(EVENT_MISSING_CHUNK_REMOTE, firstId);
            await vi.advanceTimersByTimeAsync(100);

            expect(fetchRemoteChunks).toHaveBeenCalledTimes(3);
            expect(emitEvent).toHaveBeenCalledWith(EVENT_MISSING_CHUNK_REMOTE, firstId);
            expect(coordinator.isClaimActiveFor(firstId)).toBe(false);
        } finally {
            finalProbe.resolve([]);
            await vi.advanceTimersByTimeAsync(0);
        }
    });

    it("uses local arrival during ordinary backoff without another remote request", async () => {
        fetcher.onEvent([firstId]);
        await vi.advanceTimersByTimeAsync(1);
        localChunks.set(firstId, leaf(firstId));
        await vi.advanceTimersByTimeAsync(2_000);

        expect(fetchRemoteChunks).toHaveBeenCalledOnce();
        expect(emitEvent).toHaveBeenCalledWith(EVENT_CHUNK_FETCHED, leaf(firstId));
        expect(coordinator.isClaimActiveFor(firstId)).toBe(false);
    });

    it("moves an identifier from initial to retrying without double-counting it", async () => {
        const finalProbe = promiseWithResolvers<EntryLeaf[]>();
        fetchRemoteChunks.mockResolvedValueOnce([]).mockImplementationOnce(() => finalProbe.promise);
        try {
            fetcher.onEvent([firstId, firstId]);
            expect(chunkFetchCounts.value).toEqual({
                initial: initialFetchCounts.initial + 1,
                retrying: initialFetchCounts.retrying,
            });
            await vi.advanceTimersByTimeAsync(1);
            expect(chunkFetchCounts.value).toEqual({
                initial: initialFetchCounts.initial,
                retrying: initialFetchCounts.retrying + 1,
            });
            expect(collectingChunks.value).toBe(initialCount + 1);
            await vi.advanceTimersByTimeAsync(2_000);
            expect(fetcher.currentProcessing).toBe(1);
            expect(chunkFetchCounts.value.retrying).toBe(initialFetchCounts.retrying + 1);
            finalProbe.resolve([]);
            await vi.advanceTimersByTimeAsync(0);
            expect(chunkFetchCounts.value).toEqual(initialFetchCounts);
        } finally {
            finalProbe.resolve([]);
            await vi.advanceTimersByTimeAsync(0);
        }
    });

    it("does not clear another fetcher's initial counts when destroying a retrying fetcher", async () => {
        const otherCoordinator = new ChunkDeliveryCoordinator();
        const otherFetcher = new ChunkFetcher({
            ...fetcher.options,
            chunkManager: { ...fetcher.chunkManager, deliveryCoordinator: otherCoordinator } as ChunkManager,
        });
        try {
            fetcher.onEvent([firstId]);
            await vi.advanceTimersByTimeAsync(1);
            otherFetcher.currentProcessing = otherFetcher.concurrency;
            otherFetcher.onEvent([firstId, secondId]);
            expect(chunkFetchCounts.value).toEqual({
                initial: initialFetchCounts.initial + 2,
                retrying: initialFetchCounts.retrying + 1,
            });

            fetcher.destroy();
            expect(chunkFetchCounts.value).toEqual({
                initial: initialFetchCounts.initial + 2,
                retrying: initialFetchCounts.retrying,
            });
            expect(collectingChunks.value).toBe(initialCount + 2);
        } finally {
            otherFetcher.destroy();
            otherCoordinator.dispose();
        }
    });

    it("cancels retry timers and finite-completion observation on destruction", async () => {
        finiteActivity.value = 1;
        fetcher.onEvent([firstId]);
        await vi.advanceTimersByTimeAsync(1);
        fetcher.destroy();
        finiteActivity.value = 0;
        await vi.advanceTimersByTimeAsync(20_000);

        expect(fetchRemoteChunks).toHaveBeenCalledOnce();
        expect(fetcher.queue).toEqual([]);
        expect(chunkFetchCounts.value).toEqual(initialFetchCounts);
        expect(vi.getTimerCount()).toBe(0);
    });

    it("removes stalled retry ownership and its scheduled request", async () => {
        fetcher.options.deliveryStallTimeoutMs = 500;
        fetcher.onEvent([firstId]);
        await vi.advanceTimersByTimeAsync(501);

        expect(fetcher.queue).toEqual([]);
        expect(coordinator.isClaimActiveFor(firstId)).toBe(false);
        expect(chunkFetchCounts.value).toEqual(initialFetchCounts);
        expect(boundedActivity.value).toBe(0);
        await vi.advanceTimersByTimeAsync(20_000);
        expect(fetchRemoteChunks).toHaveBeenCalledOnce();
        expect(vi.getTimerCount()).toBe(0);
    });

    it("keeps the next retry scheduled when the earliest queued claim expires", async () => {
        fetcher.options.deliveryStallTimeoutMs = 1_500;
        fetcher.onEvent([firstId]);
        await vi.advanceTimersByTimeAsync(1_001);
        fetcher.options.deliveryStallTimeoutMs = 5_000;
        fetcher.onEvent([secondId]);
        await vi.advanceTimersByTimeAsync(500);
        expect(coordinator.isClaimActiveFor(firstId)).toBe(false);
        expect(coordinator.isClaimActiveFor(secondId)).toBe(true);

        await vi.advanceTimersByTimeAsync(1_501);

        expect(fetchRemoteChunks).toHaveBeenNthCalledWith(3, [secondId], false);
        expect(coordinator.isClaimActiveFor(secondId)).toBe(false);
        expect(collectingChunks.value).toBe(initialCount);
    });
});
