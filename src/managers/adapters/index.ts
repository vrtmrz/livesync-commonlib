export type { IStorageEventTypeGuardAdapter } from "./IStorageEventTypeGuardAdapter";
export type { IStorageEventPersistenceAdapter } from "./IStorageEventPersistenceAdapter";
export {
    isIncrementalPersistenceAdapter,
    type IStorageEventIncrementalPersistenceAdapter,
    type StorageEventSnapshotDelta,
    type StorageEventSnapshotRecord,
} from "./IStorageEventPersistenceAdapter";
export type { IStorageEventWatchAdapter, IStorageEventWatchHandlers } from "./IStorageEventWatchAdapter";
export type { IStorageEventStatusAdapter } from "./IStorageEventStatusAdapter";
export type { IStorageEventConverterAdapter } from "./IStorageEventConverterAdapter";
export type { IStorageEventManagerAdapter } from "./IStorageEventManagerAdapter";
