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
    type FileEventAttempt,
    type OperationResult,
    type PendingFileEvent,
    isStoppedResult,
} from "./operations";
import {
    TYPE_SENTINEL_FLUSH,
    allocateStorageEventRecordId,
    installRetainedEvent,
    prepareRetainedEvent,
    pendingFileOperations,
    rebuildLatestOperations,
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
    loadSnapshotEntries?(): Promise<readonly StorageEventSnapshotRecord[] | null>;
    incrementalMode?: boolean;
    restoreLoaded?(): void;
    /** Enter the host event-processing route for one file event. */
    dispatchQueuedEvent(event: FileEventItem, attempt: FileEventAttempt, releaseDispatchSlot: () => void): Promise<void>;
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
    isDispatchPaused?(): boolean;
    dispatchWindowSize?(): number;
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
    if (!state.acceptingEvents || state.stopping || state.stopped) return;
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
    const generation = state.storeGeneration;
    const persistence = effects.takeSnapshot(operationEntry.mutationVersion);
    attempt.admissionPersistence = persistence;
    attempt.admissionPersistenceStoreGeneration = generation;
    fireAndForget(async () => {
        try {
            await persistence;
        } catch (error) {
            if (state.storeGeneration !== generation) return;
            if (attempt.started && !attempt.result) {
                attempt.admissionFailure ??= { error };
                effects.release([operation]);
            } else {
                effects.fail(operation, error, attempt);
            }
            return;
        }
        if (!state.stopping && !state.stopped) await effects.runQueuedEvents().catch(effects.reportFailure);
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
    if (state.stopping || state.stopped) {
        await Promise.allSettled(admissions.map((admission) => admission.completion));
        const attempts = effects.capture(pendingFileOperations(state), -1);
        await Promise.allSettled([
            ...state.inFlightOperations,
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
    if (state.stopping || state.stopped) {
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

/** Reserve capacity only for work that can advance towards a handler. */
export async function acquireStorageEventDispatchSlot(
    state: StorageEventState,
    limit: number,
    isPaused?: () => boolean
): Promise<(() => void) | undefined> {
    while (!state.stopping && !state.stopped && !isPaused?.()) {
        if (state.activeDispatchSlots < limit) {
            state.activeDispatchSlots++;
            let released = false;
            return () => {
                if (released) return;
                released = true;
                state.activeDispatchSlots--;
                state.dispatchSlotWakeSignal?.resolve();
                state.dispatchSlotWakeSignal = null;
            };
        }
        state.dispatchSlotWakeSignal ??= promiseWithResolvers<void>();
        await state.dispatchSlotWakeSignal.promise;
    }
    return undefined;
}

function canDispatch(state: StorageEventState, effects: StorageEventQueueEffects): boolean {
    return !state.stopping && !state.stopped && state.storeAcquired && !state.restorePending && !effects.isDispatchPaused?.();
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
        if (event.type === TYPE_SENTINEL_FLUSH) return index === 0 && !state.replayQueue?.hasPending ? 0 : -1;
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

async function dispatchSentinelEntry(
    state: StorageEventState,
    effects: StorageEventQueueEffects,
    entry: PendingSnapshotEntry
): Promise<void> {
    if (!entry.dispatched) {
        entry.dispatched = true;
        state.snapshotMutationVersion++;
    }
    try {
        const results = await effects.wait(effects.capture(pendingFileOperations(state, entry.sequence)));
        if (!state.stopping && !state.stopped && results.every((result) => result.ok)) {
            await effects.takeSnapshot(state.snapshotMutationVersion);
        }
    } catch (error) {
        effects.reportFailure(error);
    } finally {
        entry.sentinelReplay?.resolve();
    }
}

type DispatchCandidate = { entry: PendingSnapshotEntry; take(): void };

function nextDispatchCandidate(state: StorageEventState, effects: StorageEventQueueEffects): DispatchCandidate | undefined {
    const replay = state.replayQueue;
    if (replay?.hasPending) {
        const entry = replay.peek();
        if (entry) return { entry, take: () => replay.take(entry) };
        if (replay.hasBarrier) return undefined;
    } else {
        state.replayQueue = undefined;
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
    state.dispatchWindowSize = effects.dispatchWindowSize?.() ?? state.dispatchWindowSize;
    while (canDispatch(state, effects)) {
        const next = nextDispatchCandidate(state, effects);
        if (!next) return;
        if (!next.entry.operation) {
            next.take();
            await dispatchSentinelEntry(state, effects, next.entry);
            continue;
        }
        const releaseSlot = await acquireStorageEventDispatchSlot(state, state.dispatchWindowSize, effects.isDispatchPaused);
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
        await shareRunningResult(state.dispatchKey, () => dispatchBufferedEvents(state, effects));
        // An admission or dependency settlement can arrive as the shared run is exiting.
        if (!canDispatch(state, effects) || !nextDispatchCandidate(state, effects)) return;
    }
}

function captureReplaySentinels(state: StorageEventState): Promise<void>[] {
    const sentinels: Promise<void>[] = [];
    if (state.stopping || state.stopped) return sentinels;
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
    const [results] = await Promise.race([replay, dispatch.then(() => replay)]);
    for (const result of results) {
        if (result.ok === false && !isStoppedResult(result)) effects.reportFailure(result.error);
    }
}

type RestoredEvent = ReturnType<typeof prepareRetainedEvent> & { id?: string };
const validFileEventTypes = new Set<string>(["CREATE", "CHANGED", "DELETE", "RENAME", "INTERNAL"]);

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOptionalPath(value: unknown): boolean {
    return value === undefined || typeof value === "string";
}

function isFileStat(value: unknown): boolean {
    return isRecord(value) && value.type === "file" &&
        Number.isFinite(value.ctime) && Number.isFinite(value.mtime) && Number.isFinite(value.size);
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
    return isRecord(value) &&
        isPersistedFile(value.file, type) &&
        isOptionalPath(value.oldPath) &&
        isOptionalPath(value.renameTarget);
}

function stageRestoredEvent(event: QueuedFileEvent, id?: string): RestoredEvent {
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

function stageIncrementalRecords(
    records: readonly StorageEventSnapshotRecord[],
    committed: ReadonlySet<string>
): RestoredEvent[] {
    const ids = new Set<string>();
    const staged: RestoredEvent[] = [];
    for (let index = 0; index < records.length; index++) {
        const record = records[index];
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

async function loadRestoredEvents(effects: StorageEventQueueEffects, state: StorageEventState): Promise<RestoredEvent[]> {
    if (effects.incrementalMode) {
        const records = await effects.loadSnapshotEntries!();
        if (records === null) return [];
        if (!Array.isArray(records)) throw new Error("Invalid storage event records");
        return stageIncrementalRecords(records, state.committedEntryIds);
    }
    const snapshot = await effects.loadSnapshot();
    if (snapshot === null) return [];
    if (!Array.isArray(snapshot)) throw new Error("Invalid storage event snapshot");
    const staged: RestoredEvent[] = [];
    for (let index = 0; index < snapshot.length; index++) {
        if (!Object.prototype.hasOwnProperty.call(snapshot, index))
            throw new Error("Invalid storage event snapshot: sparse array");
        staged.push(stageRestoredEvent(snapshot[index]));
    }
    return staged;
}

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

function installRestoredEntries(state: StorageEventState, staged: readonly RestoredEvent[], incremental: boolean): PendingSnapshotEntry[] {
    const live = [...state.pendingSnapshot.values()];
    // Reassign uncommitted live IDs after claiming restored IDs in this store.
    const reassign = incremental ? live.filter((entry) => !entry.persisted) : [];
    for (const entry of reassign) state.activeRecordIds.delete(entry.id);
    const restored = staged.map((entry) => installRetainedEvent(state, entry, true, entry.id, true));
    retainBufferedFileEvents(state, restored.map(({ event }) => event));
    for (const entry of reassign) {
        entry.id = allocateStorageEventRecordId(state);
        state.activeRecordIds.add(entry.id);
    }
    if (live.length > 0) orderRestoredEntries(state, restored, live);
    return restored;
}

function installRestoredQueue(
    state: StorageEventState,
    effects: StorageEventQueueEffects,
    staged: readonly RestoredEvent[]
): void {
    const restored = installRestoredEntries(state, staged, effects.incrementalMode === true);
    const entries = [...restored, ...(state.replayQueue?.remaining() ?? [])];
    const replay = new StorageEventReplayQueue(entries, () => {
        if (state.replayQueue === replay && canDispatch(state, effects)) {
            fireAndForget(effects.runQueuedEvents().catch(effects.reportFailure));
        }
    });
    state.replayQueue = replay;
}

function canRestoreGeneration(state: StorageEventState, generation: number): boolean {
    return !state.stopping && !state.stopped && state.storeGeneration === generation;
}

async function loadRestoredEventsUnlessStopped(
    effects: StorageEventQueueEffects,
    state: StorageEventState,
    generation: number
): Promise<RestoredEvent[] | undefined> {
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
    const generation = state.storeGeneration;
    if (state.storeAcquired || !canRestoreGeneration(state, generation)) return;
    const staged = await loadRestoredEventsUnlessStopped(effects, state, generation);
    if (!staged || !canRestoreGeneration(state, generation)) return;

    if (staged.length > 0) {
        effects.log(`Restoring storage operation snapshot: ${staged.length} items`, LOG_LEVEL_VERBOSE);
        installRestoredQueue(state, effects, staged);
    } else {
        effects.log("No snapshot to restore", LOG_LEVEL_VERBOSE);
    }
    state.hasPersisted = true;
    state.storeAcquired = true;
    state.restoreFailure = undefined;
    state.restorePending = false;
    effects.restoreLoaded?.();

    if (staged.length > 0) {
        effects.updateStatus();
        await effects.runQueuedEvents({ waitForProcessing: true });
    } else if (generation > 0 && (state.replayQueue?.hasPending || effects.buffer.read().length > 0)) {
        fireAndForget(effects.runQueuedEvents().catch(effects.reportFailure));
    }
}
