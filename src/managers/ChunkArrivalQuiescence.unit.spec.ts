import { reactiveSource, type ReactiveSource } from "octagonal-wheels/dataobject/reactive";
import { delay } from "octagonal-wheels/promises";
import PouchDB from "pouchdb-core";
import MemoryAdapter from "pouchdb-adapter-memory";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DocumentID, EntryDoc, EntryLeaf } from "@lib/common/types";
import type { IReplicatorService, ISettingService } from "@lib/services/base/IService";
import { ChunkFetcher } from "./ChunkFetcher";
import { LayeredChunkManager } from "./LayeredChunkManager";

PouchDB.plugin(MemoryAdapter);

let databaseSequence = 0;

function createChunk(id: string): EntryLeaf {
    return {
        _id: id,
        data: `data-${id}`,
        type: "leaf",
    } as EntryLeaf;
}

describe("chunk arrival quiescence", () => {
    type FetchRemoteChunks = (missingChunks: string[], showResult: boolean) => Promise<false | EntryLeaf[]>;

    let chunkFetcher: ChunkFetcher;
    let chunkManager: LayeredChunkManager;
    let database: PouchDB.Database<EntryDoc>;
    let fetchRemoteChunks: ReturnType<typeof vi.fn<FetchRemoteChunks>>;
    let getActiveReplicator: ReturnType<typeof vi.fn>;
    let boundedRemoteActivityCount: ReactiveSource<number>;
    let finiteReplicationActivityCount: ReactiveSource<number>;
    let replicatorService: IReplicatorService;
    let settingService: ISettingService;

    beforeEach(() => {
        databaseSequence++;
        database = new PouchDB(`chunk-arrival-quiescence-${databaseSequence}`, { adapter: "memory" });

        settingService = {
            currentSettings: vi.fn(() => ({
                concurrencyOfReadChunksOnline: 1,
                hashCacheMaxCount: 10,
                minimumIntervalOfReadChunksOnline: 1,
            })),
        } as unknown as ISettingService;
        boundedRemoteActivityCount = reactiveSource(0);
        finiteReplicationActivityCount = reactiveSource(0);
        const changeManager = {
            addCallback: vi.fn(() => vi.fn()),
        };
        chunkManager = new LayeredChunkManager({
            changeManager: changeManager as never,
            database,
            finiteReplicationActivity: finiteReplicationActivityCount,
            settingService,
        });

        fetchRemoteChunks = vi.fn<FetchRemoteChunks>();
        getActiveReplicator = vi.fn(() => ({ fetchRemoteChunks }));
        replicatorService = {
            boundedRemoteActivityCount,
            finiteReplicationActivityCount,
            getActiveReplicator,
            runBoundedRemoteActivity: vi.fn(async (task: () => unknown) => {
                boundedRemoteActivityCount.value++;
                try {
                    return await task();
                } finally {
                    boundedRemoteActivityCount.value--;
                }
            }),
        } as unknown as IReplicatorService;
        chunkFetcher = new ChunkFetcher({ chunkManager, replicatorService, settingService });
    });

    afterEach(async () => {
        chunkFetcher.destroy();
        chunkManager.destroy();
        await database.destroy();
    });

    it("waits for an on-demand fetch without imposing an arrival deadline", async () => {
        const chunk = createChunk("chunk-1");
        let resolveFetch!: (chunks: EntryLeaf[]) => void;
        fetchRemoteChunks.mockImplementation(
            () =>
                new Promise<EntryLeaf[]>((resolve) => {
                    resolveFetch = resolve;
                })
        );

        const readPromise = chunkManager.read([chunk._id], { waitForDelivery: true });
        await vi.waitFor(() => expect(fetchRemoteChunks).toHaveBeenCalledOnce());

        await delay(40);
        resolveFetch([chunk]);
        await vi.waitFor(() => expect(fetchRemoteChunks).toHaveBeenCalledOnce());

        await expect(readPromise).resolves.toEqual([expect.objectContaining(chunk)]);
    });

    it("keeps the delivery activity open through local persistence", async () => {
        const chunk = createChunk("chunk-1");
        let resolveWrite!: () => void;
        const writeGate = new Promise<void>((resolve) => {
            resolveWrite = resolve;
        });
        const originalWrite = chunkManager.write.bind(chunkManager);
        const write = vi.spyOn(chunkManager, "write").mockImplementation(async (...args) => {
            await writeGate;
            return await originalWrite(...args);
        });
        fetchRemoteChunks.mockResolvedValue([chunk]);
        let settled = false;

        const readPromise = chunkManager.read([chunk._id], { waitForDelivery: true });
        void readPromise.then(() => {
            settled = true;
        });
        await vi.waitFor(() => expect(write).toHaveBeenCalledOnce());
        await delay(40);

        expect(settled).toBe(false);
        expect(boundedRemoteActivityCount.value).toBe(1);

        resolveWrite();
        await expect(readPromise).resolves.toEqual([chunk]);
        await vi.waitFor(() => expect(boundedRemoteActivityCount.value).toBe(0));
    });

    it("rechecks local chunks when finite replication reaches its latest sequence", async () => {
        const chunk = createChunk("chunk-1");
        finiteReplicationActivityCount.value = 1;
        let settled = false;

        const readPromise = chunkManager.read([chunk._id], {
            preventRemoteRequest: true,
            waitForDelivery: true,
        });
        void readPromise.then(() => {
            settled = true;
        });
        await delay(40);
        expect(settled).toBe(false);

        await database.put(chunk);
        finiteReplicationActivityCount.value = 0;

        await expect(readPromise).resolves.toEqual([expect.objectContaining(chunk)]);
    });

    it("settles after a failed fetch claim completes", async () => {
        fetchRemoteChunks.mockRejectedValue(new Error("network failed"));

        const result = await chunkManager.read(["chunk-1" as DocumentID], { waitForDelivery: true });

        expect(result).toEqual([false]);
        await vi.waitFor(() => expect(boundedRemoteActivityCount.value).toBe(0));
    });

    it("releases a claim when no active replicator can service it", async () => {
        getActiveReplicator.mockReturnValue(undefined);

        const result = await chunkManager.read(["chunk-1" as DocumentID], { waitForDelivery: true });

        expect(result).toEqual([false]);
        await vi.waitFor(() => expect(boundedRemoteActivityCount.value).toBe(0));
    });

    it("uses an inactivity watchdog to release a fetch which never settles", async () => {
        chunkFetcher.destroy();
        chunkFetcher = new ChunkFetcher({
            chunkManager,
            deliveryStallTimeoutMs: 20,
            replicatorService,
            settingService,
        });
        fetchRemoteChunks.mockImplementation(() => new Promise<EntryLeaf[]>(() => undefined));

        const result = await chunkManager.read(["chunk-1" as DocumentID], { waitForDelivery: true });

        expect(result).toEqual([false]);
        await vi.waitFor(() => expect(boundedRemoteActivityCount.value).toBe(0));
    });
});
