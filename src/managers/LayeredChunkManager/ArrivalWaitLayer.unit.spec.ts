import { ContentReadError } from "@lib/common/LSError.ts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { reactiveSource } from "octagonal-wheels/dataobject/reactive";
import type { DocumentID, EntryLeaf } from "@lib/common/types";
import { RemoteRequestError } from "@lib/common/LSError.ts";
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

    it("reports an immediate unavailable result when delivery waiting is disabled", async () => {
        const id = "chunk-1" as DocumentID;

        await expect(arrivalWaitLayer.read([id], { waitForDelivery: false }, vi.fn())).resolves.toEqual([
            false,
        ]);

    });

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

    it("waits for producer completion before accepting explicit remote absence", async () => {
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

        claim.release();
        await expect(promise).resolves.toEqual([false]);
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

        claim.release();
        await expect(promise).resolves.toEqual([false]);
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

    it("waits for an alternative finite producer after an on-demand transport failure", async () => {
        const finiteActivity = reactiveSource(1);
        const coordinator = new ChunkDeliveryCoordinator(finiteActivity);
        const chunk = createMockLeaf("chunk-1");
        const recheckAvailability = vi.fn().mockResolvedValue([chunk]);
        let claim!: ChunkDeliveryClaim;
        eventEmitter = vi.fn((_event: string, ids: DocumentID[]) => {
            claim = coordinator.claim(ids, { stallTimeoutMs: 0 });
        });
        arrivalWaitLayer.tearDown();
        arrivalWaitLayer = new ArrivalWaitLayer(eventEmitter, coordinator, recheckAvailability);
        let settled = false;

        const pending = arrivalWaitLayer.read(
            [chunk._id],
            { waitForDelivery: true },
            vi.fn()
        );
        void pending.then(() => {
            settled = true;
        });
        arrivalWaitLayer.onChunkFailed(chunk._id, { resources: ["remote"], cause: new Error("remote fetch failed") });
        claim.release();
        await Promise.resolve();
        expect(settled).toBe(false);

        finiteActivity.value = 0;
        await expect(pending).resolves.toEqual([chunk]);
        expect(recheckAvailability).toHaveBeenCalledWith([chunk._id]);
        coordinator.dispose();
    });

    it("notifies every concurrent read after producers finish without the chunk", async () => {
        const finiteActivity = reactiveSource(1);
        const coordinator = new ChunkDeliveryCoordinator(finiteActivity);
        const id = "chunk-1" as DocumentID;
        const recheckAvailability = vi.fn().mockResolvedValue([false]);
        let claim!: ChunkDeliveryClaim;
        eventEmitter = vi.fn((_event: string, ids: DocumentID[]) => {
            claim ??= coordinator.claim(ids, { stallTimeoutMs: 0 });
        });
        arrivalWaitLayer.tearDown();
        arrivalWaitLayer = new ArrivalWaitLayer(eventEmitter, coordinator, recheckAvailability);

        const first = arrivalWaitLayer.read([id], { waitForDelivery: true }, vi.fn());
        const second = arrivalWaitLayer.read([id], { waitForDelivery: true }, vi.fn());
        arrivalWaitLayer.onChunkFailed(id, { resources: ["remote"], cause: new Error("remote fetch failed") });
        claim.release();
        finiteActivity.value = 0;

        const results = await Promise.allSettled([first, second]);
        expect(results).toEqual([expect.objectContaining({ status: "rejected", reason: expect.any(ContentReadError) }), expect.objectContaining({ status: "rejected", reason: expect.any(ContentReadError) })]);
        coordinator.dispose();
    });

    it("forwards the typed failure cause when an awaited chunk remains unavailable", async () => {
        const finiteActivity = reactiveSource(1);
        const coordinator = new ChunkDeliveryCoordinator(finiteActivity);
        const id = "chunk-typed-failure" as DocumentID;
        const recheckAvailability = vi.fn().mockResolvedValue([false]);
        let claim!: ChunkDeliveryClaim;
        eventEmitter = vi.fn((_event: string, ids: DocumentID[]) => {
            claim = coordinator.claim(ids, { stallTimeoutMs: 0 });
        });
        arrivalWaitLayer.tearDown();
        arrivalWaitLayer = new ArrivalWaitLayer(eventEmitter, coordinator, recheckAvailability);
        const cause = new RemoteRequestError("Remote request failed", { cause: new TypeError("network fetch failed") });

        const pending = arrivalWaitLayer.read([id], { waitForDelivery: true }, vi.fn());
        arrivalWaitLayer.onChunkFailed(id, { resources: ["remote"], cause });
        claim.release();
        finiteActivity.value = 0;

        await expect(pending).rejects.toMatchObject({ failure: { resources: ["remote"], cause } });
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
    it("retains both a remote failure and the failed final local recheck", async () => {
        const coordinator = new ChunkDeliveryCoordinator();
        const id = "h:both-failed" as DocumentID;
        const remote = new Error("remote request failed");
        const local = { name: "arbitrary local failure" };
        let claim!: ChunkDeliveryClaim;
        arrivalWaitLayer.tearDown();
        arrivalWaitLayer = new ArrivalWaitLayer((_event, ids) => {
            claim = coordinator.claim(ids, { stallTimeoutMs: 0 });
        }, coordinator, async () => { throw local; });
        const result = arrivalWaitLayer.read([id], { waitForDelivery: true }, vi.fn());
        arrivalWaitLayer.onChunkFailed(id, { resources: ["remote"], cause: remote });
        claim.release();
        await expect(result).rejects.toMatchObject({ failure: { resources: expect.arrayContaining(["remote", "local-database"]) } });
        expect(arrivalWaitLayer.getWaitingCount()).toBe(0);
        coordinator.dispose();
    });

    it("requires manual review when a remote failure is mixed with invalid content", async () => {
        const coordinator = new ChunkDeliveryCoordinator();
        const ids = ["h:remote", "h:invalid"] as DocumentID[];
        const remote = new Error("request failed");
        const invalid = { detail: "invalid content" };
        let claim!: ChunkDeliveryClaim;
        arrivalWaitLayer.tearDown();
        arrivalWaitLayer = new ArrivalWaitLayer((_event, requested) => {
            claim = coordinator.claim(requested, { stallTimeoutMs: 0 });
        }, coordinator, async () => [false, false]);
        const result = arrivalWaitLayer.read(ids, { waitForDelivery: true }, vi.fn());
        arrivalWaitLayer.onChunkFailed(ids[0], { resources: ["remote"], cause: remote });
        arrivalWaitLayer.onChunkFailed(ids[1], { resources: [], cause: invalid });
        claim.release();
        const error = await result.catch((failure: unknown) => failure);
        expect(error).toMatchObject({ failure: { resources: [] } });
        const aggregate = (error as ContentReadError).failure.cause as AggregateError;
        expect(aggregate.errors.map((failure: ContentReadError) => failure.failure.cause)).toEqual([remote, invalid]);
        coordinator.dispose();
    });

});
