import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

import { observeReplicationProgress } from "./replicationProgress.ts";

function emitter() {
    return new EventEmitter();
}

afterEach(() => vi.useRealTimers());

describe("observeReplicationProgress", () => {
    it("publishes an initial snapshot and coalesces a large checkpoint burst", () => {
        vi.useFakeTimers();
        const source = emitter();
        const controller = new AbortController();
        const publish = vi.fn();
        const observer = observeReplicationProgress(
            source as never,
            "pullOnly",
            "catch-up",
            controller.signal,
            publish
        );

        expect(publish).toHaveBeenCalledWith({
            phase: "catch-up",
            pull: { checkedChanges: 0, completedBatches: 0, checking: false },
        });
        publish.mockClear();

        source.emit("checkpoint", { start_next_batch: 0 });
        for (let index = 0; index < 200; index++) {
            source.emit("checkpoint", {
                revs_diff: { id: "document-" + index, changes: [{ rev: "1-a" }, { rev: "2-b" }] },
            });
        }
        source.emit("checkpoint", { pending_batch: 200 });

        expect(publish).not.toHaveBeenCalled();
        vi.advanceTimersByTime(199);
        expect(publish).not.toHaveBeenCalled();
        vi.advanceTimersByTime(1);

        expect(publish).toHaveBeenCalledTimes(1);
        expect(publish).toHaveBeenLastCalledWith({
            phase: "catch-up",
            pull: { checkedChanges: 200, completedBatches: 0, checking: true },
        });
        expect(vi.getTimerCount()).toBe(0);
        observer.dispose();
    });

    it("counts revision-diff entries once and keeps string and numeric zero sequences", () => {
        vi.useFakeTimers();
        const source = emitter();
        const controller = new AbortController();
        const publish = vi.fn();
        const observer = observeReplicationProgress(
            source as never,
            "pullOnly",
            "one-shot",
            controller.signal,
            publish
        );
        publish.mockClear();

        source.emit("checkpoint", {
            revs_diff: { id: "one-document", changes: [{ rev: "1-a" }, { rev: "2-b" }, { rev: "3-c" }] },
        });
        source.emit("checkpoint", { checkpoint: 0 });
        vi.advanceTimersByTime(200);

        expect(publish).toHaveBeenLastCalledWith({
            phase: "one-shot",
            pull: { checkedChanges: 1, completedBatches: 1, lastSeq: 0, checking: true },
        });

        publish.mockClear();
        source.emit("checkpoint", { checkpoint: "0" });
        vi.advanceTimersByTime(200);

        expect(publish).toHaveBeenLastCalledWith({
            phase: "one-shot",
            pull: { checkedChanges: 1, completedBatches: 2, lastSeq: "0", checking: true },
        });
        observer.dispose();
    });

    it("ignores malformed checkpoint payloads and pending batches", () => {
        vi.useFakeTimers();
        const source = emitter();
        const controller = new AbortController();
        const publish = vi.fn();
        const observer = observeReplicationProgress(
            source as never,
            "pullOnly",
            "one-shot",
            controller.signal,
            publish
        );
        publish.mockClear();

        for (const payload of [
            undefined,
            null,
            {},
            { revs_diff: {} },
            { revs_diff: { id: 4, changes: [{ rev: "1-a" }] } },
            { start_next_batch: Number.NaN },
            { start_next_batch: {} },
            { checkpoint: Number.NaN },
            { checkpoint: Number.POSITIVE_INFINITY },
            { checkpoint: {} },
            { pending_batch: 20 },
        ]) {
            source.emit("checkpoint", payload);
        }

        vi.advanceTimersByTime(200);
        expect(publish).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
        observer.dispose();
    });

    it.each(["change", "paused"] as const)(
        "flushes pending progress at the %s boundary and resumes after pause",
        (boundary) => {
            vi.useFakeTimers();
            const source = emitter();
            const controller = new AbortController();
            const publish = vi.fn();
            const observer = observeReplicationProgress(
                source as never,
                "pullOnly",
                "continuous",
                controller.signal,
                publish
            );
            publish.mockClear();

            source.emit("checkpoint", { start_next_batch: "first" });
            source.emit("checkpoint", { revs_diff: { id: "document", changes: [{ rev: "1-a" }] } });
            source.emit(boundary, {});

            expect(publish).toHaveBeenCalledTimes(1);
            expect(publish).toHaveBeenLastCalledWith({
                phase: "continuous",
                pull: { checkedChanges: 1, completedBatches: 0, checking: false },
            });
            expect(vi.getTimerCount()).toBe(0);

            if (boundary === "paused") {
                publish.mockClear();
                source.emit("checkpoint", { start_next_batch: "resumed" });
                vi.advanceTimersByTime(200);

                expect(publish).toHaveBeenLastCalledWith({
                    phase: "continuous",
                    pull: { checkedChanges: 1, completedBatches: 0, checking: true },
                });
            }
            observer.dispose();
        }
    );

    it.each(["complete", "error", "denied", "abort"] as const)(
        "flushes final progress as idle, releases resources, and ignores late %s callbacks",
        (boundary) => {
            vi.useFakeTimers();
            const source = emitter();
            const controller = new AbortController();
            const publish = vi.fn();
            const observer = observeReplicationProgress(
                source as never,
                "pullOnly",
                "one-shot",
                controller.signal,
                publish
            );
            publish.mockClear();

            source.emit("checkpoint", { start_next_batch: "next" });
            source.emit("checkpoint", { revs_diff: { id: "document", changes: [{ rev: "1-a" }] } });
            const savedCheckpointListener = source.listeners("checkpoint")[0] as (payload?: unknown) => void;

            if (boundary === "abort") controller.abort();
            else if (boundary === "error") source.emit("error", new Error("replication failed"));
            else source.emit(boundary);

            expect(publish).toHaveBeenCalledTimes(1);
            expect(publish).toHaveBeenLastCalledWith({
                phase: "idle",
                pull: { checkedChanges: 1, completedBatches: 0, checking: false },
            });
            expect(vi.getTimerCount()).toBe(0);
            for (const event of ["checkpoint", "change", "paused", "complete", "error", "denied"]) {
                expect(source.listenerCount(event)).toBe(0);
            }

            observer.dispose();
            savedCheckpointListener({ checkpoint: "late" });
            source.emit("checkpoint", { revs_diff: { id: "later", changes: [{ rev: "2-b" }] } });
            vi.advanceTimersByTime(200);

            expect(publish).toHaveBeenCalledTimes(1);
            expect(vi.getTimerCount()).toBe(0);
        }
    );

    it("observes sync pull and push checkpoints independently of the outer emitter", () => {
        vi.useFakeTimers();
        const outer = emitter();
        const pull = emitter();
        const push = emitter();
        const sync = Object.assign(outer, { pull, push });
        const controller = new AbortController();
        const publish = vi.fn();
        const observer = observeReplicationProgress(sync as never, "sync", "continuous", controller.signal, publish);

        expect(publish).toHaveBeenLastCalledWith({
            phase: "continuous",
            pull: { checkedChanges: 0, completedBatches: 0, checking: false },
            push: { checkedChanges: 0, completedBatches: 0, checking: false },
        });
        publish.mockClear();

        outer.emit("checkpoint", { revs_diff: { id: "outer-only", changes: [{ rev: "1-a" }] } });
        pull.emit("checkpoint", { start_next_batch: "pull-start" });
        pull.emit("checkpoint", { revs_diff: { id: "pull-document", changes: [{ rev: "1-a" }] } });
        push.emit("checkpoint", { start_next_batch: "push-start" });
        push.emit("checkpoint", { revs_diff: { id: "push-document", changes: [{ rev: "1-a" }] } });
        push.emit("checkpoint", { checkpoint: 0 });
        vi.advanceTimersByTime(200);

        expect(publish).toHaveBeenCalledTimes(1);
        expect(publish).toHaveBeenLastCalledWith({
            phase: "continuous",
            pull: { checkedChanges: 1, completedBatches: 0, checking: true },
            push: { checkedChanges: 1, completedBatches: 1, lastSeq: 0, checking: true },
        });

        publish.mockClear();
        pull.emit("change", {});
        expect(publish).toHaveBeenCalledTimes(1);
        expect(publish).toHaveBeenLastCalledWith({
            phase: "continuous",
            pull: { checkedChanges: 1, completedBatches: 0, checking: false },
            push: { checkedChanges: 1, completedBatches: 1, lastSeq: 0, checking: true },
        });
        observer.dispose();
    });
});
