/**
 * Per-manager in-memory ownership, admission, and ordering for retained file-event intent.
 * Snapshot writes are delegated to the snapshot module; these state transitions do not commit them.
 */
import type { FileEventItem, FilePath } from "@lib/common/types";
import type { PromiseWithResolvers } from "octagonal-wheels/promises";
import { createFileEventAttempt, getFileEventPaths, type FileEventAttempt, type PendingFileEvent } from "./operations";
import type { StorageEventReplayQueue } from "./StorageEventReplayQueue";

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
    /** Store-scoped durable ordering identifier, stable across retries. */
    id: string;
    /** Snapshot generation which first made this live intent dirty. */
    mutationVersion: number;
    /** Whether the intent is already durable in the current store. */
    persisted: boolean;
    /** Payload and path index captured when the intent was retained. */
    readonly persistedEvent: QueuedFileEvent;
    readonly indexedPaths: readonly string[];
    /** Event intent written to or restored from the existing snapshot format. */
    event: QueuedFileEvent;
    /** Stable insertion order within this manager's pending snapshot. */
    sequence: number;
    /** Completion marker for the legacy projection helper. The writer keeps provisional completions private. */
    completed: boolean;
    /** Durable operation for file events; sentinels have no operation. */
    operation?: PendingFileEvent;
    /** Whether a sentinel has passed through dispatch and may be acknowledged after its predecessors. */
    dispatched?: boolean;
    sentinelReplay?: PromiseWithResolvers<void>;
};

/** Completion acknowledgement tied to both the retained entry and its exact attempt. */
export type SnapshotCompletion = { entry: PendingSnapshotEntry; attempt: FileEventAttempt };

/** Detached persistence work; mutations arriving during its I/O belong to a later batch. */
export type PendingSnapshotBatch = {
    completions: Array<{ completion: SnapshotCompletion; waiter: PromiseWithResolvers<void> }>;
    waiters: PromiseWithResolvers<void>[];
    requiredMutationVersion: number;
};

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
    storeGeneration: number;
    nextRecordSequence: bigint;
    storeAcquired: boolean;
    restoreFailure?: { error: unknown };
    snapshotMutationVersion: number;
    persistedMutationVersion: number;
    hasPersisted: boolean;
    pendingOperationCount: number;
    pendingPathCounts: Map<string, number>;
    dirtyUpserts: Set<PendingSnapshotEntry>;
    committedEntryIds: Set<string>;
    activeRecordIds: Set<string>;
    pendingBatch: PendingSnapshotBatch | null;
    snapshotWriterRunning: boolean;
    stopping: boolean;
    stopped: boolean;
    inFlightOperations: Set<Promise<void>>;
    restorePromise: Promise<void> | null;
    restorePending: boolean;
    restoreStoreGeneration: number | null;
    replayQueue?: StorageEventReplayQueue;
    activeDispatchSlots: number;
    dispatchSlotWakeSignal: PromiseWithResolvers<void> | null;
    dispatchWindowSize: number;
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
        storeGeneration: 0,
        nextRecordSequence: 0n,
        storeAcquired: false,
        snapshotMutationVersion: 0,
        persistedMutationVersion: 0,
        hasPersisted: false,
        pendingOperationCount: 0,
        pendingPathCounts: new Map(),
        dirtyUpserts: new Set(),
        committedEntryIds: new Set(),
        activeRecordIds: new Set(),
        pendingBatch: null,
        snapshotWriterRunning: false,
        stopping: false,
        stopped: false,
        inFlightOperations: new Set(),
        restorePromise: null,
        restorePending: false,
        restoreStoreGeneration: null,
        activeDispatchSlots: 0,
        dispatchSlotWakeSignal: null,
        dispatchWindowSize: 5,
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
    for (const path of operation.indexedPaths) {
        const previous = state.latestByPath.get(path);
        if (previous && !previous.attempt.result?.ok) operation.predecessors.set(path, previous);
        state.latestByPath.set(path, operation);
    }
}

/** Rebuild path ownership after restored intents are prepended to live entries. */
export function rebuildLatestOperations(state: StorageEventState): void {
    state.latestByPath.clear();
    for (const entry of state.pendingSnapshot.values()) {
        const operation = entry.operation;
        if (!operation) continue;
        if (!operation.initialised) {
            operation.registered = false;
            operation.predecessors.clear();
            registerOperation(state, operation);
        } else {
            for (const path of operation.indexedPaths) state.latestByPath.set(path, operation);
        }
    }
}

function clonePersistenceContext(ctx: unknown): unknown {
    if (ctx === null || ctx === undefined || typeof ctx !== "object") return ctx;
    if (typeof structuredClone === "function") {
        try {
            return structuredClone(ctx);
        } catch {
            // Forward non-structured-cloneable host context verbatim for the host's adapter.
        }
    }
    return ctx;
}

/** Capture durable intent independently of the live object sent to handlers. */
export function sanitiseEventForPersistence(event: QueuedFileEvent): QueuedFileEvent {
    if (event.type === TYPE_SENTINEL_FLUSH) return { type: TYPE_SENTINEL_FLUSH };
    const { restoredFromPreviousRuntime: _restored, skipBatchWait: _skip, args, ...rest } = event;
    const { oldPath, renameTarget, ctx } = args;
    const file = { ...args.file };
    if (file.stat) file.stat = { ...file.stat };
    const persistedArgs: FileEventItem["args"] = { file };
    if (oldPath !== undefined) persistedArgs.oldPath = oldPath;
    if (renameTarget !== undefined) persistedArgs.renameTarget = renameTarget;
    const persistedContext = clonePersistenceContext(ctx);
    if (persistedContext !== undefined) persistedArgs.ctx = persistedContext;
    return { ...rest, args: persistedArgs };
}

export function prepareRetainedEvent(event: QueuedFileEvent) {
    const persistedEvent = sanitiseEventForPersistence(event);
    const indexedPaths = persistedEvent.type === TYPE_SENTINEL_FLUSH ? [] : getFileEventPaths(persistedEvent);
    return { event, persistedEvent, indexedPaths };
}

export function allocateStorageEventRecordId(state: StorageEventState): string {
    let id: string;
    do {
        id = String(++state.nextRecordSequence).padStart(12, "0");
    } while (state.activeRecordIds.has(id) || state.committedEntryIds.has(id));
    return id;
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
    return installRetainedEvent(state, prepareRetainedEvent(event), register);
}

/** Install a prepared entry after its payload and durable ID have been checked. */
export function installRetainedEvent(
    state: StorageEventState,
    prepared: ReturnType<typeof prepareRetainedEvent>,
    register: boolean,
    restoredId?: string,
    restored = false
): PendingSnapshotEntry {
    const { event, indexedPaths } = prepared;
    const entry: PendingSnapshotEntry = {
        ...prepared,
        id: restoredId ?? allocateStorageEventRecordId(state),
        mutationVersion: restored ? 0 : ++state.snapshotMutationVersion,
        persisted: restored,
        sequence: ++state.nextSequence,
        completed: false,
    };
    if (event.type !== TYPE_SENTINEL_FLUSH) {
        const operation = state.operations.get(event) ?? {
            event,
            indexedPaths,
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
        state.pendingOperationCount++;
        for (const path of indexedPaths) {
            state.pendingPathCounts.set(path, (state.pendingPathCounts.get(path) ?? 0) + 1);
        }
    }
    state.pendingSnapshot.set(event, entry);
    state.activeRecordIds.add(entry.id);
    if (restored) state.committedEntryIds.add(entry.id);
    else state.dirtyUpserts.add(entry);
    return entry;
}

/** Remove one still-owned entry and update its O(1) pending indexes. */
export function removePendingEntry(state: StorageEventState, entry: PendingSnapshotEntry): void {
    if (state.pendingSnapshot.get(entry.event) !== entry) return;
    state.pendingSnapshot.delete(entry.event);
    state.activeRecordIds.delete(entry.id);
    if (entry.operation) {
        state.pendingOperationCount = Math.max(0, state.pendingOperationCount - 1);
        for (const path of entry.indexedPaths) {
            const count = state.pendingPathCounts.get(path) ?? 0;
            if (count <= 1) state.pendingPathCounts.delete(path);
            else state.pendingPathCounts.set(path, count - 1);
        }
    }
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
    const operations: PendingFileEvent[] = [];
    for (const entry of state.pendingSnapshot.values()) {
        if (entry.sequence >= before) break;
        if (entry.operation) operations.push(entry.operation);
    }
    return operations;
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
    for (const path of operation.indexedPaths) {
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
    let prefix: string = filename;
    while (prefix) {
        if ((state.pendingPathCounts.get(prefix) ?? 0) > 0) return true;
        const slash = prefix.lastIndexOf("/");
        if (slash < 0) break;
        prefix = prefix.slice(0, slash);
    }
    return false;
}
