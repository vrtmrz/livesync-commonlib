/**
 * Own each attempt's dependency waits, handler invocation, and terminal settlement.
 * Ordered predecessors need only settle; related prerequisites must succeed before processing starts.
 */
import type { FileEventItem, FilePath } from "@lib/common/types";
import { createReconcileEvent } from "@lib/common/models/fileaccess.definition";
import type { FileProcessingService } from "@lib/services/base/FileProcessingService";
import { withLock } from "octagonal-wheels/concurrency/lock.scoped";
import { withSemaphore, type SemaphoreObject } from "octagonal-wheels/concurrency/semaphore";
import { promiseWithResolvers } from "octagonal-wheels/promises";
import { withScope } from "octagonal-wheels/resource/scope";
import type { BatchGateOutcome } from "./batching";
import {
    canRetryFileEvent,
    assertFileEventAdmission,
    assertSuccessfulFileEvents,
    type FileEventAttempt,
    type OperationResult,
    type PendingFileEvent,
    isStoppedResult,
    stopFileEventAttempt,
} from "./operations";
import {
    completeFileEventAttempt,
    isStoreAcquired,
    pendingFileOperations,
    type SnapshotCompletion,
    type StorageEventNotifications,
    type StorageEventState,
} from "./state";

/** Terminal result of an attempt's execution step before completion persistence. */
type AttemptExecutionOutcome = "completed" | "stopped";

/** Result of one semaphore-guarded handler dispatch attempt; `"paused"` yields back to the pause barrier. */
type HandlerDispatchOutcome = AttemptExecutionOutcome | "paused";

/** Host callbacks which connect attempt ownership to batching, snapshots, and file processing. */
export interface StorageEventAttemptEffects extends StorageEventNotifications {
    /** Capture attempts for dependencies at an optional failure cutoff. */
    capture(operations: readonly PendingFileEvent[], retryBefore?: number): Map<PendingFileEvent, FileEventAttempt>;
    /** Release batch gates before initialisation or predecessor processing can admit a successor. */
    release(operations: readonly PendingFileEvent[]): void;
    /** Wait for captured attempts and return their terminal outcomes. */
    wait(attempts: Map<PendingFileEvent, FileEventAttempt>): Promise<OperationResult[]>;
    /** Initialise dependency links and report whether this operation still owns processing. */
    initialise(operation: PendingFileEvent): Promise<BatchGateOutcome>;
    /** Persist current intent before handler execution. */
    takeSnapshot(requiredMutationVersion?: number): Promise<void>;
    /** Persist the completion acknowledgement for this exact snapshot entry and attempt. */
    completeSnapshot(completion: SnapshotCompletion): Promise<void>;
    /** Obtain the host semaphore which limits concurrent file handling. */
    semaphore(): SemaphoreObject;
    /** Submit an event to the host file-processing queue. */
    requestProcessQueue(event: FileEventItem): Promise<void>;
    /** Cancel any batch wait owned by the event after its attempt fails. */
    cancelWaiting(event: FileEventItem): void;
    /** Settle an operation attempt as failed. */
    fail(operation: PendingFileEvent, error: unknown, attempt: FileEventAttempt): void;
    /** Whether this event currently owns an active batch wait gate. */
    isWaiting?(event: FileEventItem): boolean;
    /** Whether the owning manager has entered orderly shutdown. */
    isStopping?(): boolean;
    /** Wait until a reversible dispatch pause is lifted or shutdown begins. */
    waitUntilDispatchResumed?(): Promise<void>;
    /** Whether new file-handler dispatch is currently paused. */
    isDispatchPaused?(): boolean;
    /** Re-acquire dispatch window capacity before competing for the handler semaphore. */
    acquireDispatchSlot?(): Promise<boolean>;
    /** Record that execution has crossed the host-handler start boundary. */
    onHandlerStarted?(): void;
}

/**
 * Release the attempt's dispatch slot before blocking on another producer or pause signal,
 * ensuring waiting attempts never hold dispatch capacity needed by their predecessors or retries.
 */
async function whileReleasingDispatchSlot<T>(releaseDispatchSlot: () => void, wait: () => Promise<T>): Promise<T> {
    releaseDispatchSlot();
    return await wait();
}

/**
 * Capture the ordering boundary and initialise the operation's batch and related dependencies.
 * @param state - The manager state containing retained operations before any barrier.
 * @param operation - The durable operation whose attempt is being prepared.
 * @param attempt - The attempt which will own the captured predecessor and prerequisite attempts.
 * @param effects - Host callbacks for capture, release, and batch initialisation.
 * @returns The batch-gate promise indicating whether this operation may proceed.
 * @remarks Ordered predecessors are captured before initialisation and released before it runs, preventing the
 * ordered predecessor from coalescing into this operation and creating a dependency cycle. Initialisation establishes related prerequisites;
 * those are captured afterwards using the attempt's retry cutoff or the operation's admission boundary.
 * This function prepares captures but does not wait for either dependency set to settle.
 */
function prepareAttempt(
    state: StorageEventState,
    operation: PendingFileEvent,
    attempt: FileEventAttempt,
    effects: StorageEventAttemptEffects
): Promise<BatchGateOutcome> {
    attempt.orderedPredecessors ??=
        operation.barrierBefore === undefined
            ? new Map()
            : effects.capture(pendingFileOperations(state, operation.barrierBefore));
    // Release before initialisation so a batch cannot coalesce into its own successor.
    effects.release([...attempt.orderedPredecessors.keys()]);
    const gate = operation.initialised ? Promise.resolve(true) : effects.initialise(operation);
    attempt.prerequisites ??= effects.capture(
        [...operation.prerequisites],
        canRetryFileEvent(operation.event) ? (attempt.retryBefore ?? operation.failureBoundary) : -1
    );
    return gate;
}

/** Follow a coalesced successor's completion instead of running a duplicate handler for this operation. */
async function waitForCoalescedSuccessor(
    operation: PendingFileEvent,
    attempt: FileEventAttempt,
    releaseDispatchSlot: () => void
): Promise<AttemptExecutionOutcome> {
    if (!attempt.successor) {
        throw new Error(`Storage operation cancelled without a successor: ${operation.event.args.file.path}`);
    }
    const result = await whileReleasingDispatchSlot(releaseDispatchSlot, () => attempt.successor!.completion.promise);
    if (isStoppedResult(result)) return "stopped";
    assertSuccessfulFileEvents([result]);
    return "completed";
}

/**
 * Wait for captured ordering and prerequisite dependencies without holding a dispatch slot.
 * Ordered predecessors require settlement only; related prerequisites additionally require success.
 */
async function waitForCapturedDependencies(
    attempt: FileEventAttempt,
    effects: StorageEventAttemptEffects,
    releaseDispatchSlot: () => void
): Promise<AttemptExecutionOutcome> {
    if (attempt.orderedPredecessors?.size) {
        const results = await whileReleasingDispatchSlot(releaseDispatchSlot, () =>
            effects.wait(attempt.orderedPredecessors!)
        );
        if (effects.isStopping?.() || results.some(isStoppedResult)) return "stopped";
    }
    if (attempt.prerequisites?.size) {
        const results = await whileReleasingDispatchSlot(releaseDispatchSlot, () =>
            effects.wait(attempt.prerequisites!)
        );
        if (effects.isStopping?.() || results.some(isStoppedResult)) return "stopped";
        assertSuccessfulFileEvents(results);
    }
    return "completed";
}

/** Yield the dispatch slot until any active reversible dispatch pause is lifted or shutdown starts. */
async function waitWhileDispatchPaused(
    effects: StorageEventAttemptEffects,
    releaseDispatchSlot: () => void
): Promise<void> {
    while (effects.isDispatchPaused?.() && !effects.isStopping?.()) {
        await whileReleasingDispatchSlot(releaseDispatchSlot, async () => {
            await effects.waitUntilDispatchResumed?.();
        });
    }
}

/** Acquire the host concurrency semaphore, verify preconditions, and invoke the file-event handler. */
function invokeFileEventHandler(
    state: StorageEventState,
    operation: PendingFileEvent,
    attempt: FileEventAttempt,
    effects: StorageEventAttemptEffects,
    storeGeneration: number
): Promise<HandlerDispatchOutcome> {
    return withSemaphore(effects.semaphore(), async () => {
        if (effects.isStopping?.()) return "stopped";
        if (effects.isDispatchPaused?.()) return "paused";
        assertFileEventAdmission(attempt);
        if (state.persistence.storeGeneration !== storeGeneration) {
            throw new Error("Storage event store changed during processing");
        }
        const event = attempt.reconcile ? createReconcileEvent(operation.event) : operation.event;
        state.operations.set(event, operation);
        attempt.handlerStarted = true;
        effects.onHandlerStarted?.();
        await effects.requestProcessQueue(event);
        return "completed";
    });
}

/**
 * Advance a gate-cleared attempt through dependency waits, pause/slot acquisition, and handler execution.
 * Each blocking step releases the dispatch slot while waiting and re-acquires capacity before entering
 * the host semaphore.
 */
async function executeAttempt(
    state: StorageEventState,
    operation: PendingFileEvent,
    attempt: FileEventAttempt,
    canProceed: BatchGateOutcome,
    effects: StorageEventAttemptEffects,
    releaseDispatchSlot: () => void,
    storeGeneration: number
): Promise<AttemptExecutionOutcome> {
    if (canProceed === "stopped") return "stopped";
    if (!canProceed) {
        return await waitForCoalescedSuccessor(operation, attempt, releaseDispatchSlot);
    }
    const dependencyOutcome = await waitForCapturedDependencies(attempt, effects, releaseDispatchSlot);
    if (dependencyOutcome === "stopped") return "stopped";

    while (true) {
        await waitWhileDispatchPaused(effects, releaseDispatchSlot);
        if (effects.isStopping?.()) return "stopped";
        if (effects.acquireDispatchSlot && !(await effects.acquireDispatchSlot())) continue;
        if (effects.isStopping?.()) return "stopped";
        if (effects.isDispatchPaused?.()) continue;
        const outcome = await invokeFileEventHandler(state, operation, attempt, effects, storeGeneration);
        if (outcome !== "paused") return outcome;
    }
}

/**
 * Run one attempt or join an attempt already in progress.
 * @param state - The manager state owning the operation, current attempt, and snapshot entry.
 * @param operation - The durable operation whose handler is being run.
 * @param attempt - The specific attempt to start or observe.
 * @param effects - Host callbacks for snapshots, dependencies, processing, failure, and status.
 * @returns A promise which resolves after the attempt's completion-snapshot step and success settlement, or after
 * a joined attempt settles successfully; rejects with the attempt failure otherwise.
 * @remarks A new attempt is marked started before its initial intent snapshot. Admission is checked around awaited
 * gates and before completion; completion is settled only after completeSnapshot returns. On failure, its batch wait
 * is cancelled, the attempt is failed, and the error is rethrown. Slot release and status refresh run via scope cleanup.
 */
export async function processStorageEventAttempt(
    state: StorageEventState,
    operation: PendingFileEvent,
    attempt: FileEventAttempt,
    effects: StorageEventAttemptEffects,
    releaseDispatchSlot: () => void = () => {}
): Promise<void> {
    if (attempt.started || attempt.result) {
        assertSuccessfulFileEvents([await attempt.completion.promise]);
        return;
    }
    attempt.started = true;
    const generation = state.persistence.storeGeneration;
    const entry = state.pendingSnapshot.get(operation.event)!;
    await withScope(attempt, async (scope) => {
        // Registered in reverse-execution order: release slot first, then refresh status.
        scope.defer(() => effects.updateStatus());
        scope.defer(() => releaseDispatchSlot());
        try {
            if (effects.isStopping?.()) {
                stopFileEventAttempt(attempt);
                return;
            }
            const gate = prepareAttempt(state, operation, attempt, effects);
            if (effects.isWaiting?.(operation.event)) releaseDispatchSlot();
            if (!entry.persisted || !isStoreAcquired(state)) {
                await effects.takeSnapshot(entry.mutationVersion);
            } else if (attempt.admissionPersistenceStoreGeneration === generation) {
                await attempt.admissionPersistence;
            }
            assertFileEventAdmission(attempt);
            const canProceed = await gate;
            if (canProceed === "stopped" || effects.isStopping?.()) {
                stopFileEventAttempt(attempt);
                return;
            }
            if (attempt.result) return;
            assertFileEventAdmission(attempt);
            const outcome = await executeAttempt(
                state,
                operation,
                attempt,
                canProceed,
                effects,
                releaseDispatchSlot,
                generation
            );
            if (outcome === "stopped") {
                stopFileEventAttempt(attempt);
                return;
            }
            assertFileEventAdmission(attempt);
            if (state.persistence.storeGeneration !== generation) {
                throw new Error("Storage event store changed during processing");
            }
            await effects.completeSnapshot({ entry, attempt });
            completeFileEventAttempt(state, operation, attempt);
        } catch (error) {
            if (!attempt.handlerStarted && effects.isStopping?.()) {
                stopFileEventAttempt(attempt);
                return;
            }
            effects.cancelWaiting(operation.event);
            effects.fail(operation, error, attempt);
            throw error;
        }
    });
}

/** Live host service lookups used by the final file-event handler. */
export interface StorageEventHandlerEffects {
    /** Resolve the current file-processing service when the event is handled. */
    processing(): FileProcessingService;
    /** Resolve the operation associated with the original or transient reconciliation event. */
    operation(event: FileEventItem): PendingFileEvent | undefined;
    /** Refresh host status after handler completion. */
    updateStatus(): void;
}

/**
 * Return the shared flush signal for an optional handler, creating it on first use.
 * @param operation - The durable operation associated with the handler, when one is available.
 * @returns The operation's flush-signal promise, or undefined when no operation is associated.
 * @remarks The promise is stored on the operation and reused by later callers. If flush was already requested,
 * the newly created or existing signal is resolved before it is returned.
 */
function flushSignal(operation?: PendingFileEvent): Promise<void> | undefined {
    if (!operation) return undefined;
    operation.flushSignal ??= promiseWithResolvers<void>();
    if (operation.flushRequested) operation.flushSignal.resolve();
    return operation.flushSignal.promise;
}

/**
 * Invoke the configured optional-event route for an internal file event.
 * @param event - The file event whose path is passed to the optional provider.
 * @param effects - Live service lookup and durable-operation lookup supplied by the host.
 * @returns A promise which resolves when the selected provider route resolves.
 * @remarks The result-aware handler receives a flush signal and its veto rejects the operation. When it is absent
 * or reports no handlers, the legacy notification handler is awaited instead; retry policy remains provider-owned.
 */
async function processOptionalEvent(event: FileEventItem, effects: StorageEventHandlerEffects): Promise<void> {
    const path = event.args.file.path as FilePath;
    const handler = effects.processing().processOptionalFileEventWithResult;
    if (handler && handler.hasHandlers !== false) {
        const outcome = await handler(path, { whenFlushRequested: flushSignal(effects.operation(event)) });
        if (outcome.kind === "veto") throw new Error(`Optional storage operation declined: ${path} (${outcome.value})`);
    } else {
        // Legacy providers report notification handling rather than persistence.
        await effects.processing().processOptionalFileEvent(path);
    }
}

/**
 * Serialise one file-event handler by path and select ordinary or optional-provider processing.
 * @param event - The file event passed to the host handler.
 * @param effects - Live host processing, operation, and status lookups.
 * @returns A promise which resolves after the keyed lock is released and status is updated on success.
 * @remarks A cancelled event, optional-provider veto, or false ordinary-handler result rejects. The keyed lock is
 * released by withLock on either outcome; this function does not own snapshot persistence or attempt settlement.
 */
export async function handleStorageFileEvent(event: FileEventItem, effects: StorageEventHandlerEffects): Promise<void> {
    const file = event.args.file;
    await withLock(`handleFile:${file.path}`, async () => {
        if (event.cancelled === true) throw new Error(`Storage operation has no confirmed result: ${file.path}`);
        if (event.type === "INTERNAL" || file.isInternal === true) await processOptionalEvent(event, effects);
        else if (!(await effects.processing().processFileEvent(event)))
            throw new Error(`Storage operation failed: ${file.path}`);
    });
    effects.updateStatus();
}
