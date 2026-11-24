import { describe, expect, it, vi } from "vitest";
import type { FileEventItem, FilePath } from "@lib/common/types";
import {
    assertFileEventAdmission,
    assertSuccessfulFileEvents,
    createFileEventAttempt,
    getFileEventPaths,
    isFailedResult,
    isStoppedResult,
    planFileEventAttempts,
    planFileEventPredecessors,
    type OperationResult,
    type PendingFileEvent,
} from "./operations";
import { planFileEventSnapshot } from "./snapshot";
import {
    TYPE_SENTINEL_FLUSH,
    completeFileEventAttempt,
    createStorageEventState,
    hasPendingStorageEvent,
    removePendingEntry,
    retainFileEvent,
} from "./state";

/** Build a retained failure for pure planning tests without scheduling a handler. */
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
        indexedPaths: [event.args.file.path],
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
        const state = createStorageEventState();
        const completed = retainFileEvent(state, first.event);
        completed.operation = first;
        completed.completed = true;
        const sentinel = retainFileEvent(state, { type: TYPE_SENTINEL_FLUSH });
        sentinel.dispatched = true;
        const pending = retainFileEvent(state, newer.event);
        pending.operation = newer;
        const plan = planFileEventSnapshot([completed, sentinel, pending]);
        expect(plan.completed).toEqual([completed, sentinel]);
        expect(plan.snapshot).toEqual([newer.event]);
        expect(sentinel.completed).toBe(false);
        expect(pending.completed).toBe(false);
        expect(newer.attempt.result?.ok).toBe(false);
    });
});

describe("file-event assertions", () => {
    it("accepts an admission with no recorded failure without changing its state", () => {
        const attempt = createFileEventAttempt();
        expect(assertFileEventAdmission(attempt)).toBeUndefined();
        expect(attempt).toMatchObject({ started: false, reconcile: false });
        expect(attempt.result).toBeUndefined();
        expect(attempt.admissionFailure).toBeUndefined();
    });

    it.each([new Error("original failure"), "non-Error rejection", undefined])(
        "rethrows the original admission value without settling or replacing the attempt: %s",
        (error) => {
            const attempt = createFileEventAttempt();
            const failure = { error };
            attempt.admissionFailure = failure;
            const capture = captureThrownValue(() => assertFileEventAdmission(attempt));
            expect(capture).toEqual({ thrown: true, error });
            expect(attempt.admissionFailure).toBe(failure);
            expect(attempt.result).toBeUndefined();
        }
    );

    it.each([[], [{ ok: true }], [{ ok: true }, { ok: true }]] satisfies OperationResult[][])(
        "accepts an empty or wholly successful boundary: %j",
        (...results) => {
            expect(assertSuccessfulFileEvents(results)).toBeUndefined();
        }
    );

    it.each([new Error("first failure"), "non-Error rejection", undefined])(
        "throws the first failure value in input order: %s",
        (error) => {
            const results: OperationResult[] = [
                { ok: true },
                { ok: false, error },
                { ok: false, error: new Error("later") },
            ];
            const before = [...results];
            expect(captureThrownValue(() => assertSuccessfulFileEvents(results))).toEqual({ thrown: true, error });
            expect(results).toEqual(before);
            results.forEach((result, index) => expect(result).toBe(before[index]));
        }
    );

    it("distinguishes succeeded, failed, and stopped operation results", () => {
        const succeeded: OperationResult = { ok: true };
        const failed: OperationResult = { ok: false, error: new Error("boom") };
        const stopped: OperationResult = { ok: false, stopped: true };
        expect(isFailedResult(succeeded)).toBe(false);
        expect(isStoppedResult(succeeded)).toBe(false);
        expect(isFailedResult(failed)).toBe(true);
        expect(isStoppedResult(failed)).toBe(false);
        expect(isFailedResult(stopped)).toBe(false);
        expect(isStoppedResult(stopped)).toBe(true);
    });

    it("deduplicates event paths and keeps path indexes balanced across post-retention mutation", () => {
        const selfRename: FileEventItem = {
            type: "RENAME",
            key: "self-rename",
            args: {
                file: {
                    path: "same.md" as FilePath,
                    name: "same.md",
                    stat: { type: "file", ctime: 1, mtime: 1, size: 1 },
                },
                oldPath: "same.md",
            },
        };
        expect(getFileEventPaths(selfRename)).toEqual(["same.md"]);

        const rename: FileEventItem = {
            type: "RENAME",
            key: "rename",
            args: {
                file: {
                    path: "dst.md" as FilePath,
                    name: "dst.md",
                    stat: { type: "file", ctime: 1, mtime: 1, size: 1 },
                },
                oldPath: "src.md",
            },
        };
        const state = createStorageEventState();
        const entry = retainFileEvent(state, rename);
        const operation = entry.operation!;
        expect(operation.indexedPaths).toEqual(["dst.md", "src.md"]);
        expect(state.latestByPath.get("dst.md")).toBe(operation);
        expect(state.latestByPath.get("src.md")).toBe(operation);
        expect(hasPendingStorageEvent(state, "dst.md" as FilePath)).toBe(true);
        expect(hasPendingStorageEvent(state, "src.md" as FilePath)).toBe(true);

        // Mutating the live event after retention must not leak old path index keys on completion/removal.
        rename.args.file.path = "mutated.md" as FilePath;
        rename.args.oldPath = "mutated-old.md";
        completeFileEventAttempt(state, operation, operation.attempt);
        removePendingEntry(state, entry);
        expect(state.latestByPath.size).toBe(0);
        expect(state.pendingPathCounts.size).toBe(0);
        expect(state.pendingOperationCount).toBe(0);
    });
});

/** Observe arbitrary rejection values, including undefined, without normalising them to Error. */
function captureThrownValue(callback: () => void): { thrown: boolean; error?: unknown } {
    try {
        callback();
        return { thrown: false };
    } catch (error) {
        return { thrown: true, error };
    }
}
