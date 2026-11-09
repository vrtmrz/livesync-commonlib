import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, type FileEventItem, type FilePath } from "@lib/common/types";
import type { FileEvent } from "@lib/interfaces/StorageEventManager";
import type { FileProcessingService } from "@lib/services/base/FileProcessingService";
import { admitStorageEvents, selectRenameFileEvent, type StorageEventAdmissionEffects } from "./admission";
import { createFileEventAttempt } from "./operations";
import { handleStorageFileEvent, processStorageEventAttempt, type StorageEventAttemptEffects } from "./processing";
import { persistFileEventSnapshot } from "./snapshot";
import { createStorageEventState, retainFileEvent, type QueuedFileEvent, type StorageEventBuffer } from "./state";
import { Semaphore } from "octagonal-wheels/concurrency/semaphore";

/** Create a valid ordinary notification without sharing mutable argument objects between cases. */
function notification(type: FileEvent["type"] = "CHANGED"): FileEvent {
    return {
        type,
        file: { path: "new.md" as FilePath, name: "new.md", stat: { ctime: 1, mtime: 2, size: 3, type: "file" } },
    };
}

/** Convert a notification into retained intent without bypassing the manager's state transitions. */
function intent(): FileEventItem {
    const event = notification();
    return { type: event.type, key: "contract", args: { file: event.file } };
}

/** Supply an observable host buffer while retaining the real snapshot and ownership implementation. */
function buffer(initial: QueuedFileEvent[] = []): StorageEventBuffer {
    let events = initial;
    return {
        read: () => events,
        replace: (next) => {
            events = next;
        },
        append: (event) => {
            events.push(event);
        },
        shift: () => events.shift(),
    };
}

/** Mock only the platform selection and queue boundaries, with valid file classification. */
function admissionFixture() {
    const state = createStorageEventState();
    const effects: StorageEventAdmissionEffects = {
        settings: () => ({ ...DEFAULT_SETTINGS, isConfigured: true }),
        isFolder: () => false,
        isFile: (file) => file.stat !== undefined,
        isTarget: vi.fn(async () => true),
        isTooLarge: vi.fn(() => false),
        recentlyTouched: vi.fn(() => false),
        onStorageFileEvent: vi.fn(),
        enqueue: vi.fn((event) => {
            retainFileEvent(state, event);
        }),
        release: vi.fn(),
        reportFailure: vi.fn(),
        log: vi.fn(),
    };
    return { state, effects };
}

describe("exported storage-event boundary decisions", () => {
    it.each([
        [false, false, null],
        [false, true, "CREATE"],
        [true, false, "DELETE"],
        [true, true, "RENAME"],
    ] as const)("selects a rename with source=%s destination=%s", (oldSelected, newSelected, expected) => {
        const event = { ...notification("RENAME"), oldPath: "folder/old.md" };
        const selected = selectRenameFileEvent(event, oldSelected, newSelected);
        expect(selected?.type ?? null).toBe(expected);
        if (expected === "DELETE") {
            expect(selected?.args).toEqual({
                file: { path: "folder/old.md", name: "old.md", stat: event.file.stat, deleted: true },
                oldPath: undefined,
                renameTarget: "new.md",
            });
        } else if (selected) {
            expect(selected.args.file).toBe(event.file);
            expect(selected.args.oldPath).toBe(oldSelected ? event.oldPath : undefined);
        }
    });

    it.each(["missing source", "internal source"])("does not admit an invalid rename: %s", async (reason) => {
        const f = admissionFixture();
        const event = notification("RENAME");
        if (reason === "internal source") {
            event.oldPath = "old.md";
            event.file = { path: ".obsidian/config" as FilePath, name: "config", isInternal: true, stat: undefined };
        }
        await admitStorageEvents(f.state, [event], undefined, f.effects);
        expect(f.effects.enqueue).not.toHaveBeenCalled();
        expect(f.effects.isTarget).not.toHaveBeenCalled();
        expect(f.effects.log).toHaveBeenCalledOnce();
        expect(f.state.admissions.size).toBe(0);
    });

    it("keeps an oversized rename's source deletion and its filtered destination identity", async () => {
        const f = admissionFixture();
        f.effects.isTooLarge = vi.fn(() => true);
        await admitStorageEvents(
            f.state,
            [{ ...notification("RENAME"), oldPath: "old.md" }],
            { owner: "host" },
            f.effects
        );
        expect(f.effects.enqueue).toHaveBeenCalledWith(
            expect.objectContaining({
                type: "DELETE",
                args: expect.objectContaining({
                    file: expect.objectContaining({ path: "old.md" }),
                    renameTarget: "new.md",
                    ctx: { owner: "host" },
                }),
            })
        );
        expect(f.effects.log).toHaveBeenCalledOnce();
        expect(f.effects.recentlyTouched).not.toHaveBeenCalled();
    });

    it("reports a target lookup rejection and removes admission without enqueueing", async () => {
        const f = admissionFixture();
        const failure = new Error("target lookup failed");
        f.effects.isTarget = vi.fn(async () => {
            throw failure;
        });
        await expect(admitStorageEvents(f.state, [notification()], undefined, f.effects)).rejects.toBe(failure);
        expect(f.effects.reportFailure).toHaveBeenCalledExactlyOnceWith(failure);
        expect(f.effects.enqueue).not.toHaveBeenCalled();
        expect(f.state.admissions.size).toBe(0);
    });

    it.each(["entry replaced", "attempt replaced"])(
        "does not acknowledge stale snapshot ownership: %s",
        async (reason) => {
            const state = createStorageEventState();
            const event = intent();
            const entry = retainFileEvent(state, event);
            const attempt = entry.operation!.attempt;
            if (reason === "entry replaced") {
                state.pendingSnapshot.delete(event);
                retainFileEvent(state, event);
            } else entry.operation!.attempt = createFileEventAttempt(true);
            const save = vi.fn(async (_events: QueuedFileEvent[]) => {});
            const updateStatus = vi.fn();
            await persistFileEventSnapshot(
                state,
                buffer(),
                { save, waitingEvents: () => [], updateStatus },
                { entry, attempt }
            );
            expect(save).not.toHaveBeenCalled();
            expect(updateStatus).not.toHaveBeenCalled();
            expect(state.pendingSnapshot.get(event)?.completed).toBe(false);
            expect(state.latestByPath.get("new.md")).toBe(entry.operation);
        }
    );

    it("does not commit a completion whose admission failed", async () => {
        const state = createStorageEventState();
        const event = intent();
        const entry = retainFileEvent(state, event);
        const attempt = entry.operation!.attempt;
        const error = new Error("admission persistence failed");
        attempt.admissionFailure = { error };
        const save = vi.fn(async (_events: QueuedFileEvent[]) => {});
        await expect(
            persistFileEventSnapshot(
                state,
                buffer(),
                { save, waitingEvents: () => [], updateStatus: vi.fn() },
                { entry, attempt }
            )
        ).rejects.toBe(error);
        expect(save).not.toHaveBeenCalled();
        expect(entry.completed).toBe(false);
        expect(state.pendingSnapshot.has(event)).toBe(true);
    });

    it("retains replacement ownership installed while an older completion is being saved", async () => {
        const state = createStorageEventState();
        const event = intent();
        const old = retainFileEvent(state, event);
        const save = vi.fn(async (_events: QueuedFileEvent[]) => {
            state.pendingSnapshot.delete(event);
            retainFileEvent(state, event);
        });
        await persistFileEventSnapshot(
            state,
            buffer(),
            { save, waitingEvents: () => [], updateStatus: vi.fn() },
            { entry: old, attempt: old.operation!.attempt }
        );
        expect(state.pendingSnapshot.get(event)).not.toBe(old);
        expect(state.pendingSnapshot.get(event)?.completed).toBe(false);
        expect(state.latestByPath.has("new.md")).toBe(true);
    });

    it("retains a cancelled operation when no successful coalesced successor exists", async () => {
        const state = createStorageEventState();
        const event = intent();
        const operation = retainFileEvent(state, event).operation!;
        const failure = vi.fn();
        const effects: StorageEventAttemptEffects = {
            capture: (ops) => new Map(ops.map((op) => [op, op.attempt])),
            release: vi.fn(),
            wait: async () => [],
            initialise: async () => false,
            takeSnapshot: vi.fn(async () => {}),
            completeSnapshot: vi.fn(async () => {}),
            semaphore: () => Semaphore(1),
            requestProcessQueue: vi.fn(async () => {}),
            cancelWaiting: vi.fn(),
            fail: failure,
            updateStatus: vi.fn(),
            reportFailure: vi.fn(),
        };
        await expect(processStorageEventAttempt(state, operation, operation.attempt, effects)).rejects.toThrow(
            "cancelled without a successor"
        );
        expect(effects.requestProcessQueue).not.toHaveBeenCalled();
        expect(effects.completeSnapshot).not.toHaveBeenCalled();
        expect(failure).toHaveBeenCalledWith(operation, expect.any(Error), operation.attempt);
        expect(state.pendingSnapshot.has(event)).toBe(true);
        expect(effects.updateStatus).toHaveBeenCalledOnce();
    });

    it("uses the legacy optional provider when no durable operation is associated", async () => {
        const event = intent();
        event.type = "INTERNAL";
        const optional = vi.fn(async () => {});
        const updateStatus = vi.fn();
        // Only the selected service capability is needed at this external host boundary.
        const service = { processOptionalFileEvent: optional } as unknown as FileProcessingService;
        await handleStorageFileEvent(event, { processing: () => service, operation: () => undefined, updateStatus });
        expect(optional).toHaveBeenCalledExactlyOnceWith("new.md");
        expect(updateStatus).toHaveBeenCalledOnce();
    });
});
