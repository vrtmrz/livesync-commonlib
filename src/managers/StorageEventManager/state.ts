/**
 * Per-manager in-memory ownership, admission, lifecycle, and persistence state for retained file-event intent.
 * Snapshot writes are delegated to the snapshot module; these state transitions update in-memory invariants atomically.
 */
import type { FileEventItem, FilePath } from "@lib/common/types";
import type { PromiseWithResolvers } from "octagonal-wheels/promises";
import {
    createFileEventAttempt,
    getFileEventPaths,
    stopFileEventAttempt,
    type CapturedError,
    type FileEventAttempt,
    type PendingFileEvent,
} from "./operations";
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
    /** Sanitised payload captured when the intent was retained. */
    readonly persistedEvent: QueuedFileEvent;
    /** Immutable retention-time path list shared by pending-path counters and predecessor indexes. */
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
    /** Waiter resolved once a replayed sentinel has passed through dispatch. */
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

/** Monotonic manager lifecycle phase (`running` -> `stopping` -> `stopped`). */
export type StorageEventManagerLifecycle = "running" | "stopping" | "stopped";

/** Snapshot versioning, store-load state, dirty-set tracking, and serialised writer state for the active store generation. */
export type SnapshotPersistenceState = {
    /** Monotonically incremented each time the backing snapshot store is replaced. */
    storeGeneration: number;
    /** Whether the active store generation has been loaded before admitting durable writes. */
    storeLoaded: boolean;
    /** Single-flight initial store load promise for the active store generation, if in flight. */
    storeLoadPromise: Promise<void> | null;
    /** Last store-load error for the active generation; blocks implicit writes until an explicit retry or store reset. */
    storeLoadError?: CapturedError;
    /** Monotonic counter used to allocate store-scoped incremental record identifiers. */
    nextRecordSequence: bigint;
    /** Incremented whenever live intent or sentinel state requires a newer snapshot write. */
    mutationVersion: number;
    /** Highest `mutationVersion` confirmed durable in the active store generation. */
    persistedMutationVersion: number;
    /** Whether at least one load or write has established persistence state for the active generation. */
    hasPersisted: boolean;
    /** Live entries whose current intent has not yet been committed to the active store. */
    dirtyUpserts: Set<PendingSnapshotEntry>;
    /** Record IDs currently known to exist in the active incremental store. */
    committedEntryIds: Set<string>;
    /** Record IDs owned by currently pending in-memory entries. */
    activeRecordIds: Set<string>;
    /** Next coalesced batch waiting for the serial snapshot writer. */
    pendingBatch: PendingSnapshotBatch | null;
    /** Whether the serial snapshot writer loop is currently active. */
    writerRunning: boolean;
    /** Serial tail for completion marking, snapshot saving, and shutdown joining. */
    tail: Promise<void>;
};

/** Bounded dispatch-window and replay-scheduling state for one manager. */
export type DispatchWindowState = {
    /** Restored prefix queue drained one sentinel-delimited segment at a time. */
    replayQueue?: StorageEventReplayQueue;
    /** Operations currently dispatched from the queue and not yet settled. */
    dispatched: Set<PendingFileEvent>;
    /** Maximum concurrent non-waiting operations pumped from the queue at once. */
    windowSize: number;
    /** Promises for operations that have crossed the host handler start boundary. */
    inFlightOperations: Set<Promise<void>>;
    /** Stable lock key so concurrent dispatch calls for this manager share one run. */
    readonly key: symbol;
};

/** Mutable ownership, admission, dispatch, and persistence state for one manager. */
export interface StorageEventState {
    /** Monotonic manager lifecycle phase. */
    lifecycle: StorageEventManagerLifecycle;
    /** Snapshot mutation, store-load, dirty tracking, and serial writer state. */
    persistence: SnapshotPersistenceState;
    /** Bounded dispatch-window and in-flight handler tracking state. */
    dispatch: DispatchWindowState;
    /** Ordered intents still requiring durable acknowledgement. */
    pendingSnapshot: Map<QueuedFileEvent, PendingSnapshotEntry>;
    /** Event-object lookup used to preserve operation identity across repeated retention. */
    operations: WeakMap<FileEventItem, PendingFileEvent>;
    /** Latest unresolved operation touching each path. */
    latestByPath: Map<string, PendingFileEvent>;
    /** O(1) count of unfinished file operations in `pendingSnapshot`. */
    pendingOperationCount: number;
    /** O(1) reference count per indexed path across unfinished file operations. */
    pendingPathCounts: Map<string, number>;
    /** Monotonic counter incremented when a new event is retained. */
    nextSequence: number;
    /** Monotonic failure counter; its current value bounds a new retry request. */
    nextFailureSequence: number;
    /** Admissions in progress which a finite flush must account for. */
    admissions: Set<EventAdmission>;
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

/** Committed snapshot plan passed to `commitSnapshotWriteState`. */
export type CommittedSnapshotPlan = {
    readonly storeGeneration: number;
    readonly mutationVersion: number;
    readonly completed: ReadonlySet<PendingSnapshotEntry>;
    readonly upserts: readonly PendingSnapshotEntry[];
};

/**
 * Create empty ownership state for one manager instance.
 * @returns Fresh maps, counters, lifecycle state, and a resolved initial snapshot tail.
 * @remarks The state is isolated to one manager; no host callbacks or persistence are invoked here.
 */
export function createStorageEventState(): StorageEventState {
    return {
        lifecycle: "running",
        persistence: {
            storeGeneration: 0,
            storeLoaded: false,
            storeLoadPromise: null,
            nextRecordSequence: 0n,
            mutationVersion: 0,
            persistedMutationVersion: 0,
            hasPersisted: false,
            dirtyUpserts: new Set(),
            committedEntryIds: new Set(),
            activeRecordIds: new Set(),
            pendingBatch: null,
            writerRunning: false,
            tail: Promise.resolve(),
        },
        dispatch: {
            dispatched: new Set(),
            windowSize: 5,
            inFlightOperations: new Set(),
            key: Symbol("storageEventDispatch"),
        },
        pendingSnapshot: new Map(),
        operations: new WeakMap(),
        latestByPath: new Map(),
        pendingOperationCount: 0,
        pendingPathCounts: new Map(),
        nextSequence: 0,
        nextFailureSequence: 0,
        admissions: new Set(),
    };
}

/** Whether the manager still accepts new incoming watcher events. */
export function isAcceptingEvents(state: Readonly<StorageEventState>): boolean {
    return state.lifecycle === "running";
}

/** Whether the manager has entered or completed orderly shutdown (`stopping` or `stopped`). */
export function isManagerStopping(state: Readonly<StorageEventState>): boolean {
    return state.lifecycle !== "running";
}

/** Whether the manager has finished orderly shutdown and must not start further persistence work. */
export function isManagerStopped(state: Readonly<StorageEventState>): boolean {
    return state.lifecycle === "stopped";
}

/** Whether the active store generation has been loaded before committing writes. */
export function isStoreLoaded(state: Readonly<StorageEventState>): boolean {
    return state.persistence.storeLoaded;
}

/** Require that the active store generation has been loaded before committing snapshot I/O. */
export function assertStoreLoaded(state: Readonly<StorageEventState>): void {
    if (state.persistence.storeLoaded) return;
    if (state.persistence.storeLoadError) throw state.persistence.storeLoadError.error;
    throw new Error("Storage event store has not been acquired");
}

/** Invalidate store-scoped persistence metadata and re-mark all retained entries dirty for a replacement store. */
export function resetStorePersistenceState(state: StorageEventState): void {
    const persistence = state.persistence;
    persistence.storeGeneration++;
    persistence.storeLoaded = false;
    persistence.storeLoadPromise = null;
    persistence.storeLoadError = undefined;
    persistence.hasPersisted = false;
    persistence.persistedMutationVersion = 0;
    persistence.committedEntryIds.clear();
    persistence.nextRecordSequence = 0n;
    // Rebuild dirty order from admission order before the adapter assigns replacement sequences.
    persistence.dirtyUpserts.clear();
    for (const entry of state.pendingSnapshot.values()) {
        entry.persisted = false;
        if (entry.operation) {
            entry.operation.attempt.admissionPersistence = undefined;
            entry.operation.attempt.admissionPersistenceStoreGeneration = undefined;
            entry.operation.attempt.admissionFailure = undefined;
        }
        entry.sentinelReplay?.resolve();
        entry.sentinelReplay = undefined;
        entry.mutationVersion = ++persistence.mutationVersion;
        persistence.dirtyUpserts.add(entry);
    }
}

/** Settle all unstarted operation attempts as stopped while preserving their durable snapshot entries. */
export function stopUnstartedAttempts(state: StorageEventState): void {
    for (const entry of state.pendingSnapshot.values()) {
        const attempt = entry.operation?.attempt;
        if (attempt && !attempt.handlerStarted) stopFileEventAttempt(attempt);
    }
}

/**
 * Synchronously transition a running manager to `stopping`, signalling active optional providers and settling unstarted attempts.
 * @returns `true` on the first transition into `stopping`; `false` if shutdown was already underway or complete.
 */
export function beginStoppingState(state: StorageEventState): boolean {
    if (state.lifecycle !== "running") return false;
    state.lifecycle = "stopping";
    for (const entry of state.pendingSnapshot.values()) {
        entry.sentinelReplay?.resolve();
        const operation = entry.operation;
        if (!operation) continue;
        if (operation.attempt.handlerStarted) {
            operation.flushRequested = true;
            operation.flushSignal?.resolve();
        } else {
            stopFileEventAttempt(operation.attempt);
        }
    }
    return true;
}

/** Mark the manager permanently `stopped` after active handlers and final snapshot I/O have settled. */
export function markStoppedState(state: StorageEventState): void {
    state.lifecycle = "stopped";
    state.dispatch.dispatched.clear();
}

/** Mark a sentinel dispatched and advance the snapshot mutation version once. */
export function markSentinelDispatched(state: StorageEventState, entry: PendingSnapshotEntry): void {
    if (entry.dispatched) return;
    entry.dispatched = true;
    state.persistence.mutationVersion++;
}

/** Whether uncommitted dirty entries or a queued snapshot batch still require persistence. */
export function hasPendingSnapshotWork(state: Readonly<StorageEventState>): boolean {
    return state.persistence.dirtyUpserts.size > 0 || state.persistence.pendingBatch !== null;
}

/** Apply a durably committed snapshot write plan to in-memory persistence tracking. */
export function commitSnapshotWriteState(state: StorageEventState, plan: CommittedSnapshotPlan): void {
    if (state.persistence.storeGeneration !== plan.storeGeneration) {
        throw new Error("Storage event store changed during persistence");
    }
    for (const entry of plan.upserts) {
        if (state.pendingSnapshot.get(entry.event) !== entry) continue;
        entry.persisted = true;
        state.persistence.committedEntryIds.add(entry.id);
        if (entry.mutationVersion <= plan.mutationVersion) state.persistence.dirtyUpserts.delete(entry);
    }
    for (const entry of plan.completed) {
        removePendingEntry(state, entry);
        state.persistence.dirtyUpserts.delete(entry);
        state.persistence.committedEntryIds.delete(entry.id);
    }
    state.persistence.hasPersisted = true;
    state.persistence.persistedMutationVersion = Math.max(
        state.persistence.persistedMutationVersion,
        plan.mutationVersion
    );
}

/**
 * Register an operation in the per-path ordering index once.
 * @param state - The manager state whose latest-operation index is updated.
 * @param operation - The retained operation whose retention-time `indexedPaths` are indexed.
 * @returns Nothing; on first registration, marks the operation and updates its path entries.
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
function rebuildLatestOperations(state: StorageEventState): void {
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

/**
 * Produce a detached, minimal persisted copy of a queued event without mutating the live event.
 *
 * Strips runtime-only replay flags (`restoredFromPreviousRuntime`, `skipBatchWait`) and ephemeral
 * in-memory content caches (`args.cache`) so durable snapshots stay bounded and replay re-reads
 * current Vault bytes. Shallow-clones `args.file` and `args.file.stat`, and forwards opaque
 * `args.ctx` verbatim under the host-owned serialisability and immutability contract.
 */
export function sanitiseEventForPersistence(event: QueuedFileEvent): QueuedFileEvent {
    if (event.type === TYPE_SENTINEL_FLUSH) return { type: TYPE_SENTINEL_FLUSH };
    const { restoredFromPreviousRuntime: _restored, skipBatchWait: _skip, args, ...rest } = event;
    const { oldPath, renameTarget, ctx } = args;
    const file = { ...args.file };
    if (file.stat) file.stat = { ...file.stat };
    const persistedArgs: FileEventItem["args"] = { file };
    if (oldPath !== undefined) persistedArgs.oldPath = oldPath;
    if (renameTarget !== undefined) persistedArgs.renameTarget = renameTarget;
    if (ctx !== undefined) persistedArgs.ctx = ctx;
    return { ...rest, args: persistedArgs };
}

/** Detached durable payload and immutable ordering paths captured before installation. */
export type PreparedRetainedEvent = {
    readonly event: QueuedFileEvent;
    readonly persistedEvent: QueuedFileEvent;
    readonly indexedPaths: readonly string[];
};

/** Prepared event staged from durable storage with its optional store-scoped record identifier. */
export type RestoredSnapshotEvent = PreparedRetainedEvent & { readonly id?: string };

/** Capture the detached durable payload and immutable ordering paths for an event before installation. */
export function prepareRetainedEvent(event: QueuedFileEvent): PreparedRetainedEvent {
    const persistedEvent = sanitiseEventForPersistence(event);
    const indexedPaths = persistedEvent.type === TYPE_SENTINEL_FLUSH ? [] : getFileEventPaths(persistedEvent);
    return { event, persistedEvent, indexedPaths };
}

/** Allocate the next store-scoped record ID that does not collide with active or committed IDs. */
export function allocateStorageEventRecordId(state: StorageEventState): string {
    let id: string;
    do {
        id = String(++state.persistence.nextRecordSequence).padStart(12, "0");
    } while (state.persistence.activeRecordIds.has(id) || state.persistence.committedEntryIds.has(id));
    return id;
}

/**
 * Retain an event once and reuse its durable operation when the same event is encountered again.
 * @param state - The manager state which owns the snapshot entry and event-to-operation identity map.
 * @param event - A file event or ordering sentinel to retain.
 * @param register - Whether a file operation should also enter the per-path ordering index.
 * @returns The existing entry for this event object, or the newly created entry.
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
function installRetainedEvent(
    state: StorageEventState,
    prepared: PreparedRetainedEvent,
    register: boolean,
    restoredId?: string,
    restored = false
): PendingSnapshotEntry {
    const { event, indexedPaths } = prepared;
    const entry: PendingSnapshotEntry = {
        ...prepared,
        id: restoredId ?? allocateStorageEventRecordId(state),
        mutationVersion: restored ? 0 : ++state.persistence.mutationVersion,
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
    state.persistence.activeRecordIds.add(entry.id);
    if (restored) state.persistence.committedEntryIds.add(entry.id);
    else state.persistence.dirtyUpserts.add(entry);
    return entry;
}

/** Prepend restored entries ahead of any live admissions staged during load and renumber sequences/barriers. */
function orderRestoredEntries(
    state: StorageEventState,
    restored: readonly PendingSnapshotEntry[],
    live: readonly PendingSnapshotEntry[]
): void {
    const entries = [...restored, ...live];
    const newSequences = new Map(entries.map((entry, index) => [entry.sequence, index + 1]));
    state.pendingSnapshot.clear();
    for (const entry of entries) {
        entry.sequence = newSequences.get(entry.sequence)!;
        if (entry.operation) {
            entry.operation.sequence = entry.sequence;
            const barrier = entry.operation.barrierBefore;
            if (barrier !== undefined) entry.operation.barrierBefore = newSequences.get(barrier);
        }
        state.pendingSnapshot.set(entry.event, entry);
    }
    state.nextSequence = entries.length;
    rebuildLatestOperations(state);
}

/** Claim restored record IDs, reassign colliding uncommitted live IDs, and place restored intents before live entries. */
export function installRestoredEntries(
    state: StorageEventState,
    staged: readonly RestoredSnapshotEvent[],
    incremental: boolean
): PendingSnapshotEntry[] {
    const live = [...state.pendingSnapshot.values()];
    const reassign = incremental ? live.filter((entry) => !entry.persisted) : [];
    for (const entry of reassign) state.persistence.activeRecordIds.delete(entry.id);
    const restored = staged.map((entry) => installRetainedEvent(state, entry, true, entry.id, true));
    retainBufferedFileEvents(
        state,
        restored.map(({ event }) => event)
    );
    for (const entry of reassign) {
        entry.id = allocateStorageEventRecordId(state);
        state.persistence.activeRecordIds.add(entry.id);
    }
    if (live.length > 0) orderRestoredEntries(state, restored, live);
    return restored;
}

/** Remove one still-owned entry and update its O(1) pending indexes. */
export function removePendingEntry(state: StorageEventState, entry: PendingSnapshotEntry): void {
    if (state.pendingSnapshot.get(entry.event) !== entry) return;
    state.pendingSnapshot.delete(entry.event);
    state.persistence.activeRecordIds.delete(entry.id);
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
 * @returns True when an unacknowledged event path is the queried path or one of its ancestors; rename source and
 * related paths are both considered.
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
