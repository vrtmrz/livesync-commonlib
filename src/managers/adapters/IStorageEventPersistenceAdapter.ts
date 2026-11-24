import type { FileEventItem } from "@lib/common/types";
import type { FileEventItemSentinel } from "@lib/managers/StorageEventManager";

export interface PendingStorageEventBuffer {
    readonly key: string;
    readonly events: readonly (FileEventItem | FileEventItemSentinel)[];
}

/** Store immutable buffers of pending event intents. */
export interface PendingStorageEventStore {
    /** Load buffers in replay order, with any legacy snapshot first. */
    load(): Promise<readonly PendingStorageEventBuffer[]>;

    /**
     * Save the whole buffer atomically and return its unique key after the write commits.
     * A rejected append leaves the store unchanged.
     */
    append(events: PendingStorageEventBuffer["events"]): Promise<string>;

    /** Remove the buffer under the supplied key after all of its entries have completed. */
    remove(key: string): Promise<void>;
}

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
