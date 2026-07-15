import { reactiveSource } from "octagonal-wheels/dataobject/reactive";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DocumentID } from "@lib/common/types";
import { ChunkDeliveryCoordinator } from "./ChunkDeliveryCoordinator";

describe("ChunkDeliveryCoordinator", () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it("tracks and settles each identifier owned by a claim", async () => {
        const coordinator = new ChunkDeliveryCoordinator();
        const first = "chunk-1" as DocumentID;
        const second = "chunk-2" as DocumentID;
        const claim = coordinator.claim([first, second], { stallTimeoutMs: 0 });

        expect(coordinator.isActivityActiveFor(first)).toBe(true);
        expect(coordinator.isActivityActiveFor(second)).toBe(true);

        claim.settle(first);
        expect(coordinator.isActivityActiveFor(first)).toBe(false);
        expect(coordinator.isActivityActiveFor(second)).toBe(true);

        claim.settle(second);
        await expect(claim.done).resolves.toBeUndefined();
        expect(coordinator.isActivityActiveFor(second)).toBe(false);
        coordinator.dispose();
    });

    it("settles an empty claim immediately", async () => {
        const coordinator = new ChunkDeliveryCoordinator();
        const claim = coordinator.claim([]);

        await expect(claim.done).resolves.toBeUndefined();
        coordinator.dispose();
    });

    it("keeps an identifier active until every overlapping claim settles", () => {
        const coordinator = new ChunkDeliveryCoordinator();
        const id = "chunk-1" as DocumentID;
        const first = coordinator.claim([id], { stallTimeoutMs: 0 });
        const second = coordinator.claim([id], { stallTimeoutMs: 0 });

        first.release();
        expect(coordinator.isActivityActiveFor(id)).toBe(true);

        second.release();
        expect(coordinator.isActivityActiveFor(id)).toBe(false);
        coordinator.dispose();
    });

    it("uses finite replication as a delivery gate", () => {
        const finiteActivity = reactiveSource(0);
        const coordinator = new ChunkDeliveryCoordinator(finiteActivity);
        const changed = vi.fn();
        coordinator.onChanged(changed);

        finiteActivity.value = 1;
        expect(coordinator.isActivityActiveFor("chunk-1" as DocumentID)).toBe(true);

        finiteActivity.value = 2;
        finiteActivity.value = 1;

        finiteActivity.value = 0;
        expect(coordinator.isActivityActiveFor("chunk-1" as DocumentID)).toBe(false);
        expect(changed).toHaveBeenCalledTimes(2);
        coordinator.dispose();
    });

    it("releases a stalled claim and resets its inactivity watchdog on progress", async () => {
        vi.useFakeTimers();
        const coordinator = new ChunkDeliveryCoordinator();
        const onStalled = vi.fn();
        const id = "chunk-1" as DocumentID;
        const claim = coordinator.claim([id], { onStalled, stallTimeoutMs: 100 });

        await vi.advanceTimersByTimeAsync(75);
        claim.touch();
        await vi.advanceTimersByTimeAsync(75);
        expect(coordinator.isActivityActiveFor(id)).toBe(true);

        await vi.advanceTimersByTimeAsync(25);
        await expect(claim.done).resolves.toBeUndefined();
        expect(coordinator.isActivityActiveFor(id)).toBe(false);
        expect(onStalled).toHaveBeenCalledWith([id]);
        coordinator.dispose();
    });

    it("uses five minutes only as the default last-resort leak fuse", async () => {
        vi.useFakeTimers();
        const coordinator = new ChunkDeliveryCoordinator();
        const id = "chunk-1" as DocumentID;
        const claim = coordinator.claim([id]);

        await vi.advanceTimersByTimeAsync(5 * 60 * 1000 - 1);
        expect(coordinator.isActivityActiveFor(id)).toBe(true);

        await vi.advanceTimersByTimeAsync(1);
        await expect(claim.done).resolves.toBeUndefined();
        expect(coordinator.isActivityActiveFor(id)).toBe(false);
        coordinator.dispose();
    });

    it("releases every claim when disposed", async () => {
        const coordinator = new ChunkDeliveryCoordinator();
        const claim = coordinator.claim(["chunk-1" as DocumentID], { stallTimeoutMs: 0 });

        coordinator.dispose();

        await expect(claim.done).resolves.toBeUndefined();
    });
});
