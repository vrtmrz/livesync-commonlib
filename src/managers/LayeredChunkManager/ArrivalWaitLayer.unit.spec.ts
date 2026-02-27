import { describe, it, expect, beforeEach, vi } from "vitest";
import { ArrivalWaitLayer } from "./ArrivalWaitLayer";
import type { DocumentID, EntryLeaf } from "@lib/common/types";

function createMockLeaf(id: string, data: string = `data-${id}`): EntryLeaf {
    return {
        _id: id as DocumentID,
        type: "leaf" as any,
        data: data,
    } as EntryLeaf;
}

describe("ArrivalWaitLayer", () => {
    let arrivalWaitLayer: ArrivalWaitLayer;
    let eventEmitter: (eventName: string, data: DocumentID[]) => void;

    beforeEach(() => {
        eventEmitter = vi.fn();
        arrivalWaitLayer = new ArrivalWaitLayer(eventEmitter);
    });

    it("should initialise with event emitter", () => {
        expect(arrivalWaitLayer).toBeDefined();
        expect(arrivalWaitLayer.getWaitingCount()).toBe(0);
    });

    it("should return false for empty ids array", async () => {
        const nextFn = vi.fn();
        const result = await arrivalWaitLayer.read([], {}, nextFn);

        expect(result).toEqual([]);
        expect(eventEmitter).not.toHaveBeenCalled();
        expect(nextFn).not.toHaveBeenCalled();
    });

    it("should return false immediately when timeout is 0", async () => {
        const ids = ["chunk-1" as DocumentID, "chunk-2" as DocumentID];
        const nextFn = vi.fn();

        const result = await arrivalWaitLayer.read(ids, { timeout: 0 }, nextFn);

        expect(result).toEqual([false, false]);
        expect(eventEmitter).not.toHaveBeenCalled();
        expect(nextFn).not.toHaveBeenCalled();
    });

    it("should return false immediately when timeout is negative", async () => {
        const ids = ["chunk-1" as DocumentID];
        const nextFn = vi.fn();

        const result = await arrivalWaitLayer.read(ids, { timeout: -1 }, nextFn);

        expect(result).toEqual([false]);
        expect(eventEmitter).not.toHaveBeenCalled();
    });

    it("should emit missingChunks event when preventRemoteRequest is not set", async () => {
        const ids = ["chunk-1" as DocumentID, "chunk-2" as DocumentID];
        const nextFn = vi.fn();

        // Start waiting (do not await yet)
        const promise = arrivalWaitLayer.read(ids, { timeout: 100 }, nextFn);

        // Event should be emitted immediately
        expect(eventEmitter).toHaveBeenCalledWith("missingChunks", ids);

        // Clean up
        await promise;
    });

    it("should not emit missingChunks event when preventRemoteRequest is true", async () => {
        const ids = ["chunk-1" as DocumentID];
        const nextFn = vi.fn();

        const promise = arrivalWaitLayer.read(ids, { timeout: 100, preventRemoteRequest: true }, nextFn);

        expect(eventEmitter).not.toHaveBeenCalled();

        // Clean up
        await promise;
    });

    it("should resolve with chunk when onChunkArrived is called", async () => {
        const ids = ["chunk-1" as DocumentID];
        const chunk = createMockLeaf("chunk-1");
        const nextFn = vi.fn();

        const promise = arrivalWaitLayer.read(ids, { timeout: 5000 }, nextFn);

        // Simulate chunk arrival
        arrivalWaitLayer.onChunkArrived(chunk);

        const result = await promise;

        expect(result).toEqual([chunk]);
        expect(arrivalWaitLayer.getWaitingCount()).toBe(0);
    });

    it("should resolve with false when onChunkArrived is called with deleted chunk", async () => {
        const ids = ["chunk-1" as DocumentID];
        const chunk = {
            ...createMockLeaf("chunk-1"),
            _deleted: true,
        };
        const nextFn = vi.fn();

        const promise = arrivalWaitLayer.read(ids, { timeout: 5000 }, nextFn);

        // Simulate deleted chunk arrival
        arrivalWaitLayer.onChunkArrived(chunk as EntryLeaf);

        const result = await promise;

        expect(result).toEqual([false]);
        expect(arrivalWaitLayer.getWaitingCount()).toBe(0);
    });

    it("should resolve with false when onChunkArrived is called with deleted=true parameter", async () => {
        const ids = ["chunk-1" as DocumentID];
        const chunk = createMockLeaf("chunk-1");
        const nextFn = vi.fn();

        const promise = arrivalWaitLayer.read(ids, { timeout: 5000 }, nextFn);

        // Simulate chunk arrival with deleted parameter
        arrivalWaitLayer.onChunkArrived(chunk, true);

        const result = await promise;

        expect(result).toEqual([false]);
        expect(arrivalWaitLayer.getWaitingCount()).toBe(0);
    });

    it("should resolve with false when onMissingChunk is called", async () => {
        const ids = ["chunk-1" as DocumentID];
        const nextFn = vi.fn();

        const promise = arrivalWaitLayer.read(ids, { timeout: 5000 }, nextFn);

        // Simulate missing chunk notification
        arrivalWaitLayer.onMissingChunk("chunk-1" as DocumentID);

        const result = await promise;

        expect(result).toEqual([false]);
        expect(arrivalWaitLayer.getWaitingCount()).toBe(0);
    });

    it("should timeout and return false after default timeout", async () => {
        const ids = ["chunk-1" as DocumentID];
        const nextFn = vi.fn();

        const startTime = Date.now();
        const result = await arrivalWaitLayer.read(ids, { timeout: 100 }, nextFn);
        const elapsed = Date.now() - startTime;

        expect(result).toEqual([false]);
        expect(elapsed).toBeGreaterThanOrEqual(100);
        expect(elapsed).toBeLessThan(200); // Should not be too much longer
        expect(arrivalWaitLayer.getWaitingCount()).toBe(0);
    });

    it("should handle multiple chunks waiting simultaneously", async () => {
        const ids = ["chunk-1" as DocumentID, "chunk-2" as DocumentID, "chunk-3" as DocumentID];
        const chunk1 = createMockLeaf("chunk-1");
        const chunk3 = createMockLeaf("chunk-3");
        const nextFn = vi.fn();

        const promise = arrivalWaitLayer.read(ids, { timeout: 5000 }, nextFn);

        // Check waiting count
        expect(arrivalWaitLayer.getWaitingCount()).toBe(3);

        // Resolve chunk-1 and chunk-3, let chunk-2 time out
        arrivalWaitLayer.onChunkArrived(chunk1);
        arrivalWaitLayer.onMissingChunk("chunk-2" as DocumentID);
        arrivalWaitLayer.onChunkArrived(chunk3);

        const result = await promise;

        expect(result).toEqual([chunk1, false, chunk3]);
        expect(arrivalWaitLayer.getWaitingCount()).toBe(0);
    });

    it("should reuse existing promise for duplicate id requests", async () => {
        const id = "chunk-1" as DocumentID;
        const chunk = createMockLeaf("chunk-1");
        const nextFn = vi.fn();

        // Start first request
        const promise1 = arrivalWaitLayer.read([id], { timeout: 5000 }, nextFn);
        expect(arrivalWaitLayer.getWaitingCount()).toBe(1);

        // Start second request for the same id
        const promise2 = arrivalWaitLayer.read([id], { timeout: 5000 }, nextFn);
        expect(arrivalWaitLayer.getWaitingCount()).toBe(1); // Should still be 1

        // Resolve the chunk
        arrivalWaitLayer.onChunkArrived(chunk);

        const result1 = await promise1;
        const result2 = await promise2;

        expect(result1).toEqual([chunk]);
        expect(result2).toEqual([chunk]);
        expect(arrivalWaitLayer.getWaitingCount()).toBe(0);
    });

    it("should clear all waiting requests", async () => {
        const ids = ["chunk-1" as DocumentID, "chunk-2" as DocumentID];
        const nextFn = vi.fn();

        // Start waiting with long timeout
        const promise = arrivalWaitLayer.read(ids, { timeout: 5000 }, nextFn);

        expect(arrivalWaitLayer.getWaitingCount()).toBe(2);

        // Clear waiting - should resolve all promises immediately
        arrivalWaitLayer.clearWaiting();

        expect(arrivalWaitLayer.getWaitingCount()).toBe(0);

        // The promises should resolve immediately with false
        const result = await promise;
        expect(result).toEqual([false, false]);
    });

    it("should handle onChunkArrived for non-waiting chunk gracefully", () => {
        const chunk = createMockLeaf("chunk-1");

        // Call onChunkArrived without any waiting request
        expect(() => {
            arrivalWaitLayer.onChunkArrived(chunk);
        }).not.toThrow();

        expect(arrivalWaitLayer.getWaitingCount()).toBe(0);
    });

    it("should handle onMissingChunk for non-waiting chunk gracefully", () => {
        // Call onMissingChunk without any waiting request
        expect(() => {
            arrivalWaitLayer.onMissingChunk("chunk-1" as DocumentID);
        }).not.toThrow();

        expect(arrivalWaitLayer.getWaitingCount()).toBe(0);
    });

    it("should use default timeout when timeout option is not provided", async () => {
        const ids = ["chunk-1" as DocumentID];
        const nextFn = vi.fn();

        // Start waiting without timeout option (should use default 15000ms)
        const promise = arrivalWaitLayer.read(ids, {}, nextFn);

        expect(arrivalWaitLayer.getWaitingCount()).toBe(1);

        // Resolve immediately to avoid waiting for default timeout
        arrivalWaitLayer.onMissingChunk("chunk-1" as DocumentID);

        const result = await promise;
        expect(result).toEqual([false]);
    });

    it("should handle chunk arrival before read completion", async () => {
        const ids = ["chunk-1" as DocumentID];
        const chunk = createMockLeaf("chunk-1");
        const nextFn = vi.fn();

        const promise = arrivalWaitLayer.read(ids, { timeout: 5000 }, nextFn);

        // Arrive chunk almost immediately
        setTimeout(() => {
            arrivalWaitLayer.onChunkArrived(chunk);
        }, 10);

        const result = await promise;

        expect(result).toEqual([chunk]);
    });

    it("should maintain correct waiting count during concurrent operations", async () => {
        const nextFn = vi.fn();

        expect(arrivalWaitLayer.getWaitingCount()).toBe(0);

        // Start first request
        const promise1 = arrivalWaitLayer.read(["chunk-1" as DocumentID], { timeout: 5000 }, nextFn);
        expect(arrivalWaitLayer.getWaitingCount()).toBe(1);

        // Start second request
        const promise2 = arrivalWaitLayer.read(["chunk-2" as DocumentID], { timeout: 5000 }, nextFn);
        expect(arrivalWaitLayer.getWaitingCount()).toBe(2);

        // Resolve first
        arrivalWaitLayer.onMissingChunk("chunk-1" as DocumentID);
        await promise1;
        expect(arrivalWaitLayer.getWaitingCount()).toBe(1);

        // Resolve second
        arrivalWaitLayer.onMissingChunk("chunk-2" as DocumentID);
        await promise2;
        expect(arrivalWaitLayer.getWaitingCount()).toBe(0);
    });

    it("should handle timeout cleanup correctly", async () => {
        const ids = ["chunk-1" as DocumentID];
        const chunk = createMockLeaf("chunk-1");
        const nextFn = vi.fn();

        // Set a timeout and resolve before it expires
        const promise = arrivalWaitLayer.read(ids, { timeout: 1000 }, nextFn);

        // Resolve immediately
        arrivalWaitLayer.onChunkArrived(chunk);

        const result = await promise;

        expect(result).toEqual([chunk]);

        // Wait a bit to ensure timeout was cleared
        await new Promise((resolve) => setTimeout(resolve, 100));

        // Waiting count should still be 0
        expect(arrivalWaitLayer.getWaitingCount()).toBe(0);
    });
});
