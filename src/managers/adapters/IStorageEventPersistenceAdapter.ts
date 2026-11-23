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
    readonly id: string;
    readonly event: QueuedFileEvent;
}

/** Atomic changes to an incremental snapshot store. */
export interface StorageEventSnapshotDelta {
    readonly upsert: readonly StorageEventSnapshotRecord[];
    readonly remove: readonly string[];
}

/** Optional entry-based persistence capability. */
export interface IStorageEventIncrementalPersistenceAdapter extends IStorageEventPersistenceAdapter {
    loadSnapshotEntries(): Promise<readonly StorageEventSnapshotRecord[] | null>;
    applySnapshotDelta(delta: StorageEventSnapshotDelta): Promise<void>;
}

/** Select incremental persistence only when the complete capability is present. */
export function isIncrementalPersistenceAdapter(
    adapter: IStorageEventPersistenceAdapter
): adapter is IStorageEventIncrementalPersistenceAdapter {
    const candidate = adapter as IStorageEventPersistenceAdapter & {
        loadSnapshotEntries?: unknown;
        applySnapshotDelta?: unknown;
    };
    return typeof candidate.loadSnapshotEntries === "function" && typeof candidate.applySnapshotDelta === "function";
}
