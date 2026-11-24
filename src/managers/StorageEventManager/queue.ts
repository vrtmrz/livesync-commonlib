/**
 * Coordinate buffer admission, finite flushes, sentinel dispatch, and snapshot restoration.
 * Attempt processing and persistence remain delegated through explicit host effects.
 */
import type { FileEventItem } from "@lib/common/types";
import { LOG_LEVEL_VERBOSE } from "@lib/common/types";
import { fireAndForget } from "@lib/common/utils";
import type { LogFunction } from "@lib/services/lib/logUtils";
import { shareRunningResult } from "octagonal-wheels/concurrency/lock";
import { promiseWithResolvers } from "octagonal-wheels/promises";
import {
    assertSuccessfulFileEvents,
    isFailedResult,
    recordAdmissionPersistence,
    type FileEventAttempt,
    type OperationResult,
    type PendingFileEvent,
} from "./operations";
import {
    TYPE_SENTINEL_FLUSH,
    installRestoredEntries,
    isAcceptingEvents,
    isManagerStopping,
    isStoreLoaded,
    markSentinelDispatched,
    prepareRetainedEvent,
    pendingFileOperations,
    retainBufferedFileEvents,
    retainFileEvent,
    type EventAdmission,
    type PendingSnapshotEntry,
    type QueuedFileEvent,
    type RestoredSnapshotEvent,
    type RunQueuedEventsOptions,
    type StorageEventBuffer,
    type StorageEventNotifications,
    type StorageEventState,
} from "./state";
import { StorageEventReplayQueue } from "./StorageEventReplayQueue";
import type { StorageEventSnapshotRecord } from "../adapters/IStorageEventPersistenceAdapter";

/** Host callbacks used by queue ownership, dispatch, finite flush, and restoration. */
export interface StorageEventQueueEffects extends StorageEventNotifications {
    /** Host-owned event buffer used by admission, dispatch, and retry. */
    readonly buffer: StorageEventBuffer;
    /** Host logger for restoration diagnostics. */
    log: LogFunction;
    /** Persist the current intent snapshot. */
    takeSnapshot(requiredMutationVersion?: number): Promise<void>;
    /** Load the prior runtime's saved event intent, if any. */
    loadSnapshot(): Promise<QueuedFileEvent[] | null>;
    /** Load ordered incremental snapshot records when incremental persistence is active. */
    loadSnapshotEntries?(): Promise<readonly StorageEventSnapshotRecord[] | null>;
    /** Whether the manager selected incremental persistence at construction. */
    incrementalMode?: boolean;
    /** Enter the host event-processing route for one file event. */
    dispatchQueuedEvent(event: FileEventItem, attempt: FileEventAttempt): Promise<void>;
    /** Whether an event currently owns an active batch wait gate. */
    isWaiting?(event: FileEventItem): boolean;
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
    /** Whether new file-handler dispatch is currently paused. */
    isDispatchPaused?(): boolean;
    /** Resolve the live maximum dispatch window size. */
    dispatchWindowSize?(): number;
    /** Promise resolved synchronously when the manager enters orderly shutdown. */
    stopSignal?: Promise<void>;
}

/**
 * Append an accepted event and schedule its snapshot and queue dispatch.
 * @param state - The manager state which owns the retained intent and operation attempt.
 * @param event - The accepted file event to enqueue.
 * @param effects - Host buffer, persistence, dispatch, status, and failure callbacks.
 * @returns Nothing; appends a sentinel before DELETE/RENAME, appends the event, and refreshes status synchronously.
 */
export function enqueueStorageEvent(
    state: StorageEventState,
    event: FileEventItem,
    effects: StorageEventQueueEffects
): void {
    if (!isAcceptingEvents(state)) return;
    let barrierBefore: number | undefined;
    if (event.type === "DELETE" || event.type === "RENAME") {
        const sentinel = { type: TYPE_SENTINEL_FLUSH } as const;
        barrierBefore = retainFileEvent(state, sentinel).sequence;
        effects.buffer.append(sentinel);
    }
    const operationEntry = retainFileEvent(state, event);
    const operation = operationEntry.operation!;
    operation.barrierBefore ??= barrierBefore;
    effects.buffer.append(event);
    const attempt = operation.attempt;
    effects.updateStatus();
    const generation = state.persistence.storeGeneration;
    const persistence = effects.takeSnapshot(operationEntry.mutationVersion);
    recordAdmissionPersistence(attempt, persistence, generation);
    fireAndForget(async () => {
        try {
            await persistence;
        } catch (error) {
            if (state.persistence.storeGeneration !== generation) return;
            if (attempt.started && !attempt.result) {
                attempt.admissionFailure ??= { error };
                effects.release([operation]);
            } else {
                effects.fail(operation, error, attempt);
            }
            return;
        }
        if (!isManagerStopping(state)) await effects.runQueuedEvents().catch(effects.reportFailure);
    });
}

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
 * @returns A promise which settles after captured admissions and attempts; rejects with the first rejected admission
 * or, when admissions succeeded, the first failed operation result.
 */
export async function flushStorageEvents(state: StorageEventState, effects: StorageEventQueueEffects): Promise<void> {
    const admissions = [...state.admissions];
    if (isManagerStopping(state)) {
        await Promise.allSettled(admissions.map((admission) => admission.completion));
        const attempts = effects.capture(pendingFileOperations(state), -1);
        await Promise.allSettled([
            ...state.dispatch.inFlightOperations,
            ...Array.from(attempts.values(), (attempt) => attempt.completion.promise),
        ]);
        return;
    }
    for (const admission of admissions) admission.flushRequested = true;
    retainBufferedFileEvents(state, effects.buffer.read());
    const operations = pendingFileOperations(state);
    effects.release(operations);
    const boundary = effects.capture(operations, state.nextFailureSequence);
    const admitted = await Promise.allSettled(admissions.map((admission) => admission.completion));
    mergeAdmittedAttempts(boundary, admissions);
    if (isManagerStopping(state)) {
        await Promise.all([...boundary.values()].map((attempt) => attempt.completion.promise));
        return;
    }
    effects.release([...boundary.keys()]);
    fireAndForget(effects.runQueuedEvents().catch(effects.reportFailure));
    const results = await effects.wait(boundary);
    const failure = admitted.find((result) => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
    assertSuccessfulFileEvents(results);
}

function canDispatch(state: StorageEventState, effects: StorageEventQueueEffects): boolean {
    return !isManagerStopping(state) && isStoreLoaded(state) && !effects.isDispatchPaused?.();
}

function activeDispatchedCount(state: StorageEventState, effects: StorageEventQueueEffects): number {
    let active = 0;
    for (const operation of state.dispatch.dispatched) {
        if (operation.attempt.result || operation.attempt.successor || effects.isWaiting?.(operation.event)) continue;
        active++;
    }
    return active;
}

function canDispatchOperation(effects: StorageEventQueueEffects, operation: PendingFileEvent): boolean {
    if (operation.attempt.result || operation.initialised) return true;
    for (const previous of operation.predecessors.values()) {
        if (!previous.attempt.result && !effects.isWaiting?.(previous.event)) return false;
    }
    return true;
}

/** Find ready work before the next sentinel, leaving path dependants in the buffer until they can advance. */
function nextDispatchIndex(state: StorageEventState, effects: StorageEventQueueEffects): number {
    const buffer = effects.buffer.read();
    for (let index = 0; index < buffer.length; index++) {
        const event = buffer[index];
        // A live sentinel can only run after earlier buffered items and the restored replay prefix have drained.
        if (event.type === TYPE_SENTINEL_FLUSH) return index === 0 && !state.dispatch.replayQueue?.hasPending ? 0 : -1;
        const operation = retainFileEvent(state, event).operation!;
        if (canDispatchOperation(effects, operation)) return index;
    }
    return -1;
}

function takeBufferedEvent(buffer: StorageEventBuffer, index: number): QueuedFileEvent | undefined {
    if (index === 0) return buffer.shift();
    const events = [...buffer.read()];
    const [event] = events.splice(index, 1);
    buffer.replace(events);
    return event;
}

/** Mark a sentinel dispatched, wait for all strictly earlier operations to settle, and acknowledge it if all succeeded. */
async function dispatchSentinelEntry(
    state: StorageEventState,
    effects: StorageEventQueueEffects,
    entry: PendingSnapshotEntry
): Promise<void> {
    markSentinelDispatched(state, entry);
    try {
        const results = await effects.wait(effects.capture(pendingFileOperations(state, entry.sequence)));
        if (!isManagerStopping(state) && results.every((result) => result.ok)) {
            await effects.takeSnapshot(state.persistence.mutationVersion);
        }
    } catch (error) {
        effects.reportFailure(error);
    } finally {
        entry.sentinelReplay?.resolve();
    }
}

type DispatchCandidate = { entry: PendingSnapshotEntry; take(): void };

function nextDispatchCandidate(state: StorageEventState, effects: StorageEventQueueEffects): DispatchCandidate | undefined {
    const replay = state.dispatch.replayQueue;
    if (replay?.hasPending) {
        const entry = replay.peek();
        if (entry) return { entry, take: () => replay.take(entry) };
        if (replay.hasBarrier) return undefined;
    } else {
        state.dispatch.replayQueue = undefined;
    }
    const index = nextDispatchIndex(state, effects);
    if (index < 0) return undefined;
    const entry = retainFileEvent(state, effects.buffer.read()[index]);
    return { entry, take: () => takeBufferedEvent(effects.buffer, index) };
}

function hasPendingQueueItems(state: StorageEventState, effects: StorageEventQueueEffects): boolean {
    return Boolean(state.dispatch.replayQueue?.hasPending || effects.buffer.read().length > 0);
}

function dispatchOperation(
    state: StorageEventState,
    effects: StorageEventQueueEffects,
    operation: PendingFileEvent
): void {
    const attempt = operation.attempt;
    if (attempt.result || attempt.started) return;
    state.dispatch.dispatched.add(operation);
    fireAndForget(
        effects
            .dispatchQueuedEvent(operation.event, attempt)
            .catch(() => {})
            .finally(() => {
                state.dispatch.dispatched.delete(operation);
                if (canDispatch(state, effects) && hasPendingQueueItems(state, effects)) {
                    fireAndForget(effects.runQueuedEvents().catch(effects.reportFailure));
                }
            })
    );
}

/** Pump ready operations up to the current window and process sentinels in order. */
async function dispatchBufferedEvents(state: StorageEventState, effects: StorageEventQueueEffects): Promise<void> {
    state.dispatch.windowSize = effects.dispatchWindowSize?.() ?? state.dispatch.windowSize;
    while (canDispatch(state, effects)) {
        const next = nextDispatchCandidate(state, effects);
        if (!next) return;
        if (!next.entry.operation) {
            next.take();
            await dispatchSentinelEntry(state, effects, next.entry);
            continue;
        }
        if (activeDispatchedCount(state, effects) >= state.dispatch.windowSize) return;
        next.take();
        dispatchOperation(state, effects, next.entry.operation);
    }
}

async function dispatchUntilBlocked(state: StorageEventState, effects: StorageEventQueueEffects): Promise<void> {
    while (canDispatch(state, effects)) {
        await shareRunningResult(state.dispatch.key, () => dispatchBufferedEvents(state, effects));
        if (!canDispatch(state, effects)) return;
        const next = nextDispatchCandidate(state, effects);
        if (!next) return;
        if (next.entry.operation && activeDispatchedCount(state, effects) >= state.dispatch.windowSize) return;
    }
}

function captureReplaySentinels(state: StorageEventState): Promise<void>[] {
    const sentinels: Promise<void>[] = [];
    if (isManagerStopping(state)) return sentinels;
    for (const entry of state.pendingSnapshot.values()) {
        if (entry.operation || entry.dispatched) continue;
        entry.sentinelReplay ??= promiseWithResolvers<void>();
        sentinels.push(entry.sentinelReplay.promise);
    }
    return sentinels;
}

/** Dispatch buffered work and optionally wait for only the attempts and sentinels visible at entry. */
export async function runBufferedStorageEvents(
    state: StorageEventState,
    effects: StorageEventQueueEffects,
    options: RunQueuedEventsOptions = {}
): Promise<void> {
    if (!options.waitForProcessing) return dispatchUntilBlocked(state, effects);
    retainBufferedFileEvents(state, effects.buffer.read());
    const captured = effects.capture(pendingFileOperations(state));
    const replay = Promise.all([effects.wait(captured), ...captureReplaySentinels(state)]);
    const dispatch = dispatchUntilBlocked(state, effects);
    // Propagate dispatch failures immediately while allowing replay to finish without waiting on later admissions.
    const [results] = await Promise.race([replay, dispatch.then(() => replay)]);
    for (const result of results) {
        if (isFailedResult(result)) effects.reportFailure(result.error);
    }
}

const validFileEventTypes = new Set<string>(["CREATE", "CHANGED", "DELETE", "RENAME", "INTERNAL"]);

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFileStat(value: unknown): boolean {
    return (
        isRecord(value) &&
        value.type === "file" &&
        Number.isFinite(value.ctime) &&
        Number.isFinite(value.mtime) &&
        Number.isFinite(value.size)
    );
}

function isOptionalBoolean(value: unknown): boolean {
    return value === undefined || typeof value === "boolean";
}

function isPersistedFile(value: unknown, type: string): boolean {
    if (!isRecord(value) || typeof value.path !== "string" || !value.path || typeof value.name !== "string") {
        return false;
    }
    if (value.isFolder !== undefined && value.isFolder !== false) return false;
    if (!isOptionalBoolean(value.isInternal) || !isOptionalBoolean(value.deleted)) return false;
    return isFileStat(value.stat) || ((type === "INTERNAL" || value.isInternal === true) && value.stat === undefined);
}

/** Validate the structural invariants of one persisted event before it enters in-memory state. */
function stageRestoredEvent(event: QueuedFileEvent, id?: string): RestoredSnapshotEvent {
    if (!isRecord(event)) throw new Error("Invalid persisted storage event");
    if (event.type === TYPE_SENTINEL_FLUSH) return { ...prepareRetainedEvent({ type: TYPE_SENTINEL_FLUSH }), id };
    if (
        !validFileEventTypes.has(event.type) ||
        typeof event.key !== "string" ||
        !event.key ||
        !isOptionalBoolean(event.cancelled) ||
        !isOptionalBoolean(event.batched) ||
        !isOptionalBoolean(event.skipBatchWait) ||
        !isRecord(event.args) ||
        !isPersistedFile(event.args.file, event.type) ||
        (event.args.oldPath !== undefined && typeof event.args.oldPath !== "string") ||
        (event.args.renameTarget !== undefined && typeof event.args.renameTarget !== "string")
    ) {
        throw new Error("Invalid persisted storage event");
    }
    return { ...prepareRetainedEvent({ ...event, restoredFromPreviousRuntime: true, skipBatchWait: true }), id };
}

/** Validate all incremental records (rejecting sparse slots, duplicate IDs, and malformed events) before claiming store ownership. */
function stageIncrementalRecords(
    records: readonly StorageEventSnapshotRecord[],
    committed: ReadonlySet<string>
): RestoredSnapshotEvent[] {
    const ids = new Set<string>();
    const staged: RestoredSnapshotEvent[] = [];
    for (let index = 0; index < records.length; index++) {
        const record = records[index];
        // Use hasOwnProperty.call rather than Object.hasOwn for Safari/WebKit 15.0-15.3 compatibility.
        if (!Object.prototype.hasOwnProperty.call(records, index) || !isRecord(record))
            throw new Error("Invalid storage event record");
        const id = record.id;
        if (typeof id !== "string" || !id) throw new Error("Invalid storage event record id");
        if (ids.has(id)) throw new Error(`Duplicate storage event record id: ${id}`);
        ids.add(id);
        const entry = stageRestoredEvent(record.event, id);
        if (!committed.has(id)) staged.push(entry);
    }
    return staged;
}

async function loadRestoredEvents(
    effects: StorageEventQueueEffects,
    state: StorageEventState
): Promise<RestoredSnapshotEvent[]> {
    if (effects.incrementalMode) {
        const records = await effects.loadSnapshotEntries!();
        if (records === null) return [];
        if (!Array.isArray(records)) throw new Error("Invalid storage event records");
        return stageIncrementalRecords(records, state.persistence.committedEntryIds);
    }
    const snapshot = await effects.loadSnapshot();
    if (snapshot === null) return [];
    if (!Array.isArray(snapshot)) throw new Error("Invalid storage event snapshot");
    const staged: RestoredSnapshotEvent[] = [];
    for (let index = 0; index < snapshot.length; index++) {
        if (!Object.prototype.hasOwnProperty.call(snapshot, index))
            throw new Error("Invalid storage event snapshot: sparse array");
        staged.push(stageRestoredEvent(snapshot[index]));
    }
    return staged;
}

function installRestoredQueue(
    state: StorageEventState,
    effects: StorageEventQueueEffects,
    staged: readonly RestoredSnapshotEvent[]
): void {
    const restored = installRestoredEntries(state, staged, effects.incrementalMode === true);
    const entries = [...restored, ...(state.dispatch.replayQueue?.remaining() ?? [])];
    const replay = new StorageEventReplayQueue(entries, () => {
        if (state.dispatch.replayQueue === replay && canDispatch(state, effects)) {
            fireAndForget(effects.runQueuedEvents().catch(effects.reportFailure));
        }
    });
    state.dispatch.replayQueue = replay;
}

function canRestoreGeneration(state: StorageEventState, generation: number): boolean {
    return !isManagerStopping(state) && state.persistence.storeGeneration === generation;
}

async function loadRestoredEventsUnlessStopped(
    effects: StorageEventQueueEffects,
    state: StorageEventState,
    generation: number
): Promise<RestoredSnapshotEvent[] | undefined> {
    const pendingLoad = loadRestoredEvents(effects, state);
    if (!effects.stopSignal) return await pendingLoad;
    // Prevent an unhandled rejection if the underlying store closes after stop settles the caller.
    void pendingLoad.catch(() => {});
    try {
        return await Promise.race([pendingLoad, effects.stopSignal.then((): undefined => undefined)]);
    } catch (error) {
        if (!canRestoreGeneration(state, generation)) return undefined;
        throw error;
    }
}

/**
 * Load and validate the active store generation once before claiming ownership and installing restored entries.
 * @returns The number of restored entries installed, or `-1` if aborted by stop or store replacement.
 */
export async function loadStorageEventStore(
    effects: StorageEventQueueEffects,
    state: StorageEventState,
    generation: number
): Promise<number> {
    if (state.persistence.storeLoaded || !canRestoreGeneration(state, generation)) return -1;
    const staged = await loadRestoredEventsUnlessStopped(effects, state, generation);
    if (!staged || !canRestoreGeneration(state, generation)) return -1;

    effects.log(
        staged.length > 0 ? `Restoring storage operation snapshot: ${staged.length} items` : "No snapshot to restore",
        LOG_LEVEL_VERBOSE
    );
    if (!canRestoreGeneration(state, generation)) return -1;
    if (staged.length > 0) installRestoredQueue(state, effects, staged);
    state.persistence.storeLoaded = true;
    state.persistence.hasPersisted = true;
    if (staged.length > 0) effects.updateStatus();
    return staged.length;
}
