import type { RemoteDBStatus } from "@lib/replication/LiveSyncAbstractReplicator.ts";
import type { BucketSyncSetting, RemoteDBSettings } from "@lib/common/types.ts";
import type { CapabilityVerification } from "../adaptive/AdaptiveJournalRepository.ts";

export type JournalStorageKind = "s3";
export type JournalStorageRemoteFormatV1 = "adaptive-v1" | "empty" | "mixed" | "opaque-v1";
export type JournalStorageSetting = BucketSyncSetting | RemoteDBSettings;

export interface IJournalStorage {
    readonly kind: JournalStorageKind;
    readonly storageIdentity: string;
    upload(key: string, data: Uint8Array, mime: string): Promise<boolean>;
    download(key: string, ignoreCache?: boolean): Promise<Uint8Array | false>;
    listFiles(from: string, limit?: number): Promise<string[]>;
    deleteFiles(keys: string[]): Promise<boolean>;
    resetJournalStorage?(): Promise<boolean>;
    isAvailable(): Promise<boolean>;
    inspectRemoteFormat?(): Promise<JournalStorageRemoteFormatV1>;
    verifyCapabilities?(required: readonly string[]): Promise<CapabilityVerification>;
    getUsage(): Promise<false | RemoteDBStatus>;
    applyNewConfig(settings: JournalStorageSetting): void;
}

export function classifyJournalStorageRemoteFormatV1(
    hasAdaptiveObjects: boolean,
    hasOpaqueObjects: boolean
): JournalStorageRemoteFormatV1 {
    if (hasAdaptiveObjects && hasOpaqueObjects) return "mixed";
    if (hasAdaptiveObjects) return "adaptive-v1";
    if (hasOpaqueObjects) return "opaque-v1";
    return "empty";
}

export class JournalStorageFormatMismatchError extends Error {
    readonly code = "journal-storage-format-mismatch" as const;

    constructor(
        readonly expectedFormat: Exclude<JournalStorageRemoteFormatV1, "empty" | "mixed">,
        readonly remoteFormat: Exclude<JournalStorageRemoteFormatV1, "empty">
    ) {
        super(`Expected ${expectedFormat} Journal storage, found ${remoteFormat}`);
        this.name = "JournalStorageFormatMismatchError";
    }
}

export async function assertJournalStorageRemoteFormatV1(
    storage: IJournalStorage,
    expectedFormat: Exclude<JournalStorageRemoteFormatV1, "empty" | "mixed">
): Promise<void> {
    const remoteFormat = await storage.inspectRemoteFormat?.();
    if (remoteFormat === undefined || remoteFormat === "empty" || remoteFormat === expectedFormat) return;
    throw new JournalStorageFormatMismatchError(expectedFormat, remoteFormat);
}
import type { LiveSyncJournalReplicatorEnv } from "@lib/replication/journal/LiveSyncJournalReplicatorEnv.ts";

export interface IJournalStorageAdapterClass {
    new (settings: JournalStorageSetting, env: LiveSyncJournalReplicatorEnv): IJournalStorage;
}
