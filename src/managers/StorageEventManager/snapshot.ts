/**
 * Plan and serialise durable event-intent snapshots, including completion rollback on save failure.
 * The snapshot tail keeps provisional marking, save, rollback, and in-memory acknowledgement in one ordered step.
 */
import type { FileEventItem } from "@lib/common/types";
import { assertFileEventAdmission } from "./operations";
import {
    retainBufferedFileEvents,
    retainFileEvent,
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
