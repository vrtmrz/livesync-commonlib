import type { FileEventAttempt } from "./operations";
import type { PendingSnapshotEntry } from "./state";

/** Schedule a restored prefix one sentinel-delimited segment at a time. */
export class StorageEventReplayQueue {
    private cursor = 0;
    private readonly pending = new Set<PendingSnapshotEntry>();
    private ready: PendingSnapshotEntry[] = [];
    private nextReady = 0;

    constructor(
        private readonly entries: readonly PendingSnapshotEntry[],
        private readonly wake: () => void
    ) {}

    get hasPending(): boolean {
        return this.pending.size > 0 || this.cursor < this.entries.length;
    }

    get hasBarrier(): boolean {
        return this.cursor < this.entries.length;
    }

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

    peek(): PendingSnapshotEntry | undefined {
        if (this.pending.size === 0) {
            if (!this.entries[this.cursor]?.operation) return this.entries[this.cursor];
            this.loadSegment();
        }
        return this.ready[this.nextReady];
    }

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
