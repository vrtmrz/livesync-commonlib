import type { RemoteDBStatus } from "@lib/replication/LiveSyncAbstractReplicator.ts";
import type { BucketSyncSetting, WebDAVSyncSetting } from "@lib/common/types.ts";

export type JournalStorageSetting = BucketSyncSetting | WebDAVSyncSetting;

export interface IJournalStorage {
    upload(key: string, data: Uint8Array, mime: string): Promise<boolean>;
    download(key: string, ignoreCache?: boolean): Promise<Uint8Array | false>;
    listFiles(from: string, limit?: number): Promise<string[]>;
    deleteFiles(keys: string[]): Promise<boolean>;
    isAvailable(): Promise<boolean>;
    getUsage(): Promise<false | RemoteDBStatus>;
    applyNewConfig(settings: JournalStorageSetting): void;
}
import type { LiveSyncJournalReplicatorEnv } from "@lib/replication/journal/LiveSyncJournalReplicatorEnv.ts";

export interface IJournalStorageAdapterClass {
    new (settings: JournalStorageSetting, env: LiveSyncJournalReplicatorEnv): IJournalStorage;
}
