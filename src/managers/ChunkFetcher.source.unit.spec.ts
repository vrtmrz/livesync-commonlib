import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DocumentID, EntryDoc, EntryLeaf } from "@lib/common/types.ts";
import type { IReplicatorService, ISettingService } from "@lib/services/base/IService.ts";
import { ChunkFetcher } from "./ChunkFetcher.ts";
import { ChunkManager } from "./ChunkManager.ts";
import { createDirectChunkFetchSource } from "./chunkFetchSource.ts";

const id = "h:late" as DocumentID;
const chunk: EntryLeaf = { _id: id, type: "leaf", data: "late" };

describe("direct chunk source with the shared fetcher", () => {
    let manager: ChunkManager;
    let fetcher: ChunkFetcher;
    let available: boolean;
    let allDocs: ReturnType<typeof vi.fn>;
    let getActiveReplicator: ReturnType<typeof vi.fn>;
    let write: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        vi.useFakeTimers();
        available = false;
        allDocs = vi.fn(async ({ keys }: { keys: DocumentID[] }) => ({
            rows: keys.map((key) => available
                ? { id: key, key, doc: chunk }
                : { key, error: "not_found" }),
        }));
        const database = { allDocs } as unknown as PouchDB.Database<EntryDoc>;
        const settingService = {
            currentSettings: () => ({
                hashCacheMaxCount: 10,
                concurrencyOfReadChunksOnline: 1,
                minimumIntervalOfReadChunksOnline: 1,
            }),
        } as unknown as ISettingService;
        manager = new ChunkManager({
            database,
            settingService,
            changeManager: { addCallback: () => () => {} } as never,
        });
        write = vi.spyOn(manager, "write");
        getActiveReplicator = vi.fn(() => { throw new Error("Direct reads have no active replicator"); });
        fetcher = new ChunkFetcher({
            chunkManager: manager,
            settingService,
            replicatorService: {
                getActiveReplicator,
                runBoundedRemoteActivity: async (task: () => Promise<void>) => await task(),
            } as unknown as IReplicatorService,
            source: createDirectChunkFetchSource(database),
        });
    });

    afterEach(() => {
        fetcher.destroy();
        manager.destroy();
        vi.clearAllTimers();
        vi.useRealTimers();
    });

    it("delivers a chunk found by the source without writing it back or acquiring a replicator", async () => {
        allDocs.mockImplementationOnce(async () => {
            available = true;
            return { rows: [{ key: id, error: "not_found" }] };
        });
        const pending = manager.read([id], { waitForDelivery: true });
        await vi.advanceTimersByTimeAsync(1);

        await expect(pending).resolves.toEqual([chunk]);
        expect(allDocs).toHaveBeenCalledWith({ keys: [id], include_docs: true });
        expect(getActiveReplicator).not.toHaveBeenCalled();
        expect(write).not.toHaveBeenCalled();
        expect(manager.deliveryCoordinator.isClaimActiveFor(id)).toBe(false);
    });

    it("keeps the original read waiting and recovers a late chunk without an arrival notification", async () => {
        let settled = false;
        const pending = manager.read([id], { waitForDelivery: true }).then((chunks) => {
            settled = true;
            return chunks;
        });
        await vi.advanceTimersByTimeAsync(1);
        expect(settled).toBe(false);
        expect(manager.deliveryCoordinator.isClaimActiveFor(id)).toBe(true);
        available = true;
        await vi.advanceTimersByTimeAsync(1_999);
        expect(settled).toBe(false);
        await vi.advanceTimersByTimeAsync(1);

        await expect(pending).resolves.toEqual([chunk]);
        expect(getActiveReplicator).not.toHaveBeenCalled();
        expect(write).not.toHaveBeenCalled();
        expect(manager.deliveryCoordinator.isClaimActiveFor(id)).toBe(false);
    });

    it("returns a still-missing chunk after the bounded retry so the watcher can retain the file", async () => {
        let settled = false;
        const pending = manager.read([id], { waitForDelivery: true }).then((chunks) => {
            settled = true;
            return chunks;
        });
        await vi.advanceTimersByTimeAsync(1_999);
        expect(settled).toBe(false);
        await vi.advanceTimersByTimeAsync(2);

        await expect(pending).resolves.toEqual([false]);
        expect(manager.deliveryCoordinator.isClaimActiveFor(id)).toBe(false);
        expect(getActiveReplicator).not.toHaveBeenCalled();
        expect(write).not.toHaveBeenCalled();
    });

    it("releases the direct read and cancels its retry when its owners are destroyed", async () => {
        const pending = manager.read([id], { waitForDelivery: true });
        await vi.advanceTimersByTimeAsync(1);
        fetcher.destroy();
        manager.destroy();

        await expect(pending).resolves.toEqual([false]);
        expect(vi.getTimerCount()).toBe(0);
        // Releasing an active claim can finish its availability recheck during teardown.
        // No retry may start after both owners have finished shutting down.
        const readsAfterStop = allDocs.mock.calls.length;
        await vi.advanceTimersByTimeAsync(60_000);
        expect(allDocs).toHaveBeenCalledTimes(readsAfterStop);
        expect(write).not.toHaveBeenCalled();
    });
});
