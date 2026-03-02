import type { FileEventItem } from "@lib/common/types";
import type { FileEventItemSentinel } from "../StorageEventManager";

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
