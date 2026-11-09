import { describe, expect, it, vi } from "vitest";
import { promiseWithResolvers } from "octagonal-wheels/promises";
import type { FileEventItem, FilePath } from "@lib/common/types";
import { flushStorageEvents, runBufferedStorageEvents, type StorageEventQueueEffects } from "./queue";
import { createStorageEventState, retainFileEvent, type EventAdmission, type StorageEventState } from "./state";
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
    const effects: StorageEventQueueEffects = {
        buffer: { read: () => [], replace: vi.fn(), append: vi.fn(), shift: () => undefined },
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
