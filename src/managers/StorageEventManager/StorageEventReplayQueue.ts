import type { FileEventAttempt } from "./operations";
import type { PendingSnapshotEntry } from "./state";

/**
 * Schedule a restored prefix one sentinel-delimited segment at a time without scanning the full queue.
 * Operations within a segment become ready in linear O(N) time as their per-path predecessors settle.
 */
export class StorageEventReplayQueue {
    private cursor = 0;
    private readonly pending = new Set<PendingSnapshotEntry>();
    private ready: PendingSnapshotEntry[] = [];
    private nextReady = 0;

    /**
     * @param entries - Restored entries in durable snapshot order, including ordering sentinels.
     * @param wake - Callback invoked when a blocked operation's predecessor settles and it becomes ready.
     */
    constructor(
        private readonly entries: readonly PendingSnapshotEntry[],
        private readonly wake: () => void
    ) {}

    /** Whether any restored entry in the current segment or a later segment has not yet been taken. */
    get hasPending(): boolean {
        return this.pending.size > 0 || this.cursor < this.entries.length;
    }

    /** Whether a sentinel or subsequent segment still sits behind the currently loaded segment. */
    get hasBarrier(): boolean {
        return this.cursor < this.entries.length;
    }

    /** Return all entries not yet taken, preserving active segment entries ahead of later segments. */
    remaining(): PendingSnapshotEntry[] {
        return [...this.pending, ...this.entries.slice(this.cursor)];
    }

    private makeReadyWhenUnblocked(entry: PendingSnapshotEntry, notify = false): void {
        const blocker = unsettledPredecessor(entry);
        if (!blocker) {
            this.ready.push(entry);
            if (notify) this.wake();
            return;
        }
        // Each operation links to the previous operation for each of its paths.
        // Settlement wakes only the dependants on that link.
        void blocker.completion.promise.then(() => {
            if (!this.pending.has(entry)) return;
            this.makeReadyWhenUnblocked(entry, true);
        });
    }

    private loadSegment(): void {
        while (this.entries[this.cursor]?.operation) {
            const entry = this.entries[this.cursor++];
            this.pending.add(entry);
            this.makeReadyWhenUnblocked(entry);
        }
    }

    /** Inspect the next ready operation or leading sentinel without removing it from the replay queue. */
    peek(): PendingSnapshotEntry | undefined {
        if (this.pending.size === 0) {
            if (!this.entries[this.cursor]?.operation) return this.entries[this.cursor];
            this.loadSegment();
        }
        return this.ready[this.nextReady];
    }

    /**
     * Remove the entry previously returned by `peek()`.
     * For file operations, `entry` must be the current `peek()` head.
     */
    take(entry: PendingSnapshotEntry): void {
        if (entry.operation) {
            this.pending.delete(entry);
            this.nextReady++;
            if (this.nextReady === this.ready.length) {
                this.ready = [];
                this.nextReady = 0;
            }
        } else {
            this.cursor++;
        }
    }
}

function unsettledPredecessor(entry: PendingSnapshotEntry): FileEventAttempt | undefined {
    const operation = entry.operation;
    if (!operation || operation.initialised || operation.attempt.result) return undefined;
    for (const previous of operation.predecessors.values()) {
        if (!previous.attempt.result) return previous.attempt;
    }
    return undefined;
}
