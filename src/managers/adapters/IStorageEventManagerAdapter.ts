import type { IStorageEventTypeGuardAdapter } from "./IStorageEventTypeGuardAdapter";
import type { IStorageEventPersistenceAdapter, PendingStorageEventStore } from "./IStorageEventPersistenceAdapter";
import type { IStorageEventWatchAdapter } from "./IStorageEventWatchAdapter";
import type { IStorageEventStatusAdapter } from "./IStorageEventStatusAdapter";
import type { IStorageEventConverterAdapter } from "./IStorageEventConverterAdapter";

/**
 * Composite adapter interface for StorageEventManager
 *
 * @template TFile - Platform-specific file type
 * @template TFolder - Platform-specific folder type
 */
export interface IStorageEventManagerAdapter<TFile, TFolder> {
    readonly typeGuard: IStorageEventTypeGuardAdapter<TFile, TFolder>;
    readonly persistence: IStorageEventPersistenceAdapter;
    /** Select the ordered store when the host can persist separate event buffers. */
    readonly pendingEventStore?: PendingStorageEventStore;
    readonly watch: IStorageEventWatchAdapter<TFile, unknown>;
    readonly status: IStorageEventStatusAdapter;
    readonly converter: IStorageEventConverterAdapter<TFile>;
}
