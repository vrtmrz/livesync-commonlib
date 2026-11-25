/**
 * Coordinate in-memory dispatch for both the legacy snapshot and the ordered buffer store.
 * The in-memory queue advances dispatch. Persistence retains intent until acknowledgement.
 */
import type { FileEventItem } from "@lib/common/types";
import { LOG_LEVEL_VERBOSE } from "@lib/common/types";
import { fireAndForget } from "@lib/common/utils";
import type { LogFunction } from "@lib/services/lib/logUtils";
import type { PendingStorageEventBuffer } from "../adapters";
import { shareRunningResult } from "octagonal-wheels/concurrency/lock";
import {
    assertSuccessfulFileEvents,
    type FileEventAttempt,
    type OperationResult,
    type PendingFileEvent,
} from "./operations";
import {
    TYPE_SENTINEL_FLUSH,
    pendingFileOperations,
    retainBufferedFileEvents,
    retainFileEvent,
    type EventAdmission,
    type PendingSnapshotEntry,
    type QueuedFileEvent,
    type RunQueuedEventsOptions,
    type StorageEventBuffer,
    type StorageEventNotifications,
    type StorageEventState,
} from "./state";

/** Host callbacks used by queue ownership, dispatch, finite flush, and restoration. */
export interface StorageEventQueueEffects extends StorageEventNotifications {
    /** Host-owned event buffer used by admission, dispatch, and retry. */
    readonly buffer: StorageEventBuffer;
    /** Host logger for restoration diagnostics. */
    log: LogFunction;
    /** Persist the current intent snapshot. */
    takeSnapshot(): Promise<void>;
    /** Wait for the append which owns this entry. An already committed entry resolves immediately. */
    persistEntry?(entry: PendingSnapshotEntry): Promise<void>;
    /** Mark the sentinel complete after its predecessors settle. A partially completed array remains replayable. */
    acknowledgeSentinel?(entry: PendingSnapshotEntry): Promise<void>;
    /** Load the prior runtime's saved event intent, if any. */
    loadSnapshot(): Promise<QueuedFileEvent[] | null>;
    /** Enter the host event-processing route for one file event. */
    processFileEvent(event: FileEventItem): Promise<void>;
    /** Run the shared queue dispatcher, optionally waiting for processing. */
    runQueuedEvents(options?: RunQueuedEventsOptions): Promise<void>;
    /** Capture attempts at the supplied failure boundary. */
    capture(operations: readonly PendingFileEvent[], retryBefore?: number): Map<PendingFileEvent, FileEventAttempt>;
    /** Release batch gates associated with the supplied operations. */
    release(operations: readonly PendingFileEvent[]): void;
    /** Wait for a captured set and return results in its map order. */
    wait(attempts: Map<PendingFileEvent, FileEventAttempt>): Promise<OperationResult[]>;
    /** Settle and report a failure for one operation attempt. */
    fail(operation: PendingFileEvent, error: unknown, attempt: FileEventAttempt): void;
}

/**
 * Append an accepted event and schedule its snapshot and queue dispatch.
 * @param state - The manager state which owns the retained intent and operation attempt.
 * @param event - The accepted file event to enqueue.
 * @param effects - Host buffer, persistence, dispatch, status, and failure callbacks.
 * @returns Nothing; appends a sentinel before DELETE/RENAME, appends the event, and refreshes status synchronously.
 * @remarks Persistence and dispatch run in a background task whose failures are handled here rather than returned.
 * If that task fails while a handler is active, its error is recorded on that attempt and its operation is released
 * so the handler can settle before retry ownership changes; otherwise the attempt is failed immediately.
 */
export function enqueueStorageEvent(
    state: StorageEventState,
    event: FileEventItem,
    effects: StorageEventQueueEffects
): void {
    let barrierBefore: number | undefined;
    if (event.type === "DELETE" || event.type === "RENAME") {
        const sentinel = { type: TYPE_SENTINEL_FLUSH } as const;
        barrierBefore = retainFileEvent(state, sentinel).sequence;
        effects.buffer.append(sentinel);
    }
    const entry = retainFileEvent(state, event);
    const operation = entry.operation!;
    operation.barrierBefore ??= barrierBefore;
    effects.buffer.append(event);
    const attempt = operation.attempt;
    effects.updateStatus();
    fireAndForget(async () => {
        try {
            await (effects.persistEntry?.(entry) ?? effects.takeSnapshot());
            await effects.runQueuedEvents();
        } catch (error) {
            if (attempt.started && !attempt.result) {
                attempt.admissionFailure ??= { error };
                effects.release([operation]);
            } else effects.fail(operation, error, attempt);
        }
    });
}

/**
 * Merge attempts registered by in-flight admissions into an existing flush boundary.
 * @param boundary - The operation-to-attempt map already captured by the flush.
 * @param admissions - Admissions whose completion may have added operations after initial capture.
 * @returns Nothing; adds only operations absent from the boundary.
 * @remarks An attempt already captured remains authoritative, preserving the caller's original ownership snapshot.
 */
function mergeAdmittedAttempts(
    boundary: Map<PendingFileEvent, FileEventAttempt>,
    admissions: readonly EventAdmission[]
): void {
    for (const admission of admissions) {
        for (const [operation, attempt] of admission.operations) {
            if (!boundary.has(operation)) boundary.set(operation, attempt);
        }
    }
}

/**
 * Flush the finite set of operations and admissions visible at entry.
 * @param state - The manager state containing active admissions, retained operations, and the current failure sequence.
 * @param effects - Callbacks for capturing attempts, releasing gates, dispatching, waiting, and reporting failures.
 * @param loading - A pending initial load already requested at this flush boundary.
 * @returns A promise which settles after captured admissions and attempts; rejects with the first rejected admission
 * or, when admissions succeeded, the first failed operation result.
 * @remarks Flush intent is signalled before awaiting active admissions. Current buffered work is retained and batch
 * gates are released before the failure sequence is read for capture; attempts later registered by those admissions
 * are merged without replacing earlier captures. A load already in progress also contributes its restored
 * operations. Dispatch is then started in the background. Work admitted after the initial capture can remain
 * outside this finite wait.
 */
export async function flushStorageEvents(
    state: StorageEventState,
    effects: StorageEventQueueEffects,
    loading?: Promise<readonly PendingFileEvent[]>
): Promise<void> {
    const admissions = [...state.admissions];
    for (const admission of admissions) admission.flushRequested = true;
    if (!state.ordered) retainBufferedFileEvents(state, effects.buffer.read());
    const operations = pendingFileOperations(state);
    effects.release(operations);
    const boundary = effects.capture(operations, state.nextFailureSequence);
    if (loading) {
        // Include only the operations returned by this load. The shared queue may also contain later arrivals.
        for (const operation of await loading) {
            if (!boundary.has(operation)) boundary.set(operation, operation.attempt);
        }
        effects.release([...boundary.keys()]);
    }
    const admitted = await Promise.allSettled(admissions.map((admission) => admission.completion));
    mergeAdmittedAttempts(boundary, admissions);
    effects.release([...boundary.keys()]);
    fireAndForget(effects.runQueuedEvents().catch(effects.reportFailure));
    const results = await effects.wait(boundary);
    const failure = admitted.find((result) => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
    assertSuccessfulFileEvents(results);
}

/**
 * Shift and dispatch the host buffer in order, using sentinels as predecessor-only barriers.
 * @param state - The manager state which retains entries and resolves each sentinel sequence.
 * @param effects - Queue and processing callbacks used to wait, snapshot, and report failures.
 * @returns A promise which resolves after the buffer has been shifted and each sentinel's predecessor wait settles.
 * @remarks Ordinary handlers start in the background so later entries can be dispatched. A sentinel waits only
 * for earlier file operations to settle. Ordered storage then acknowledges the marker independently of those
 * outcomes. The legacy path requests a snapshot only after all captured predecessors succeeded. Errors during
 * acknowledgement or snapshotting are reported here. An ordered append failure leaves the marker in the queue
 * for retry and rejects dispatch.
 */
async function dispatchBufferedEvents(state: StorageEventState, effects: StorageEventQueueEffects): Promise<void> {
    while (effects.buffer.read().length > 0) {
        const next = effects.buffer.read()[0];
        if (next.type === TYPE_SENTINEL_FLUSH && effects.persistEntry) {
            // Leave the ordering marker pending if its append fails so dispatch can retry it.
            await effects.persistEntry(retainFileEvent(state, next));
        }
        const event = effects.buffer.shift()!;
        const entry = retainFileEvent(state, event);
        if (event.type === TYPE_SENTINEL_FLUSH) {
            entry.dispatched = true;
            // Capture predecessors only; self and successors must never enter this boundary.
            const results = await effects.wait(effects.capture(pendingFileOperations(state, entry.sequence)));
            if (effects.acknowledgeSentinel || results.every((result) => result.ok)) {
                try {
                    await (effects.acknowledgeSentinel?.(entry) ?? effects.takeSnapshot());
                } catch (error) {
                    effects.reportFailure(error);
                }
            }
        } else if (!entry.operation!.attempt.result) {
            fireAndForget(effects.processFileEvent(event).catch(() => {}));
        }
    }
}

/**
 * Share queue dispatch and optionally wait for the operations visible at call time.
 * @param state - The manager state providing retained operations and this manager's stable dispatch key.
 * @param effects - Queue, dispatch, and result-reporting callbacks.
 * @param options - Whether to wait for accepted attempts after buffer dispatch.
 * @returns A promise which resolves after dispatch and, when requested, after the captured attempts settle.
 * @remarks The accepted set is captured before joining the shared dispatcher, so later arrivals are not added to
 * the processing completion set. With waitForProcessing enabled, failed results are reported and do not themselves reject this promise.
 */
export async function runBufferedStorageEvents(
    state: StorageEventState,
    effects: StorageEventQueueEffects,
    options: RunQueuedEventsOptions = {}
): Promise<void> {
    if (!state.ordered) retainBufferedFileEvents(state, effects.buffer.read());
    const accepted = options.waitForProcessing ? pendingFileOperations(state) : undefined;
    await shareRunningResult(state.dispatchKey, () => dispatchBufferedEvents(state, effects));
    if (!accepted) return;
    const results = await effects.wait(effects.capture(accepted));
    // Ordered processing reports each failure when the attempt settles. Legacy replay reports at this boundary.
    if (state.ordered) return;
    for (const result of results) {
        if (result.ok === false) effects.reportFailure(result.error);
    }
}

/**
 * Load saved intents, replace the host buffer, and wait for restored operations to be processed.
 * @param effects - Snapshot, buffer, status, logging, and queue callbacks supplied by the host.
 * @returns A promise which resolves when restoration is empty or the restored queue has finished its captured work.
 * @remarks Restored file events are copied with reconciliation and batch-wait bypass markers; sentinels are retained
 * as-is. Empty snapshots only log and return. Load, buffer-replacement, and dispatcher errors propagate; ordinary
 * failed attempt results are reported by the queue callback.
 */
export async function restoreStorageEvents(effects: StorageEventQueueEffects): Promise<void> {
    const snapshot = await effects.loadSnapshot();
    if (!snapshot || !Array.isArray(snapshot) || snapshot.length === 0) {
        effects.log("No snapshot to restore", LOG_LEVEL_VERBOSE);
        return;
    }
    replayStorageEvents(effects, snapshot.map(markRestoredEvent));
    await effects.runQueuedEvents({ waitForProcessing: true });
}

/**
 * Register already committed arrays in replay order before exposing their events to dispatch.
 * @remarks Each array shares one remaining-entry count. The last acknowledgement removes its key. A partial
 * failure leaves the original array available for reconciliation by the next runtime.
 * @returns The restored file operations, which callers can include in a flush already in progress.
 */
export function restoreOrderedStorageEvents(
    state: StorageEventState,
    effects: StorageEventQueueEffects,
    buffers: readonly PendingStorageEventBuffer[]
): PendingFileEvent[] {
    const events: QueuedFileEvent[] = [];
    const operations: PendingFileEvent[] = [];
    for (const { key, events: saved } of buffers) {
        const buffer = { key, remaining: saved.length };
        for (const event of saved) {
            const restored = event.type === TYPE_SENTINEL_FLUSH ? { ...event } : markRestoredEvent(event);
            const entry = retainFileEvent(state, restored, true, buffer);
            events.push(restored);
            if (entry.operation) operations.push(entry.operation);
        }
    }
    // Reattach each marker to its delete or rename in the combined replay order. Entries already own their saved arrays.
    retainBufferedFileEvents(state, events);
    replayStorageEvents(effects, events);
    return operations;
}

function markRestoredEvent(event: QueuedFileEvent): QueuedFileEvent {
    return event.type === TYPE_SENTINEL_FLUSH
        ? event
        : { ...event, restoredFromPreviousRuntime: true, skipBatchWait: true };
}

function replayStorageEvents(effects: StorageEventQueueEffects, events: QueuedFileEvent[]): void {
    effects.log(`Restoring storage operation snapshot: ${events.length} items`, LOG_LEVEL_VERBOSE);
    effects.buffer.replace(events);
    effects.updateStatus();
}
