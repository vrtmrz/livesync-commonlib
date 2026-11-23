/** Coalesce durable event-intent writes while keeping provisional completion private to the writer. */
import type { FileEventItem } from "@lib/common/types";
import { promiseWithResolvers, type PromiseWithResolvers } from "octagonal-wheels/promises";
import { assertFileEventAdmission } from "./operations";
import {
    removePendingEntry,
    retainBufferedFileEvents,
    retainFileEvent,
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
    save(events: QueuedFileEvent[]): Promise<void>;
    waitingEvents(): Iterable<FileEventItem>;
    updateStatus(): void;
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

function nextBatch(state: StorageEventState): PendingSnapshotBatch | null {
    const batch = state.pendingBatch;
    state.pendingBatch = null;
    return batch;
}

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

type SnapshotWritePlan = {
    storeGeneration: number;
    mutationVersion: number;
    completed: Set<PendingSnapshotEntry>;
    upserts: PendingSnapshotEntry[];
};

/** Detach the exact mutations covered by this batch before calling the persistence adapter. */
function planSnapshotWrite(state: StorageEventState, batch: PendingSnapshotBatch): SnapshotWritePlan | undefined {
    const storeGeneration = state.storeGeneration;
    const mutationVersion = state.snapshotMutationVersion;
    const completed = collectCompletions(state, batch);
    if (completed.size === 0 && batch.waiters.length === 0) return;
    for (const sentinel of collectAcknowledgeableSentinels(state, completed)) completed.add(sentinel);
    const upserts = [...state.dirtyUpserts].filter((entry) => isCurrentEntry(state, entry) && !completed.has(entry));
    if (
        completed.size === 0 &&
        upserts.length === 0 &&
        state.hasPersisted &&
        state.persistedMutationVersion >= batch.requiredMutationVersion
    ) return;
    return { storeGeneration, mutationVersion, completed, upserts };
}

async function persistSnapshotPlan(state: StorageEventState, io: StorageEventSnapshotIO, plan: SnapshotWritePlan) {
    if (io.applyDelta) {
        const upsert: StorageEventSnapshotRecord[] = plan.upserts.map(({ id, persistedEvent }) => ({
            id,
            event: persistedEvent,
        }));
        const remove = [...plan.completed].filter(({ id }) => state.committedEntryIds.has(id)).map(({ id }) => id);
        if (upsert.length || remove.length) await io.applyDelta({ upsert, remove });
        return;
    }
    const snapshot: QueuedFileEvent[] = [];
    for (const entry of state.pendingSnapshot.values()) {
        if (!plan.completed.has(entry)) snapshot.push(entry.persistedEvent);
    }
    await io.save(snapshot);
}

function commitSnapshotPlan(state: StorageEventState, plan: SnapshotWritePlan): void {
    if (state.storeGeneration !== plan.storeGeneration) {
        throw new Error("Storage event store changed during persistence");
    }
    for (const entry of plan.upserts) {
        if (!isCurrentEntry(state, entry)) continue;
        entry.persisted = true;
        state.committedEntryIds.add(entry.id);
        if (entry.mutationVersion <= plan.mutationVersion) state.dirtyUpserts.delete(entry);
    }
    for (const entry of plan.completed) {
        removePendingEntry(state, entry);
        state.dirtyUpserts.delete(entry);
        state.committedEntryIds.delete(entry.id);
    }
    state.hasPersisted = true;
    state.persistedMutationVersion = Math.max(state.persistedMutationVersion, plan.mutationVersion);
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
        if (!state.storeAcquired) {
            if (state.restoreFailure) throw state.restoreFailure.error;
            throw new Error("Storage event store has not been acquired");
        }
        const plan = planSnapshotWrite(state, batch);
        if (plan) {
            await persistSnapshotPlan(state, io, plan);
            commitSnapshotPlan(state, plan);
        }
        for (const waiter of batchWaiters(batch)) waiter.resolve();
        if (plan) notifySnapshotCommitted(io);
    } catch (error) {
        rejectBatchWaiters(batch, error);
    }
}

async function runWriter(state: StorageEventState, io: StorageEventSnapshotIO): Promise<void> {
    while (state.pendingBatch) {
        const batch = nextBatch(state)!;
        await writeBatch(state, batch, io);
    }
}

function kickSnapshotWriter(state: StorageEventState, io: StorageEventSnapshotIO): void {
    if (state.snapshotWriterRunning || state.stopped || !state.pendingBatch) return;
    state.snapshotWriterRunning = true;
    const writer = state.snapshotTail.then(() => runWriter(state, io));
    state.snapshotTail = writer
        .catch(() => {})
        .finally(() => {
            state.snapshotWriterRunning = false;
            kickSnapshotWriter(state, io);
        });
}

/** Reject requests queued for a store which has been replaced. */
export function invalidatePendingSnapshotBatch(state: StorageEventState): void {
    const batch = nextBatch(state);
    if (batch)
        rejectBatchWaiters(batch, new Error("Storage event store changed during persistence"));
}

/** Retain intent, join the current generation batch, and run a serial coalescing writer. */
export async function persistFileEventSnapshot(
    state: StorageEventState,
    buffer: StorageEventBuffer,
    io: StorageEventSnapshotIO,
    completion?: SnapshotCompletion,
    requiredMutationVersion?: number
): Promise<void> {
    if (state.stopped) return;
    if (!completion && requiredMutationVersion === undefined) {
        retainBufferedFileEvents(state, buffer.read());
        for (const event of io.waitingEvents()) retainFileEvent(state, event, false);
    }
    const waiter = promiseWithResolvers<void>();
    state.pendingBatch ??= createBatch(requiredMutationVersion ?? state.snapshotMutationVersion);
    state.pendingBatch.requiredMutationVersion = Math.max(
        state.pendingBatch.requiredMutationVersion,
        requiredMutationVersion ?? state.snapshotMutationVersion
    );
    if (completion) state.pendingBatch.completions.push({ completion, waiter });
    else state.pendingBatch.waiters.push(waiter);
    kickSnapshotWriter(state, io);
    await waiter.promise;
}
