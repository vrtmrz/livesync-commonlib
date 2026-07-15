import { beforeEach, describe, expect, it, vi } from "vitest";
import { reactiveSource } from "octagonal-wheels/dataobject/reactive";
import type { DocumentID, EntryLeaf } from "@lib/common/types";
import { ChunkDeliveryCoordinator, type ChunkDeliveryClaim } from "@lib/managers/ChunkDeliveryCoordinator";
import { ArrivalWaitLayer } from "./ArrivalWaitLayer";

function createMockLeaf(id: string, data: string = `data-${id}`): EntryLeaf {
    return {
        _id: id as DocumentID,
        data,
        type: "leaf",
    } as EntryLeaf;
}

describe("ArrivalWaitLayer", () => {
    let arrivalWaitLayer: ArrivalWaitLayer;
    let eventEmitter: (eventName: string, data: DocumentID[]) => void;

    beforeEach(() => {
        eventEmitter = vi.fn();
        arrivalWaitLayer = new ArrivalWaitLayer(eventEmitter);
    });

    it("initialises without a waiter", () => {
        expect(arrivalWaitLayer.getWaitingCount()).toBe(0);
    });

    it("returns immediately for an empty identifier list", async () => {
        await expect(arrivalWaitLayer.read([], {}, vi.fn())).resolves.toEqual([]);
        expect(eventEmitter).not.toHaveBeenCalled();
    });

    it.each([{ waitForDelivery: false }, { timeout: 0 }, { timeout: -1 }])(
        "returns immediately when delivery waiting is disabled by $waitForDelivery$timeout",
        async (options) => {
            await expect(arrivalWaitLayer.read(["chunk-1" as DocumentID], options, vi.fn())).resolves.toEqual([false]);
            expect(eventEmitter).not.toHaveBeenCalled();
        }
    );

    it.each([{}, { waitForDelivery: true }, { timeout: 1 }, { timeout: 60_000 }])(
        "does not guess an arrival delay when no producer is observable with $timeout",
        async (options) => {
            const id = "chunk-1" as DocumentID;

            await expect(arrivalWaitLayer.read([id], options, vi.fn())).resolves.toEqual([false]);

            expect(eventEmitter).toHaveBeenCalledWith("missingChunks", [id]);
            expect(arrivalWaitLayer.getWaitingCount()).toBe(0);
        }
    );

    it("does not dispatch a remote request when prevented", async () => {
        await expect(
            arrivalWaitLayer.read(
                ["chunk-1" as DocumentID],
                { preventRemoteRequest: true, waitForDelivery: true },
                vi.fn()
            )
        ).resolves.toEqual([false]);

        expect(eventEmitter).not.toHaveBeenCalled();
    });

    it("waits for a synchronously claimed on-demand delivery without a wall-clock deadline", async () => {
        vi.useFakeTimers();
        const coordinator = new ChunkDeliveryCoordinator();
        let claim!: ChunkDeliveryClaim;
        eventEmitter = vi.fn((_event: string, ids: DocumentID[]) => {
            claim = coordinator.claim(ids, { stallTimeoutMs: 0 });
        });
        arrivalWaitLayer.tearDown();
        arrivalWaitLayer = new ArrivalWaitLayer(eventEmitter, coordinator);
        let settled = false;

        const promise = arrivalWaitLayer.read(["chunk-1" as DocumentID], { waitForDelivery: true }, vi.fn());
        void promise.then(() => {
            settled = true;
        });
        await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
        expect(settled).toBe(false);

        claim.release();
        await expect(promise).resolves.toEqual([false]);
        coordinator.dispose();
        vi.useRealTimers();
    });

    it("resolves with a chunk delivered by an active claim", async () => {
        const coordinator = new ChunkDeliveryCoordinator();
        let claim!: ChunkDeliveryClaim;
        eventEmitter = vi.fn((_event: string, ids: DocumentID[]) => {
            claim = coordinator.claim(ids, { stallTimeoutMs: 0 });
        });
        arrivalWaitLayer.tearDown();
        arrivalWaitLayer = new ArrivalWaitLayer(eventEmitter, coordinator);
        const chunk = createMockLeaf("chunk-1");

        const promise = arrivalWaitLayer.read([chunk._id], { waitForDelivery: true }, vi.fn());
        arrivalWaitLayer.onChunkArrived(chunk);

        await expect(promise).resolves.toEqual([chunk]);
        claim.release();
        coordinator.dispose();
    });

    it("resolves explicit remote absence while other activity remains", async () => {
        const coordinator = new ChunkDeliveryCoordinator();
        let claim!: ChunkDeliveryClaim;
        eventEmitter = vi.fn((_event: string, ids: DocumentID[]) => {
            claim = coordinator.claim(ids, { stallTimeoutMs: 0 });
        });
        arrivalWaitLayer.tearDown();
        arrivalWaitLayer = new ArrivalWaitLayer(eventEmitter, coordinator);
        const id = "chunk-1" as DocumentID;

        const promise = arrivalWaitLayer.read([id], { waitForDelivery: true }, vi.fn());
        arrivalWaitLayer.onMissingChunk(id);

        await expect(promise).resolves.toEqual([false]);
        claim.release();
        coordinator.dispose();
    });

    it("treats a deleted chunk arrival as unavailable", async () => {
        const coordinator = new ChunkDeliveryCoordinator();
        let claim!: ChunkDeliveryClaim;
        eventEmitter = vi.fn((_event: string, ids: DocumentID[]) => {
            claim = coordinator.claim(ids, { stallTimeoutMs: 0 });
        });
        arrivalWaitLayer.tearDown();
        arrivalWaitLayer = new ArrivalWaitLayer(eventEmitter, coordinator);
        const chunk = createMockLeaf("chunk-1");

        const promise = arrivalWaitLayer.read([chunk._id], { waitForDelivery: true }, vi.fn());
        arrivalWaitLayer.onChunkArrived(chunk, true);

        await expect(promise).resolves.toEqual([false]);
        claim.release();
        coordinator.dispose();
    });

    it("rechecks local availability when observed finite replication completes", async () => {
        const finiteActivity = reactiveSource(1);
        const coordinator = new ChunkDeliveryCoordinator(finiteActivity);
        const chunk = createMockLeaf("chunk-1");
        const recheckAvailability = vi.fn().mockResolvedValue([chunk]);
        arrivalWaitLayer.tearDown();
        arrivalWaitLayer = new ArrivalWaitLayer(eventEmitter, coordinator, recheckAvailability);

        const promise = arrivalWaitLayer.read(
            [chunk._id],
            { preventRemoteRequest: true, waitForDelivery: true },
            vi.fn()
        );
        finiteActivity.value = 0;

        await expect(promise).resolves.toEqual([chunk]);
        expect(recheckAvailability).toHaveBeenCalledWith([chunk._id]);
        coordinator.dispose();
    });

    it("settles unavailable after a finite producer completes and the local recheck misses", async () => {
        const finiteActivity = reactiveSource(1);
        const coordinator = new ChunkDeliveryCoordinator(finiteActivity);
        const recheckAvailability = vi.fn().mockResolvedValue([false]);
        arrivalWaitLayer.tearDown();
        arrivalWaitLayer = new ArrivalWaitLayer(eventEmitter, coordinator, recheckAvailability);
        const id = "chunk-1" as DocumentID;

        const promise = arrivalWaitLayer.read([id], { preventRemoteRequest: true, waitForDelivery: true }, vi.fn());
        finiteActivity.value = 0;

        await expect(promise).resolves.toEqual([false]);
        expect(recheckAvailability).toHaveBeenCalledWith([id]);
        coordinator.dispose();
    });

    it("discards a stale recheck when finite replication starts again", async () => {
        const finiteActivity = reactiveSource(1);
        const coordinator = new ChunkDeliveryCoordinator(finiteActivity);
        const chunk = createMockLeaf("chunk-1");
        let resolveFirstRecheck!: (value: readonly (EntryLeaf | false)[]) => void;
        const firstRecheck = new Promise<readonly (EntryLeaf | false)[]>((resolve) => {
            resolveFirstRecheck = resolve;
        });
        const recheckAvailability = vi
            .fn()
            .mockImplementationOnce(() => firstRecheck)
            .mockResolvedValueOnce([chunk]);
        arrivalWaitLayer.tearDown();
        arrivalWaitLayer = new ArrivalWaitLayer(eventEmitter, coordinator, recheckAvailability);
        let settled = false;

        const promise = arrivalWaitLayer.read(
            [chunk._id],
            { preventRemoteRequest: true, waitForDelivery: true },
            vi.fn()
        );
        void promise.then(() => {
            settled = true;
        });
        finiteActivity.value = 0;
        await vi.waitFor(() => expect(recheckAvailability).toHaveBeenCalledOnce());

        finiteActivity.value = 1;
        resolveFirstRecheck([false]);
        await Promise.resolve();
        expect(settled).toBe(false);

        finiteActivity.value = 0;
        await expect(promise).resolves.toEqual([chunk]);
        expect(recheckAvailability).toHaveBeenCalledTimes(2);
        coordinator.dispose();
    });

    it("shares one waiter for concurrent reads of the same identifier", async () => {
        const coordinator = new ChunkDeliveryCoordinator();
        let claim: ChunkDeliveryClaim | undefined;
        eventEmitter = vi.fn((_event: string, ids: DocumentID[]) => {
            claim ??= coordinator.claim(ids, { stallTimeoutMs: 0 });
        });
        arrivalWaitLayer.tearDown();
        arrivalWaitLayer = new ArrivalWaitLayer(eventEmitter, coordinator);
        const chunk = createMockLeaf("chunk-1");

        const first = arrivalWaitLayer.read([chunk._id], { waitForDelivery: true }, vi.fn());
        const second = arrivalWaitLayer.read([chunk._id], { waitForDelivery: true }, vi.fn());
        expect(arrivalWaitLayer.getWaitingCount()).toBe(1);

        arrivalWaitLayer.onChunkArrived(chunk);
        await expect(first).resolves.toEqual([chunk]);
        await expect(second).resolves.toEqual([chunk]);
        claim?.release();
        coordinator.dispose();
    });

    it("clears every pending waiter during teardown", async () => {
        const coordinator = new ChunkDeliveryCoordinator();
        let claim!: ChunkDeliveryClaim;
        eventEmitter = vi.fn((_event: string, ids: DocumentID[]) => {
            claim = coordinator.claim(ids, { stallTimeoutMs: 0 });
        });
        arrivalWaitLayer.tearDown();
        arrivalWaitLayer = new ArrivalWaitLayer(eventEmitter, coordinator);

        const promise = arrivalWaitLayer.read(
            ["chunk-1" as DocumentID, "chunk-2" as DocumentID],
            { waitForDelivery: true },
            vi.fn()
        );
        arrivalWaitLayer.clearWaiting();

        await expect(promise).resolves.toEqual([false, false]);
        expect(arrivalWaitLayer.getWaitingCount()).toBe(0);
        claim.release();
        coordinator.dispose();
    });

    it("handles terminal events for identifiers without waiters", () => {
        expect(() => arrivalWaitLayer.onChunkArrived(createMockLeaf("chunk-1"))).not.toThrow();
        expect(() => arrivalWaitLayer.onMissingChunk("chunk-1" as DocumentID)).not.toThrow();
    });
});
