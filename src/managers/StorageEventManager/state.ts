/**
 * Per-manager in-memory ownership, admission, and ordering for retained file-event intent.
 * Snapshot writes are delegated to the snapshot module; these state transitions do not commit them.
 */
import type { FileEventItem, FilePath } from "@lib/common/types";
import {
    createFileEventAttempt,
    getFileEventPaths,
    type FileEventAttempt,
    type PendingFileEvent,
} from "./operations";

/** Queue marker which closes the ordered boundary before a delete or rename. */
export const TYPE_SENTINEL_FLUSH = "SENTINEL_FLUSH";
/** Queue shape for an ordering marker; it does not own a file operation. */
export type FileEventItemSentinel = { type: typeof TYPE_SENTINEL_FLUSH };
/** Items which can appear in the host buffer and durable event snapshot. */
export type QueuedFileEvent = FileEventItem | FileEventItemSentinel;

/** One in-flight admission and the operation attempts included in its completion boundary. */
export type EventAdmission = {
    /** Time captured when this admission began. */
    acceptedAt: number;
    /** Settles when the admission has finished registering or rejecting its events. */
    completion: Promise<void>;
    /** Attempts accepted by this admission, retained for a concurrent finite flush. */
    operations: Map<PendingFileEvent, FileEventAttempt>;
    /** Failure-sequence cutoff captured when the admission began. */
    failureBoundary: number;
    /** Whether a flush has captured this admission, including operations it registers later. */
    flushRequested: boolean;
};

/** Queue and persistence view of one event, optionally linked to its durable operation. */
export type PendingSnapshotEntry = {
    /** Event intent written to or restored from the existing snapshot format. */
    event: QueuedFileEvent;
    /** Stable insertion order within this manager's pending snapshot. */
    sequence: number;
    /** Provisional completion within a serial snapshot step; a failed save rolls it back. */
    completed: boolean;
    /** Durable operation for file events; sentinels have no operation. */
    operation?: PendingFileEvent;
    /** Whether a sentinel has passed through dispatch and may be acknowledged after its predecessors. */
    dispatched?: boolean;
};

/** Completion acknowledgement tied to both the retained entry and its exact attempt. */
export type SnapshotCompletion = { entry: PendingSnapshotEntry; attempt: FileEventAttempt };

/** Optional wait policy for a queue dispatch request. */
export type RunQueuedEventsOptions = { waitForProcessing?: boolean };

/** Mutable ownership, admission, and persistence state for one manager. */
export interface StorageEventState {
    /** Ordered intents still requiring durable acknowledgement. */
    pendingSnapshot: Map<QueuedFileEvent, PendingSnapshotEntry>;
    /** Event-object lookup used to preserve operation identity across repeated retention. */
    operations: WeakMap<FileEventItem, PendingFileEvent>;
    /** Latest unresolved operation touching each path. */
    latestByPath: Map<string, PendingFileEvent>;
    /** Monotonic counter incremented when a new event is retained. */
    nextSequence: number;
    /** Monotonic failure counter; its current value bounds a new retry request. */
    nextFailureSequence: number;
    /** Admission switch controlled by the owning manager's lifecycle. */
    acceptingEvents: boolean;
    /** Admissions in progress which a finite flush must account for. */
    admissions: Set<EventAdmission>;
    /** Serial tail for completion marking, snapshot saving, and rollback. */
    snapshotTail: Promise<void>;
    /** Stable key so concurrent dispatch calls for this manager share one run. */
    readonly dispatchKey: symbol;
}

/** Preserve the host's protected buffer, including replacement during restoration. */
export interface StorageEventBuffer {
    /** Read the current ordered buffer without taking ownership of its array. */
    read(): readonly QueuedFileEvent[];
    /** Replace the host buffer, including when restoration requires replacing its array. */
    replace(events: QueuedFileEvent[]): void;
    /** Append one event or sentinel at the current tail. */
    append(event: QueuedFileEvent): void;
    /** Remove and return the next queued item. */
    shift(): QueuedFileEvent | undefined;
}

/** Host notifications kept outside the state owner. */
export interface StorageEventNotifications {
    /** Refresh the host's view of pending local work. */
    updateStatus(): void;
    /** Report retained work without changing the result observed by its callers. */
    reportFailure(error: unknown): void;
}

/**
 * Create empty ownership state for one manager instance.
 * @returns Fresh maps, counters, admission tracking, and a resolved initial snapshot tail.
 * @remarks The state is isolated to one manager; no host callbacks or persistence are invoked here.
 */
export function createStorageEventState(): StorageEventState {
    return {
        pendingSnapshot: new Map(),
        operations: new WeakMap(),
        latestByPath: new Map(),
        nextSequence: 0,
        nextFailureSequence: 0,
        acceptingEvents: true,
        admissions: new Set(),
        snapshotTail: Promise.resolve(),
        dispatchKey: Symbol("storageEventDispatch"),
    };
}

/**
 * Register an operation in the per-path ordering index once.
 * @param state - The manager state whose latest-operation index is updated.
 * @param operation - The retained operation whose event paths are indexed.
 * @returns Nothing; on first registration, marks the operation and updates its path entries.
 * @remarks Each path records its previous latest operation as a predecessor when that attempt has not succeeded.
 * A failed predecessor remains relevant. The latest entry is replaced even when there is no predecessor to link;
 * subsequent calls are no-ops.
 */
function registerOperation(state: StorageEventState, operation: PendingFileEvent): void {
    if (operation.registered) return;
    operation.registered = true;
    for (const path of getFileEventPaths(operation.event)) {
        const previous = state.latestByPath.get(path);
        if (previous && !previous.attempt.result?.ok) operation.predecessors.set(path, previous);
        state.latestByPath.set(path, operation);
    }
}

/**
 * Retain an event once and reuse its durable operation when the same event is encountered again.
 * @param state - The manager state which owns the snapshot entry and event-to-operation identity map.
 * @param event - A file event or ordering sentinel to retain.
 * @param register - Whether a file operation should also enter the per-path ordering index.
 * @returns The existing entry for this event object, or the newly created entry.
 * @remarks Snapshot collection passes register as false for events surfaced by batch gates, so persistence
 * discovery cannot become their first path-indexing moment and change path ownership or ordering. The registered
 * flag independently prevents later duplicate indexing. Retention does not write a snapshot or start a handler;
 * a new operation captures the current failure sequence as its boundary.
 */
export function retainFileEvent(
    state: StorageEventState,
    event: QueuedFileEvent,
    register = true
): PendingSnapshotEntry {
    const existing = state.pendingSnapshot.get(event);
    if (existing) {
        if (register && existing.operation) registerOperation(state, existing.operation);
        return existing;
    }
    const entry: PendingSnapshotEntry = { event, sequence: ++state.nextSequence, completed: false };
    if (event.type !== TYPE_SENTINEL_FLUSH) {
        const operation = state.operations.get(event) ?? {
            event,
            sequence: entry.sequence,
            acceptedAt: Date.now(),
            attempt: createFileEventAttempt(),
            failureBoundary: state.nextFailureSequence,
            initialised: false,
            registered: false,
            predecessors: new Map<string, PendingFileEvent>(),
            prerequisites: new Set<PendingFileEvent>(),
            flushRequested: false,
        };
        entry.operation = operation;
        if (register) registerOperation(state, operation);
        state.operations.set(event, operation);
    }
    state.pendingSnapshot.set(event, entry);
    return entry;
}

/**
 * Retain buffered events in order and attach an adjacent sentinel to its delete or rename.
 * @param state - The manager state receiving entries and ordering barriers.
 * @param events - The current ordered host buffer; it is read-only and is not replaced here.
 * @returns Nothing; retained entries and any delete/rename barrier are updated in memory.
 * @remarks A sentinel applies to the next buffered file event only when that event is DELETE or RENAME.
 * This records the boundary for later dispatch; it does not persist the snapshot.
 */
export function retainBufferedFileEvents(state: StorageEventState, events: readonly QueuedFileEvent[]): void {
    let barrierBefore: number | undefined;
    for (const event of events) {
        const entry = retainFileEvent(state, event);
        if (event.type === TYPE_SENTINEL_FLUSH) barrierBefore = entry.sequence;
        else {
            if (event.type === "DELETE" || event.type === "RENAME") entry.operation!.barrierBefore ??= barrierBefore;
            barrierBefore = undefined;
        }
    }
}

/**
 * Select retained file operations before an exclusive sequence boundary.
 * @param state - The manager state whose retained entries are inspected.
 * @param before - The first excluded sequence; the default includes all retained operations.
 * @returns Operations whose entry sequence is strictly less than before, in snapshot insertion order.
 * @remarks Sentinels are excluded. The strict comparison lets a sentinel wait for predecessors without capturing
 * itself or later operations. This is a read-only selection and does not capture attempts or retry failures.
 */
export function pendingFileOperations(state: StorageEventState, before = Number.POSITIVE_INFINITY): PendingFileEvent[] {
    return [...state.pendingSnapshot.values()].flatMap((entry) =>
        entry.operation && entry.sequence < before ? [entry.operation] : []
    );
}

/**
 * Settle an attempt as failed once and assign its position in the manager's failure sequence.
 * @param state - The manager state which owns the monotonically increasing failure sequence.
 * @param attempt - The attempt whose completion promise may still be unsettled.
 * @param error - The failure observed by this attempt.
 * @returns True when this call records and resolves the failure; false when the attempt was already settled.
 * @remarks Only in-memory attempt state changes here. The durable operation remains retained, and no snapshot
 * write is performed.
 */
export function failFileEventAttempt(state: StorageEventState, attempt: FileEventAttempt, error: unknown): boolean {
    if (attempt.result) return false;
    attempt.result = { ok: false, error };
    attempt.failureSequence = ++state.nextFailureSequence;
    attempt.completion.resolve(attempt.result);
    return true;
}

/**
 * Settle a successful attempt and remove only path-index entries which it still owns.
 * @param state - The manager state whose latest-operation index may be cleared.
 * @param operation - The durable operation completed by this attempt.
 * @param attempt - The attempt whose handler completed and whose completion-snapshot step has settled.
 * @returns Nothing; records success and conditionally clears the operation's current path entries.
 * @remarks The caller must await the completion-snapshot step before calling this function; that step may be a
 * no-op if the entry or attempt has already been replaced. A newer operation or replacement attempt keeps its
 * index entries because both operation identity and current-attempt identity are checked. This function records
 * the in-memory result; it does not write or commit a snapshot.
 */
export function completeFileEventAttempt(
    state: StorageEventState,
    operation: PendingFileEvent,
    attempt: FileEventAttempt
): void {
    attempt.result = { ok: true };
    attempt.completion.resolve(attempt.result);
    for (const path of getFileEventPaths(operation.event)) {
        if (state.latestByPath.get(path) === operation && operation.attempt === attempt)
            state.latestByPath.delete(path);
    }
}

/**
 * Check whether unfinished retained intent covers a queried path.
 * @param state - The manager state containing retained snapshot entries.
 * @param filename - The queried path.
 * @returns True when an event path is the queried path or one of its ancestors; rename source and related paths
 * are both considered. False for completed entries, sentinels, or unrelated paths.
 * @remarks This is a read-only prefix check. It does not test whether the queried path is an ancestor of an event.
 */
export function hasPendingStorageEvent(state: StorageEventState, filename: FilePath): boolean {
    for (const entry of state.pendingSnapshot.values()) {
        if (entry.completed || entry.event.type === TYPE_SENTINEL_FLUSH) continue;
        if (
            getFileEventPaths(entry.event).some(
                (path) => path && (filename === path || filename.startsWith(`${path}/`))
            )
        )
            return true;
    }
    return false;
}
