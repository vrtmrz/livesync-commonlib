import { describe, expect, it, vi } from "vitest";
import { Semaphore } from "octagonal-wheels/concurrency/semaphore";
import { promiseWithResolvers } from "octagonal-wheels/promises";
import type { FileEventItem, FilePath } from "@lib/common/types";
import type { FileProcessingService } from "@lib/services/base/FileProcessingService";
import { processStorageEventAttempt, handleStorageFileEvent, type StorageEventAttemptEffects } from "./processing";
import { createStorageEventState, failFileEventAttempt, retainFileEvent } from "./state";

/** Construct a retained operation and observable host boundaries for joining an existing attempt. */
function fixture() {
    const state = createStorageEventState();
    const event: FileEventItem = {
        type: "CHANGED",
        key: "joined",
        args: {
            file: {
                path: "joined.md" as FilePath,
                name: "joined.md",
                stat: { ctime: 1, mtime: 1, size: 1, type: "file" },
            },
        },
    };
    const operation = retainFileEvent(state, event).operation!;
    const effects: StorageEventAttemptEffects = {
        capture: (ops) => new Map(ops.map((op) => [op, op.attempt])),
        release: vi.fn(),
        wait: async () => [],
        initialise: vi.fn(async () => true),
        takeSnapshot: vi.fn(async () => {}),
        completeSnapshot: vi.fn(async () => {}),
        semaphore: () => Semaphore(1),
        requestProcessQueue: vi.fn(async () => {}),
        cancelWaiting: vi.fn(),
        fail: vi.fn(),
        updateStatus: vi.fn(),
        reportFailure: vi.fn(),
    };
    return { state, event, operation, effects };
}

describe("existing attempt and optional-handler boundaries", () => {
    it("joins an active attempt and observes its exact failure without starting another handler", async () => {
        const f = fixture();
        f.operation.attempt.started = true;
        const error = new Error("active handler failed");
        const completion = processStorageEventAttempt(f.state, f.operation, f.operation.attempt, f.effects);
        const rejected = expect(completion).rejects.toBe(error);
        failFileEventAttempt(f.state, f.operation.attempt, error);
        await rejected;
        expect(f.effects.initialise).not.toHaveBeenCalled();
        expect(f.effects.requestProcessQueue).not.toHaveBeenCalled();
        expect(f.effects.takeSnapshot).not.toHaveBeenCalled();
        expect(f.effects.completeSnapshot).not.toHaveBeenCalled();
        expect(f.state.pendingSnapshot.has(f.event)).toBe(true);
    });

    it("joins an active attempt until its current owner completes", async () => {
        const f = fixture();
        const gate = promiseWithResolvers<void>();
        f.effects.requestProcessQueue = vi.fn(() => gate.promise);
        const owner = processStorageEventAttempt(f.state, f.operation, f.operation.attempt, f.effects);
        const joined = processStorageEventAttempt(f.state, f.operation, f.operation.attempt, f.effects);
        gate.resolve();
        await Promise.all([owner, joined]);
        expect(f.effects.requestProcessQueue).toHaveBeenCalledExactlyOnceWith(f.event);
        expect(f.effects.takeSnapshot).toHaveBeenCalledOnce();
        expect(f.effects.completeSnapshot).toHaveBeenCalledOnce();
        expect(f.operation.attempt.result).toEqual({ ok: true });
    });

    it("passes no flush signal to a typed optional provider without an associated operation", async () => {
        const f = fixture();
        f.event.type = "INTERNAL";
        const provider = vi.fn(async (_path: FilePath, _options?: { whenFlushRequested?: Promise<void> }) => ({
            kind: "completed" as const,
        }));
        // This external host boundary supplies only the optional capability selected by the handler.
        const service = { processOptionalFileEventWithResult: provider } as unknown as FileProcessingService;
        const updateStatus = vi.fn();
        await handleStorageFileEvent(f.event, { processing: () => service, operation: () => undefined, updateStatus });
        expect(provider).toHaveBeenCalledExactlyOnceWith("joined.md", { whenFlushRequested: undefined });
        expect(updateStatus).toHaveBeenCalledOnce();
    });
});
