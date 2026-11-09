import { describe, expect, it, vi } from "vitest";
import type { FileEventItem, FilePath } from "@lib/common/types";
import {
    createFileEventAttempt,
    planFileEventAttempts,
    planFileEventPredecessors,
    type PendingFileEvent,
} from "./operations";
import { planFileEventSnapshot } from "./snapshot";
import { TYPE_SENTINEL_FLUSH, type PendingSnapshotEntry } from "./state";

function failedOperation(key: string, sequence: number): PendingFileEvent {
    const event: FileEventItem = {
        type: "CHANGED",
        key,
        args: {
            file: {
                path: "note.md" as FilePath,
                name: "note.md",
                stat: { type: "file", ctime: 1, mtime: sequence, size: 1 },
            },
        },
    };
    const attempt = createFileEventAttempt();
    attempt.result = { ok: false, error: new Error(key) };
    attempt.failureSequence = sequence;
    attempt.completion.resolve(attempt.result);
    return {
        event,
        sequence,
        acceptedAt: sequence,
        failureBoundary: sequence,
        attempt,
        initialised: true,
        registered: true,
        predecessors: new Map(),
        prerequisites: new Set(),
        flushRequested: false,
    };
}

describe("StorageEventManager pure plans", () => {
    it("selects retry dependencies without replacing or starting existing ownership", () => {
        const first = failedOperation("first", 1);
        const second = failedOperation("second", 2);
        second.prerequisites.add(first);
        const originals = [first.attempt, second.attempt];
        const plan = planFileEventAttempts([second], 2);
        expect(first.attempt).toBe(originals[0]);
        expect(second.attempt).toBe(originals[1]);
        expect(plan.captured.get(first)).not.toBe(first.attempt);
        expect(plan.retries.get(second)?.prerequisites?.get(first)).toBe(plan.captured.get(first));
        expect([...plan.retries.values()].every((attempt) => !attempt.started && !attempt.result)).toBe(true);
    });

    it("leaves all existing attempts intact if dependency planning throws", () => {
        const first = failedOperation("first", 1);
        const second = failedOperation("second", 2);
        second.prerequisites.add(first);
        const originals = [first.attempt, second.attempt];
        const error = new Error("dependency iteration failed");
        vi.spyOn(second.prerequisites, Symbol.iterator).mockImplementationOnce(() => {
            throw error;
        });
        expect(() => planFileEventAttempts([second], 2)).toThrow(error);
        expect(first.attempt).toBe(originals[0]);
        expect(second.attempt).toBe(originals[1]);
    });

    it("plans batch coalescing without assigning successors or modifying dependencies", () => {
        const first = failedOperation("first", 1);
        first.attempt = createFileEventAttempt();
        const second = failedOperation("second", 2);
        second.event.type = "DELETE";
        second.predecessors.set("note.md", first);
        const plan = planFileEventPredecessors(second, { since: 5, event: first.event });
        expect(plan).toEqual({ since: 5, actions: [{ kind: "coalesce", path: "note.md", previous: first }] });
        expect(first.attempt.successor).toBeUndefined();
        expect(second.prerequisites.size).toBe(0);
    });

    it("selects acknowledged entries and sentinel completion without changing snapshot state", () => {
        const first = failedOperation("first", 1);
        const newer = failedOperation("newer", 3);
        const completed: PendingSnapshotEntry = { event: first.event, sequence: 1, completed: true, operation: first };
        const sentinel: PendingSnapshotEntry = {
            event: { type: TYPE_SENTINEL_FLUSH },
            sequence: 2,
            completed: false,
            dispatched: true,
        };
        const pending: PendingSnapshotEntry = { event: newer.event, sequence: 3, completed: false, operation: newer };
        const plan = planFileEventSnapshot([completed, sentinel, pending]);
        expect(plan.completed).toEqual([completed, sentinel]);
        expect(plan.snapshot).toEqual([newer.event]);
        expect(sentinel.completed).toBe(false);
        expect(pending.completed).toBe(false);
        expect(newer.attempt.result?.ok).toBe(false);
    });
});
