import type { RemoteDBStatus } from "@lib/replication/LiveSyncAbstractReplicator.ts";
import type { BucketSyncSetting } from "@lib/common/types.ts";

export const JournalStorageReadStatuses = {
    AVAILABLE: "available",
    NOT_FOUND: "not-found",
    UNAVAILABLE: "unavailable",
} as const;

export type JournalStorageReadResult<T> =
    | { status: typeof JournalStorageReadStatuses.AVAILABLE; value: T }
    | { status: typeof JournalStorageReadStatuses.NOT_FOUND }
    | { status: typeof JournalStorageReadStatuses.UNAVAILABLE; error: unknown };

export interface IJournalStorage {
    upload(key: string, data: Uint8Array, mime: string): Promise<boolean>;
    download(key: string, ignoreCache?: boolean): Promise<Uint8Array | false>;
    downloadWithResult(key: string, ignoreCache?: boolean): Promise<JournalStorageReadResult<Uint8Array>>;
    listFiles(from: string, limit?: number): Promise<string[]>;
    deleteFiles(keys: string[]): Promise<boolean>;
    isAvailable(): Promise<boolean>;
    getUsage(): Promise<false | RemoteDBStatus>;
    applyNewConfig(settings: BucketSyncSetting): void;
}
import type { LiveSyncJournalReplicatorEnv } from "@lib/replication/journal/LiveSyncJournalReplicatorEnv.ts";

export interface IJournalStorageAdapterClass {
    new (settings: BucketSyncSetting, env: LiveSyncJournalReplicatorEnv): IJournalStorage;
}
