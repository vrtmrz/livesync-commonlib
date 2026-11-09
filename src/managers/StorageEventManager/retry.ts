/**
 * Apply a finite retry plan to manager-owned operation and buffer state.
 * All replacement attempts are installed before handlers are scheduled across a microtask boundary.
 */
import { fireAndForget } from "@lib/common/utils";
import {
    planFileEventAttempts,
    type FileEventAttempt,
    type OperationResult,
    type PendingFileEvent,
} from "./operations";
import type { QueuedFileEvent, StorageEventBuffer } from "./state";

/** Host-owned queue and processing callbacks required to apply and start a retry plan. */
export interface StorageEventRetryEffects {
    /** Host-owned queue whose sentinels and retry events must be reconciled with the new attempts. */
    readonly buffer: StorageEventBuffer;
    /** Process one captured operation attempt. */
    processOperation(operation: PendingFileEvent, attempt: FileEventAttempt): Promise<void>;
    /** Dispatch any remaining queued items after retry events have been removed. */
    runQueuedEvents(): Promise<void>;
    /** Report a background dispatch failure which has no direct waiter. */
    reportFailure(error: unknown): void;
}

/**
 * Plan a finite set of attempts, install all replacement ownership, then start retries in a microtask.
 * @param operations - Operations accepted into the caller's finite boundary.
 * @param retryBefore - Inclusive highest failure sequence eligible for a replacement attempt.
 * @param effects - Host queue and processing callbacks used to install and run the plan.
 * @returns The attempt captured for each planned operation, including newly installed retries.
 * @remarks Planning failure leaves existing attempts untouched. When retries exist, their buffered events are
 * removed and every replacement attempt is installed before any handler starts, so dependency callbacks see one
 * coherent ownership set. Handlers start in a later microtask; their rejected promises are consumed here while
 * their attempt results remain available to captured waiters. Remaining buffer items are dispatched separately.
 */
export function captureFileEventAttempts(
    operations: readonly PendingFileEvent[],
    retryBefore: number,
    effects: StorageEventRetryEffects
): Map<PendingFileEvent, FileEventAttempt> {
    const { captured, retries } = planFileEventAttempts(operations, retryBefore);
    if (retries.size === 0) return captured;
    const retryEvents = new Set<QueuedFileEvent>([...retries.keys()].map((operation) => operation.event));
    effects.buffer.replace(effects.buffer.read().filter((event) => !retryEvents.has(event)));
    for (const [operation, attempt] of retries) operation.attempt = attempt;
    for (const [operation, attempt] of retries) {
        // Uninitialised predecessors may discover more work during setup.
        fireAndForget(
            Promise.resolve()
                .then(() => effects.processOperation(operation, attempt))
                .catch(() => {})
        );
    }
    if (effects.buffer.read().length > 0) {
        // Admission failure can leave the original sentinel undispatched.
        fireAndForget(
            Promise.resolve()
                .then(() => effects.runQueuedEvents())
                .catch(effects.reportFailure)
        );
    }
    return captured;
}

/**
 * Release batch waits for a captured operation set, then await those attempts.
 * @param attempts - The fixed operation-to-attempt boundary selected by the caller.
 * @param release - Callback which signals flush intent and releases matching batch gates.
 * @returns The captured attempt outcomes in map iteration order.
 * @remarks Release runs before waiting so batch-gated work can proceed. New operations are not added to this wait.
 */
export async function waitForFileEventAttempts(
    attempts: ReadonlyMap<PendingFileEvent, FileEventAttempt>,
    release: (operations: readonly PendingFileEvent[]) => void
): Promise<OperationResult[]> {
    release([...attempts.keys()]);
    return await Promise.all([...attempts.values()].map((attempt) => attempt.completion.promise));
}
