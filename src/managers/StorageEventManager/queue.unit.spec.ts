import { describe, expect, it, vi } from "vitest";
import { promiseWithResolvers } from "octagonal-wheels/promises";
import type { FileEventItem, FilePath } from "@lib/common/types";
import {
    enqueueStorageEvent,
    flushStorageEvents,
    publishCommittedStorageEvents,
    runBufferedStorageEvents,
    type StorageEventQueueEffects,
} from "./queue";
import { appendPendingEventBuffer } from "./snapshot";
import {
    TYPE_SENTINEL_FLUSH,
    createStorageEventState,
    retainFileEvent,
    type EventAdmission,
    type QueuedFileEvent,
    type StorageEventState,
} from "./state";
import { createFileEventAttempt, type FileEventAttempt, type PendingFileEvent } from "./operations";

/** Supply a retained event and minimal host effects while leaving queue selection and dispatch real. */
function fixture() {
    const state = createStorageEventState();
    const event: FileEventItem = {
        type: "CHANGED",
        key: "finite-boundary",
        args: {
            file: { name: "note.md", path: "note.md" as FilePath, stat: { ctime: 1, mtime: 2, size: 3, type: "file" } },
        },
    };
    const operation = retainFileEvent(state, event).operation!;
    let events: QueuedFileEvent[] = [];
    const effects: StorageEventQueueEffects = {
        buffer: {
            read: () => events,
            replace: (next) => {
                events = next;
            },
            append: (event) => {
                events.push(event);
            },
            peek: () => events[0],
            takeHead: (expected) => {
                if (events[0] !== expected) {
                    return false;
                }
                events.shift();
                return true;
            },
        },
        log: vi.fn(),
        takeSnapshot: vi.fn(async () => {}),
        loadSnapshot: vi.fn(async () => []),
        processFileEvent: vi.fn(async () => {}),
        runQueuedEvents: vi.fn(async () => {}),
        capture: vi.fn((ops: readonly PendingFileEvent[]) => new Map(ops.map((op) => [op, op.attempt]))),
        release: vi.fn(),
        wait: vi.fn(async () => []),
        fail: vi.fn(),
        updateStatus: vi.fn(),
        reportFailure: vi.fn(),
    };
    return { state, event, operation, effects };
}

/** Register a real asynchronous host admission and expose its finite set of attempt ownership. */
function admission(state: StorageEventState, operations: Map<PendingFileEvent, FileEventAttempt>) {
    const completion = promiseWithResolvers<void>();
    const record: EventAdmission = {
        acceptedAt: 1,
        failureBoundary: 0,
        flushRequested: false,
        completion: completion.promise,
        operations,
    };
    state.admissions.add(record);
    return { record, completion };
}

describe("ordered queue dispatch", () => {
    it("does not expose an ordered sentinel to a dispatcher while the append is in flight", async () => {
        const { effects, event } = fixture();
        const appendStarted = promiseWithResolvers<void>();
        const appendCommitted = promiseWithResolvers<string>();
        const state = createStorageEventState({
            load: vi.fn(),
            append: vi.fn(() => {
                appendStarted.resolve();
                return appendCommitted.promise;
            }),
            remove: vi.fn(),
        });
        effects.takeSnapshot = () =>
            appendPendingEventBuffer(state, state.ordered!, {
                publish: (events) => publishCommittedStorageEvents(state, events, effects),
                reportAppendFailure: vi.fn(),
            });
        effects.runQueuedEvents = () => runBufferedStorageEvents(state, effects);
        effects.acknowledgeSentinel = vi.fn(async () => {});

        const removed: FileEventItem = { ...event, type: "DELETE" };
        enqueueStorageEvent(state, removed, effects);
        await appendStarted.promise;
        const writing = effects.takeSnapshot();
        try {
            await effects.runQueuedEvents();
            expect(effects.buffer.read()).toEqual([]);
            expect(effects.acknowledgeSentinel).not.toHaveBeenCalled();
            expect(effects.processFileEvent).not.toHaveBeenCalled();
        } finally {
            appendCommitted.resolve("committed-buffer");
            await writing;
        }

        await effects.runQueuedEvents();
        expect(effects.acknowledgeSentinel).toHaveBeenCalledExactlyOnceWith(
            expect.objectContaining({
                event: { type: TYPE_SENTINEL_FLUSH },
                savedBuffer: { key: "committed-buffer", remaining: 2 },
            })
        );
        expect(effects.processFileEvent).toHaveBeenCalledExactlyOnceWith(removed);
        expect(effects.buffer.read()).toEqual([]);
    });
});

describe("exported queue completion boundaries", () => {
    it("retains the originally captured attempt when an in-flight admission reports a replacement", async () => {
        const f = fixture();
        const original = f.operation.attempt;
        const a = admission(f.state, new Map());
        const flushed = flushStorageEvents(f.state, f.effects);
        const replacement = createFileEventAttempt(true);
        f.operation.attempt = replacement;
        a.record.operations.set(f.operation, replacement);
        a.completion.resolve();
        await flushed;
        expect(a.record.flushRequested).toBe(true);
        expect(f.effects.wait).toHaveBeenCalledWith(new Map([[f.operation, original]]));
        expect(f.operation.attempt).toBe(replacement);
    });

    it("reports the admission failure before a captured operation failure", async () => {
        const f = fixture();
        const a = admission(f.state, new Map());
        const error = new Error("admission failed");
        f.effects.wait = vi.fn(async () => [{ ok: false as const, error: new Error("handler failed") }]);
        const flushed = flushStorageEvents(f.state, f.effects);
        const rejected = expect(flushed).rejects.toBe(error);
        a.completion.reject(error);
        await rejected;
        expect(f.effects.wait).toHaveBeenCalledOnce();
        expect(f.state.pendingSnapshot.has(f.event)).toBe(true);
    });

    it("reports failed buffered results and resolves rather than rejecting or acknowledging them", async () => {
        const f = fixture();
        const error = new Error("retained handler failure");
        f.effects.wait = vi.fn(async () => [{ ok: true as const }, { ok: false as const, error }]);
        await expect(
            runBufferedStorageEvents(f.state, f.effects, { waitForProcessing: true })
        ).resolves.toBeUndefined();
        expect(f.effects.reportFailure).toHaveBeenCalledExactlyOnceWith(error);
        expect(f.effects.wait).toHaveBeenCalledWith(new Map([[f.operation, f.operation.attempt]]));
        expect(f.state.pendingSnapshot.get(f.event)?.completed).toBe(false);
    });
});
