/**
 * Plan and serialise durable event-intent snapshots, including completion rollback on save failure.
 * The snapshot tail keeps provisional marking, save, rollback, and in-memory acknowledgement in one ordered step.
 */
import type { FileEventItem } from "@lib/common/types";
import { delay } from "@lib/common/utils";
import { assertFileEventAdmission } from "./operations";
import {
    retainBufferedFileEvents,
    retainFileEvent,
    type OrderedStorageEventState,
    type PendingSnapshotEntry,
    type QueuedFileEvent,
    type SnapshotCompletion,
    type StorageEventBuffer,
    type StorageEventState,
} from "./state";

/** Snapshot persistence and status callbacks supplied by the owning manager. */
export interface StorageEventSnapshotIO {
    /** Save the currently pending event intents using the existing snapshot format. */
    save(events: QueuedFileEvent[]): Promise<void>;
    /** Enumerate host-queued events not necessarily present in the visible event buffer. */
    waitingEvents(): Iterable<FileEventItem>;
    /** Refresh host status after a snapshot has been committed. */
    updateStatus(): void;
}

/**
 * Select pending intents and sentinel acknowledgements without mutating ownership or performing I/O.
 * @param entries - Snapshot entries in their retained insertion order.
 * @returns Entries eligible for removal after save, event intents to write, and sentinel completion marks to apply.
 * @remarks This is a pure plan. Operation completion flags are read as provisional state from the enclosing
 * serialised snapshot step; a sentinel is acknowledged only after dispatch and acknowledgement of every preceding
 * operation. This function neither changes entry state nor saves the returned snapshot.
 */
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

/**
 * Mark the exact retained entry and current attempt provisionally complete.
 * @param state - The manager state containing the current event entry.
 * @param completion - Optional entry/attempt pair to mark; omission means no operation completion is requested.
 * @returns True when saving may proceed, including when no completion was supplied; false for stale ownership.
 * @remarks This runs inside the snapshot tail. For a supplied completion, a successful match sets entry.completed
 * before I/O so the save plan can omit it; the caller must roll that mark back if saving fails. A recorded admission
 * failure throws before marking.
 */
function markCompletion(state: StorageEventState, completion?: SnapshotCompletion): boolean {
    if (!completion) return true;
    const { entry, attempt } = completion;
    assertFileEventAdmission(attempt);
    if (state.pendingSnapshot.get(entry.event) !== entry || entry.operation?.attempt !== attempt) return false;
    entry.completed = true;
    return true;
}

/**
 * Retain current intent and serialise its completion mark, save, and rollback on the manager's snapshot tail.
 * @param state - The manager state whose retained entries and snapshot tail are updated.
 * @param buffer - The visible host buffer whose events must be included in the durable intent.
 * @param io - Host persistence, waiting-event enumeration, and status callbacks.
 * @param completion - Optional exact entry/attempt whose completion should be included in this save.
 * @returns A promise which resolves after a successful save and in-memory acknowledgement, or after a stale
 * completion is ignored; rejects if admission checks, persistence, or the post-save status callback fails.
 * @remarks Visible-buffer events use normal path registration. Batch-waiting events are retained with registration
 * disabled so snapshot discovery cannot introduce path ordering. Completion marking, sentinel acknowledgement,
 * saving, failed-save rollback, entry removal, and status update are serialised as one tail step. The first save
 * keeps its microtask start. A failed save restores provisional completion before the next queued step and rejects
 * this caller; the caught tail allows later saves to proceed.
 */
export async function persistFileEventSnapshot(
    state: StorageEventState,
    buffer: StorageEventBuffer,
    io: StorageEventSnapshotIO,
    completion?: SnapshotCompletion
): Promise<void> {
    retainBufferedFileEvents(state, buffer.read());
    for (const event of io.waitingEvents()) retainFileEvent(state, event, false);
    // Preserve the original microtask start, including the first save.
    const save = state.snapshotTail.then(async () => {
        if (!markCompletion(state, completion)) return;
        const plan = planFileEventSnapshot([...state.pendingSnapshot.values()]);
        for (const sentinel of plan.sentinels) sentinel.entry.completed = sentinel.completed;
        try {
            await io.save(plan.snapshot);
        } catch (error) {
            // Roll back before the next queued save can observe completion.
            for (const entry of plan.completed) entry.completed = false;
            throw error;
        }
        for (const entry of plan.completed) {
            if (state.pendingSnapshot.get(entry.event) === entry) state.pendingSnapshot.delete(entry.event);
        }
        io.updateStatus();
    });
    state.snapshotTail = save.catch(() => {});
    await save;
}

const APPEND_YIELD_MS = 50;

function writeOrderedStore(state: StorageEventState, write: () => Promise<void>): Promise<void> {
    const done = state.snapshotTail.then(write);
    state.snapshotTail = done.catch(() => {});
    return done;
}

/** Save the next buffer, coalescing requests until the writer detaches it. */
export function appendPendingEventBuffer(state: StorageEventState, ordered: OrderedStorageEventState): Promise<void> {
    if (ordered.nextWrite) return ordered.nextWrite;
    if (ordered.nextBuffer.length === 0) return ordered.appendTail;

    const write = ordered.appendTail
        .catch(() => {})
        .then(async () => {
            if (ordered.appendFinishedAt !== undefined) {
                const remainingYield = APPEND_YIELD_MS - (Date.now() - ordered.appendFinishedAt);
                if (remainingYield > 0) await delay(remainingYield);
            }

            await writeOrderedStore(state, async () => {
                const entries = ordered.nextBuffer;
                ordered.nextBuffer = [];
                ordered.nextWrite = undefined;
                for (const entry of entries) entry.bufferWrite = write;

                try {
                    const key = await ordered.store.append(entries.map(({ event }) => event));
                    const buffer = { key, remaining: entries.length };
                    for (const entry of entries) entry.savedBuffer = buffer;
                } catch (error) {
                    // Keep the failed entries ahead of any arrivals during this write.
                    ordered.nextBuffer = entries.concat(ordered.nextBuffer);
                    throw error;
                } finally {
                    for (const entry of entries) entry.bufferWrite = undefined;
                    ordered.appendFinishedAt = Date.now();
                }
            });
        });
    ordered.nextWrite = write;
    ordered.appendTail = write;
    return write;
}

/** Wait only for the append that owns this entry. Restored entries are already durable. */
export function persistOrderedEntry(
    state: StorageEventState,
    ordered: OrderedStorageEventState,
    entry: PendingSnapshotEntry
): Promise<void> {
    if (entry.savedBuffer) return Promise.resolve();
    return entry.bufferWrite ?? appendPendingEventBuffer(state, ordered);
}

/** Acknowledge one entry in memory, deleting its buffer only when the last entry completes. */
export function acknowledgeOrderedEntry(
    state: StorageEventState,
    ordered: OrderedStorageEventState,
    entry: PendingSnapshotEntry,
    updateStatus: () => void,
    completion?: SnapshotCompletion
): Promise<void> {
    return writeOrderedStore(state, async () => {
        if (completion) assertFileEventAdmission(completion.attempt);
        if (state.pendingSnapshot.get(entry.event) !== entry) return;
        if (completion && entry.operation?.attempt !== completion.attempt) return;

        const buffer = entry.savedBuffer!;
        if (buffer.remaining === 1) await ordered.store.remove(buffer.key);
        buffer.remaining--;
        if (entry.operation) ordered.pendingOperations--;
        state.pendingSnapshot.delete(entry.event);
        updateStatus();
    });
}

/** Retire a saved buffer with no effects to replay. */
export function acknowledgeEmptyOrderedBuffer(
    state: StorageEventState,
    ordered: OrderedStorageEventState,
    key: string
): Promise<void> {
    return writeOrderedStore(state, () => ordered.store.remove(key));
}
