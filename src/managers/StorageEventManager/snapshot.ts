/** Coalesce durable event-intent writes while keeping provisional completion private to the writer. */
import type { FileEventItem } from "@lib/common/types";
import { promiseWithResolvers, type PromiseWithResolvers } from "octagonal-wheels/promises";
import { assertFileEventAdmission } from "./operations";
import {
    assertStoreAcquired,
    commitSnapshotWriteState,
    isManagerStopped,
    retainBufferedFileEvents,
    retainFileEvent,
    type CommittedSnapshotPlan,
    type PendingSnapshotBatch,
    type PendingSnapshotEntry,
    type QueuedFileEvent,
    type SnapshotCompletion,
    type StorageEventBuffer,
    type StorageEventState,
} from "./state";
import type {
    StorageEventSnapshotDelta,
    StorageEventSnapshotRecord,
} from "../adapters/IStorageEventPersistenceAdapter";

export { sanitiseEventForPersistence } from "./state";

/** Persistence and status callbacks supplied by the owning manager. */
export interface StorageEventSnapshotIO {
    /** Persist a complete legacy event snapshot array. */
    save(events: QueuedFileEvent[]): Promise<void>;
    /** Enumerate events currently parked in batch waiting gates. */
    waitingEvents(): Iterable<FileEventItem>;
    /** Refresh the host's pending-operation status counters. */
    updateStatus(): void;
    /** Report a non-fatal status-refresh failure without rejecting committed persistence. */
    reportFailure(error: unknown): void;
    /** Present only when the manager selected incremental mode at construction. */
    applyDelta?(delta: StorageEventSnapshotDelta): Promise<void>;
}

/** Pure legacy projection retained for internal callers which inspect acknowledgement ordering. */
export function planFileEventSnapshot(entries: readonly PendingSnapshotEntry[]) {
    const completed: PendingSnapshotEntry[] = [];
    const snapshot: QueuedFileEvent[] = [];
    const sentinels: Array<{ entry: PendingSnapshotEntry; completed: boolean }> = [];
    let predecessorsCompleted = true;
    for (const entry of entries) {
        const acknowledged: boolean = entry.operation
            ? entry.completed
            : entry.dispatched === true && predecessorsCompleted;
        if (entry.operation) predecessorsCompleted &&= acknowledged;
        else sentinels.push({ entry, completed: acknowledged });
        if (acknowledged) completed.push(entry);
        else snapshot.push(entry.event);
    }
    return { completed, snapshot, sentinels };
}

function createBatch(requiredMutationVersion: number): PendingSnapshotBatch {
    return { completions: [], waiters: [], requiredMutationVersion };
}

function* batchWaiters(batch: PendingSnapshotBatch) {
    yield* batch.waiters;
    for (const { waiter } of batch.completions) yield waiter;
}

function rejectBatchWaiters(batch: PendingSnapshotBatch, error: unknown): void {
    for (const waiter of batchWaiters(batch)) waiter.reject(error);
}

/** Collect leading dispatched sentinels whose preceding operations are all provisionally complete. */
function collectAcknowledgeableSentinels(
    state: StorageEventState,
    provisionalCompletedEntries: Set<PendingSnapshotEntry>
): PendingSnapshotEntry[] {
    const sentinels: PendingSnapshotEntry[] = [];
    for (const entry of state.pendingSnapshot.values()) {
        if (entry.operation) {
            if (!provisionalCompletedEntries.has(entry)) break;
        } else {
            if (!entry.dispatched) break;
            sentinels.push(entry);
        }
    }
    return sentinels;
}

/** Detach the current coalesced batch so mutations arriving during I/O join a later batch. */
function takePendingBatch(state: StorageEventState): PendingSnapshotBatch | null {
    const batch = state.persistence.pendingBatch;
    state.persistence.pendingBatch = null;
    return batch;
}

/** Filter batch completions to still-owned attempts, immediately settling stale or admission-failed waiters. */
function collectCompletions(state: StorageEventState, batch: PendingSnapshotBatch): Set<PendingSnapshotEntry> {
    const completed = new Set<PendingSnapshotEntry>();
    for (const { completion: { entry, attempt }, waiter } of batch.completions) {
        try {
            assertFileEventAdmission(attempt);
        } catch (error) {
            waiter.reject(error);
            continue;
        }
        if (!isCurrentEntry(state, entry) || entry.operation?.attempt !== attempt) {
            waiter.resolve();
            continue;
        }
        completed.add(entry);
    }
    return completed;
}

function isCurrentEntry(state: StorageEventState, entry: PendingSnapshotEntry): boolean {
    return state.pendingSnapshot.get(entry.event) === entry;
}

/** Detach the exact mutations covered by this batch before calling the persistence adapter. */
function planSnapshotWrite(state: StorageEventState, batch: PendingSnapshotBatch): CommittedSnapshotPlan | undefined {
    const persistence = state.persistence;
    const storeGeneration = persistence.storeGeneration;
    const mutationVersion = persistence.mutationVersion;
    const completed = collectCompletions(state, batch);
    if (completed.size === 0 && batch.waiters.length === 0) return;
    for (const sentinel of collectAcknowledgeableSentinels(state, completed)) completed.add(sentinel);
    const upserts = [...persistence.dirtyUpserts].filter((entry) => isCurrentEntry(state, entry) && !completed.has(entry));
    if (
        completed.size === 0 &&
        upserts.length === 0 &&
        persistence.hasPersisted &&
        persistence.persistedMutationVersion >= batch.requiredMutationVersion
    ) {
        return;
    }
    return { storeGeneration, mutationVersion, completed, upserts };
}

/** Submit either an incremental delta or a full-array snapshot without mutating live state. */
async function persistSnapshotPlan(
    state: StorageEventState,
    io: StorageEventSnapshotIO,
    plan: CommittedSnapshotPlan
): Promise<void> {
    if (io.applyDelta) {
        const upsert: StorageEventSnapshotRecord[] = plan.upserts.map(({ id, persistedEvent }) => ({
            id,
            event: persistedEvent,
        }));
        const remove = [...plan.completed]
            .filter(({ id }) => state.persistence.committedEntryIds.has(id))
            .map(({ id }) => id);
        if (upsert.length || remove.length) await io.applyDelta({ upsert, remove });
        return;
    }
    const snapshot: QueuedFileEvent[] = [];
    for (const entry of state.pendingSnapshot.values()) {
        if (!plan.completed.has(entry)) snapshot.push(entry.persistedEvent);
    }
    await io.save(snapshot);
}

function notifySnapshotCommitted(io: StorageEventSnapshotIO): void {
    try {
        io.updateStatus();
    } catch (error) {
        io.reportFailure(error);
    }
}

async function writeBatch(
    state: StorageEventState,
    batch: PendingSnapshotBatch,
    io: StorageEventSnapshotIO
): Promise<void> {
    try {
        assertStoreAcquired(state);
        const plan = planSnapshotWrite(state, batch);
        if (plan) {
            await persistSnapshotPlan(state, io, plan);
            commitSnapshotWriteState(state, plan);
        }
        for (const waiter of batchWaiters(batch)) waiter.resolve();
        if (plan) notifySnapshotCommitted(io);
    } catch (error) {
        rejectBatchWaiters(batch, error);
    }
}

async function runWriter(state: StorageEventState, io: StorageEventSnapshotIO): Promise<void> {
    while (state.persistence.pendingBatch) {
        const batch = takePendingBatch(state)!;
        await writeBatch(state, batch, io);
    }
}

/** Ensure one serial writer loop drains queued batches onto `state.persistence.tail`. */
function kickSnapshotWriter(state: StorageEventState, io: StorageEventSnapshotIO): void {
    const persistence = state.persistence;
    if (persistence.writerRunning || isManagerStopped(state) || !persistence.pendingBatch) return;
    persistence.writerRunning = true;
    const writer = persistence.tail.then(() => runWriter(state, io));
    persistence.tail = writer
        .catch(() => {})
        .finally(() => {
            persistence.writerRunning = false;
            kickSnapshotWriter(state, io);
        });
}

/** Reject requests queued for a store which has been replaced. */
export function invalidatePendingSnapshotBatch(state: StorageEventState): void {
    const batch = takePendingBatch(state);
    if (batch) rejectBatchWaiters(batch, new Error("Storage event store changed during persistence"));
}

/** Join the next pending persistence batch with the requested minimum mutation version and optional completion. */
function enqueueSnapshotBatchRequest(
    state: StorageEventState,
    targetVersion: number,
    waiter: PromiseWithResolvers<void>,
    completion?: SnapshotCompletion
): void {
    const batch = (state.persistence.pendingBatch ??= createBatch(targetVersion));
    batch.requiredMutationVersion = Math.max(batch.requiredMutationVersion, targetVersion);
    if (completion) batch.completions.push({ completion, waiter });
    else batch.waiters.push(waiter);
}

/** Retain intent, join the current generation batch, and run a serial coalescing writer. */
export async function persistFileEventSnapshot(
    state: StorageEventState,
    buffer: StorageEventBuffer,
    io: StorageEventSnapshotIO,
    completion?: SnapshotCompletion,
    requiredMutationVersion?: number
): Promise<void> {
    if (isManagerStopped(state)) return;
    // Unversioned manual or throttled writes sweep buffered and batch-waiting events;
    // versioned admissions and completions already retained their own entries.
    if (!completion && requiredMutationVersion === undefined) {
        retainBufferedFileEvents(state, buffer.read());
        for (const event of io.waitingEvents()) retainFileEvent(state, event, false);
    }
    const waiter = promiseWithResolvers<void>();
    enqueueSnapshotBatchRequest(
        state,
        requiredMutationVersion ?? state.persistence.mutationVersion,
        waiter,
        completion
    );
    kickSnapshotWriter(state, io);
    await waiter.promise;
}
