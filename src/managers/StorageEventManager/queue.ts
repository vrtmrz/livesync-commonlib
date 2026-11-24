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
import { createOwnedResource } from "octagonal-wheels/resource";
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
    completeStoreRestore,
    installRestoredEntries,
    isAcceptingEvents,
    isManagerStopping,
    isStoreAcquired,
    isStoreRestoring,
    markSentinelDispatched,
    prepareRetainedEvent,
    pendingFileOperations,
    releaseDispatchSlot,
    retainBufferedFileEvents,
    retainFileEvent,
    tryAcquireDispatchSlot,
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
    dispatchQueuedEvent(event: FileEventItem, attempt: FileEventAttempt, releaseDispatchSlot: () => void): Promise<void>;
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
 * @remarks Persistence and dispatch run in a background task whose failures are handled here rather than returned.
 * If that task fails while a handler is active, its error is recorded on that attempt and its operation is released
 * so the handler can settle before retry ownership changes; otherwise the attempt is failed immediately.
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
 * @returns A promise which settles after captured admissions and attempts; rejects with the first rejected admission
 * or, when admissions succeeded, the first failed operation result.
 * @remarks Flush intent is signalled before awaiting active admissions. Current buffered work is retained and batch
 * gates are released before the failure sequence is read for capture; attempts later registered by those admissions
 * are merged without replacing earlier captures. Dispatch is then started in the background. Work admitted after the
 * initial admission snapshot can remain outside this finite wait.
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

/**
 * Reserve one dispatch window slot only for work that can advance towards a handler.
 * Returns an idempotent release function backed by `createOwnedResource`, or `undefined` if paused or stopping.
 */
export async function acquireStorageEventDispatchSlot(
    state: StorageEventState,
    limit: number,
    isPaused?: () => boolean
): Promise<(() => void) | undefined> {
    while (!isManagerStopping(state) && !isPaused?.()) {
        if (tryAcquireDispatchSlot(state, limit)) {
            const permit = createOwnedResource(undefined, () => releaseDispatchSlot(state));
            return () => void permit.dispose();
        }
        await state.dispatch.slotNotifier.wait();
    }
    return undefined;
}

function canDispatch(state: StorageEventState, effects: StorageEventQueueEffects): boolean {
    return !isManagerStopping(state) && isStoreAcquired(state) && !isStoreRestoring(state) && !effects.isDispatchPaused?.();
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

function dispatchOperation(
    effects: StorageEventQueueEffects,
    operation: PendingFileEvent,
    releaseSlot: () => void
): void {
    const attempt = operation.attempt;
    if (attempt.result || attempt.started) {
        releaseSlot();
        return;
    }
    fireAndForget(
        effects.dispatchQueuedEvent(operation.event, attempt, releaseSlot).finally(releaseSlot).catch(() => {})
    );
}

/** Dispatch ready operations up to the current window and process sentinels in order. */
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
        const releaseSlot = await acquireStorageEventDispatchSlot(state, state.dispatch.windowSize, effects.isDispatchPaused);
        if (!releaseSlot) return;
        dispatchAfterAcquiringSlot(state, effects, releaseSlot);
    }
}

function dispatchAfterAcquiringSlot(
    state: StorageEventState,
    effects: StorageEventQueueEffects,
    releaseSlot: () => void
): void {
    // Retry capture can remove the candidate while capacity is unavailable.
    const next = canDispatch(state, effects) ? nextDispatchCandidate(state, effects) : undefined;
    const operation = next?.entry.operation;
    if (!next || !operation) {
        releaseSlot();
        return;
    }
    next.take();
    dispatchOperation(effects, operation, releaseSlot);
}

async function dispatchUntilBlocked(state: StorageEventState, effects: StorageEventQueueEffects): Promise<void> {
    while (canDispatch(state, effects)) {
        await shareRunningResult(state.dispatch.key, () => dispatchBufferedEvents(state, effects));
        // An admission or dependency settlement can arrive as the shared run is exiting.
        if (!canDispatch(state, effects) || !nextDispatchCandidate(state, effects)) return;
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

function isOptionalPath(value: unknown): boolean {
    return value === undefined || typeof value === "string";
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
    return isFileStat(value.stat) || (type === "INTERNAL" && value.stat === undefined);
}

function isFileEventArgs(value: unknown, type: string): boolean {
    return (
        isRecord(value) &&
        isPersistedFile(value.file, type) &&
        isOptionalPath(value.oldPath) &&
        isOptionalPath(value.renameTarget)
    );
}

/** Validate one persisted event before it can enter in-memory state and attach runtime replay flags. */
function stageRestoredEvent(event: QueuedFileEvent, id?: string): RestoredSnapshotEvent {
    if (!isRecord(event)) throw new Error("Invalid persisted storage event");
    if (event.type === TYPE_SENTINEL_FLUSH) return { ...prepareRetainedEvent({ type: TYPE_SENTINEL_FLUSH }), id };
    if (
        !validFileEventTypes.has(event.type) ||
        typeof event.key !== "string" ||
        !event.key ||
        !isOptionalBoolean(event.cancelled) ||
        !isOptionalBoolean(event.batched) ||
        !isOptionalBoolean(event.skipBatchWait)
    ) {
        throw new Error("Invalid persisted storage event");
    }
    if (!isFileEventArgs(event.args, event.type)) throw new Error("Invalid persisted storage event");
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

/** Load and validate a whole store before claiming it and replaying its retained intents. */
export async function restoreStorageEvents(effects: StorageEventQueueEffects, state: StorageEventState): Promise<void> {
    const generation = state.persistence.storeGeneration;
    if (isStoreAcquired(state) || !canRestoreGeneration(state, generation)) return;
    const staged = await loadRestoredEventsUnlessStopped(effects, state, generation);
    if (!staged || !canRestoreGeneration(state, generation)) return;

    if (staged.length > 0) {
        effects.log(`Restoring storage operation snapshot: ${staged.length} items`, LOG_LEVEL_VERBOSE);
        installRestoredQueue(state, effects, staged);
    } else {
        effects.log("No snapshot to restore", LOG_LEVEL_VERBOSE);
    }
    completeStoreRestore(state, generation);

    if (staged.length > 0) {
        effects.updateStatus();
        await effects.runQueuedEvents({ waitForProcessing: true });
    } else if (generation > 0 && (state.dispatch.replayQueue?.hasPending || effects.buffer.read().length > 0)) {
        fireAndForget(effects.runQueuedEvents().catch(effects.reportFailure));
    }
}
