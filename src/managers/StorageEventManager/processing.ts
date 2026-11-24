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
    isStoreLoaded,
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
    /** Whether the owning manager has entered orderly shutdown. */
    isStopping?(): boolean;
    /** Wait until a reversible dispatch pause is lifted or shutdown begins. */
    waitUntilDispatchResumed?(): Promise<void>;
    /** Whether new file-handler dispatch is currently paused. */
    isDispatchPaused?(): boolean;
    /** Record that execution has crossed the host-handler start boundary. */
    onHandlerStarted?(): void;
}

/**
 * Capture the ordering boundary and initialise the operation's batch and related dependencies.
 * @param state - The manager state containing retained operations before any barrier.
 * @param operation - The durable operation whose attempt is being prepared.
 * @param attempt - The attempt which will own the captured predecessor and prerequisite attempts.
 * @param effects - Host callbacks for capture, release, and batch initialisation.
 * @returns The batch-gate promise indicating whether this operation may proceed.
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

async function waitForDependencies(
    attempt: FileEventAttempt,
    effects: StorageEventAttemptEffects
): Promise<AttemptExecutionOutcome> {
    if (attempt.orderedPredecessors?.size) {
        const results = await effects.wait(attempt.orderedPredecessors);
        if (effects.isStopping?.() || results.some(isStoppedResult)) return "stopped";
    }
    if (attempt.prerequisites?.size) {
        const results = await effects.wait(attempt.prerequisites);
        if (effects.isStopping?.() || results.some(isStoppedResult)) return "stopped";
        assertSuccessfulFileEvents(results);
    }
    return "completed";
}

/** Advance a gate-cleared attempt through dependency waits, pause barrier, and semaphore-guarded handler execution. */
async function executeAttempt(
    state: StorageEventState,
    operation: PendingFileEvent,
    attempt: FileEventAttempt,
    canProceed: BatchGateOutcome,
    effects: StorageEventAttemptEffects,
    storeGeneration: number
): Promise<AttemptExecutionOutcome> {
    if (canProceed === "stopped") return "stopped";
    if (!canProceed) {
        if (!attempt.successor) {
            throw new Error(`Storage operation cancelled without a successor: ${operation.event.args.file.path}`);
        }
        const result = await attempt.successor.completion.promise;
        if (isStoppedResult(result)) return "stopped";
        assertSuccessfulFileEvents([result]);
        return "completed";
    }
    if ((await waitForDependencies(attempt, effects)) === "stopped") return "stopped";
    while (true) {
        while (effects.isDispatchPaused?.() && !effects.isStopping?.()) {
            await effects.waitUntilDispatchResumed?.();
        }
        if (effects.isStopping?.()) return "stopped";
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
 */
export async function processStorageEventAttempt(
    state: StorageEventState,
    operation: PendingFileEvent,
    attempt: FileEventAttempt,
    effects: StorageEventAttemptEffects
): Promise<void> {
    if (attempt.started || attempt.result) {
        assertSuccessfulFileEvents([await attempt.completion.promise]);
        return;
    }
    attempt.started = true;
    const generation = state.persistence.storeGeneration;
    const entry = state.pendingSnapshot.get(operation.event)!;
    try {
        if (effects.isStopping?.()) {
            stopFileEventAttempt(attempt);
            return;
        }
        const gate = prepareAttempt(state, operation, attempt, effects);
        if (!entry.persisted || !isStoreLoaded(state)) {
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
        const outcome = await executeAttempt(state, operation, attempt, canProceed, effects, generation);
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
    } finally {
        effects.updateStatus();
    }
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

function flushSignal(operation?: PendingFileEvent): Promise<void> | undefined {
    if (!operation) return undefined;
    operation.flushSignal ??= promiseWithResolvers<void>();
    if (operation.flushRequested) operation.flushSignal.resolve();
    return operation.flushSignal.promise;
}

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
