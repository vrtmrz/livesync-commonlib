import type { FileEventItem } from "@lib/common/types";
import type { FileEventItemSentinel } from "@lib/managers/StorageEventManager";
import type { QueuedFileEvent } from "@lib/managers/StorageEventManager/state";

/**
 * Adapter interface for snapshot persistence operations
 */
export interface IStorageEventPersistenceAdapter {
    /**
     * Save the snapshot of pending events
     */
    saveSnapshot(snapshot: (FileEventItem | FileEventItemSentinel)[]): Promise<void>;

    /**
     * Load the snapshot of pending events
     */
    loadSnapshot(): Promise<(FileEventItem | FileEventItemSentinel)[] | null>;
}
/** One ordered event intent in an incremental snapshot store. */
export interface StorageEventSnapshotRecord {
    /** Opaque, non-empty, store-scoped identifier unique within the active store. */
    readonly id: string;
    /** Sanitised queued file event or flush sentinel preserved in durable order. */
    readonly event: QueuedFileEvent;
}

/** Atomic changes to an incremental snapshot store. */
export interface StorageEventSnapshotDelta {
    /** Records to insert or update; IDs must be disjoint from `remove`. */
    readonly upsert: readonly StorageEventSnapshotRecord[];
    /** Committed record IDs to remove after acknowledgement; IDs must be disjoint from `upsert`. */
    readonly remove: readonly string[];
}

/** Optional entry-based persistence capability. */
export interface IStorageEventIncrementalPersistenceAdapter extends IStorageEventPersistenceAdapter {
    /**
     * Load all committed snapshot records in durable order, or `null` when no incremental store exists yet.
     */
    loadSnapshotEntries(): Promise<readonly StorageEventSnapshotRecord[] | null>;
    /**
     * Atomically apply record upserts and removals in a single persistence transaction.
     * `upsert` and `remove` IDs in a single delta are disjoint.
     */
    applySnapshotDelta(delta: StorageEventSnapshotDelta): Promise<void>;
}

/**
 * Select incremental persistence only when the complete capability is present.
 * @param adapter - The host persistence adapter to inspect.
 * @returns Whether both `loadSnapshotEntries` and `applySnapshotDelta` are implemented as functions.
 */
export function isIncrementalPersistenceAdapter(
    adapter: IStorageEventPersistenceAdapter
): adapter is IStorageEventIncrementalPersistenceAdapter {
    const candidate = adapter as IStorageEventPersistenceAdapter & {
        loadSnapshotEntries?: unknown;
        applySnapshotDelta?: unknown;
    };
    return typeof candidate.loadSnapshotEntries === "function" && typeof candidate.applySnapshotDelta === "function";
}
