import { describe, it, expect, vi, beforeEach } from "vitest";
import { ArrivalWaitLayer } from "./ArrivalWaitLayer";
import { reactive, reactiveSource } from "octagonal-wheels/dataobject/reactive";
import type { IReplicatorService } from "../../services/base/IService";
import type { DocumentID, EntryLeaf } from "../../common/types";

describe("ArrivalWaitLayer Reactive Timeouts Integration", () => {
    let activeFetchCount: ReturnType<typeof reactiveSource<number>>;
    let isReplicatingActive: ReturnType<typeof reactiveSource<boolean>>;
    let isOnline: ReturnType<typeof reactiveSource<boolean>>;
    let isOnlineActivityActive: ReturnType<typeof reactive<boolean>>;
    let mockReplicatorService: Partial<IReplicatorService>;
    let eventEmitter: any;

    beforeEach(() => {
        activeFetchCount = reactiveSource(0);
        isReplicatingActive = reactiveSource(false);
        isOnline = reactiveSource(true);
        isOnlineActivityActive = reactive(() => {
            if (!isOnline.value) {
                return false;
            }
            return isReplicatingActive.value || activeFetchCount.value > 0;
        });

        mockReplicatorService = {
            activeFetchCount,
            isReplicatingActive,
            isOnlineActivityActive,
        } as any;

        eventEmitter = vi.fn();
    });

    it("should wait and resolve when chunk arrives while online activity is active", async () => {
        activeFetchCount.value = 1; // Mark activity as active

        const waitLayer = new ArrivalWaitLayer(eventEmitter, mockReplicatorService as IReplicatorService);
        const chunkId = "chunk-1" as DocumentID;
        const mockLeaf = { _id: chunkId, type: "leaf", data: "test-data" } as EntryLeaf;

        const readPromise = waitLayer.read([chunkId], { preventRemoteRequest: false }, async () => []);

        // Verify the event emitter was called to fetch the missing chunk
        expect(eventEmitter).toHaveBeenCalledWith("missingChunks", [chunkId]);

        // Simulate chunk arrival
        waitLayer.onChunkArrived(mockLeaf);

        const results = await readPromise;
        expect(results).toEqual([mockLeaf]);

        waitLayer.tearDown();
    });

    it("should fail fast immediately if online activity is inactive when read is requested", async () => {
        isReplicatingActive.value = false;
        activeFetchCount.value = 0; // Online activity is inactive

        const waitLayer = new ArrivalWaitLayer(eventEmitter, mockReplicatorService as IReplicatorService);
        const chunkId = "chunk-1" as DocumentID;

        const results = await waitLayer.read([chunkId], { preventRemoteRequest: false }, async () => []);
        expect(results).toEqual([false]);

        waitLayer.tearDown();
    });

    it("should abort pending wait immediately if online activity transitions from active to inactive", async () => {
        activeFetchCount.value = 1; // Activity starts active

        const waitLayer = new ArrivalWaitLayer(eventEmitter, mockReplicatorService as IReplicatorService);
        const chunkId = "chunk-1" as DocumentID;

        const readPromise = waitLayer.read([chunkId], { preventRemoteRequest: false, timeout: 5000 }, async () => []);

        // Transition activity to inactive (e.g. lost connection / replicator paused)
        activeFetchCount.value = 0;

        const results = await readPromise;
        expect(results).toEqual([false]); // Aborted immediately without waiting for 5-second timeout

        waitLayer.tearDown();
    });

    it("should time out and return false if the chunk does not arrive within the timeout period", async () => {
        activeFetchCount.value = 1; // Activity is active

        const waitLayer = new ArrivalWaitLayer(eventEmitter, mockReplicatorService as IReplicatorService);
        const chunkId = "chunk-1" as DocumentID;

        // Use a short timeout of 50ms for testing
        const readPromise = waitLayer.read([chunkId], { preventRemoteRequest: false, timeout: 50 }, async () => []);

        const results = await readPromise;
        expect(results).toEqual([false]);

        waitLayer.tearDown();
    });
});
