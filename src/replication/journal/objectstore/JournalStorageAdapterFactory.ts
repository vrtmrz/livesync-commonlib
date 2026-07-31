import type { RemoteDBSettings } from "@lib/common/types.ts";
import type { LiveSyncJournalReplicatorEnv } from "../LiveSyncJournalReplicatorEnv.ts";
import type { IJournalStorage, JournalStorageRemoteFormatV1 } from "./JournalStorageAdapter.ts";
import { MinioStorageAdapter } from "./MinioStorageAdapter.ts";
import {
    getJournalRemoteDisplayName,
    journalProtocolConfigurationForSettings,
    journalStorageKindForRemoteType,
} from "./JournalStorageConfiguration.ts";
import { ADAPTIVE_JOURNAL_REQUIRED_CAPABILITIES_V1 } from "../adaptive/AdaptiveJournalManifest.ts";

export {
    getJournalRemoteDisplayName,
    journalProtocolConfigurationForSettings,
    journalStorageKindForRemoteType,
} from "./JournalStorageConfiguration.ts";

export function createJournalStorageAdapter(
    settings: RemoteDBSettings,
    env: LiveSyncJournalReplicatorEnv
): IJournalStorage {
    switch (journalStorageKindForRemoteType(settings.remoteType)) {
        case "s3":
            return new MinioStorageAdapter(settings, env);
    }
}

export function isJournalStorageAdapterCompatible(storage: IJournalStorage, settings: RemoteDBSettings): boolean {
    return storage.kind === journalStorageKindForRemoteType(settings.remoteType);
}

export interface JournalStorageConnectivityResult {
    available: boolean;
    remoteFormat?: JournalStorageRemoteFormatV1;
}

export async function inspectJournalStorageConnectivity(
    storage: IJournalStorage,
    settings: RemoteDBSettings
): Promise<JournalStorageConnectivityResult> {
    journalStorageKindForRemoteType(settings.remoteType);
    const protocol = journalProtocolConfigurationForSettings(settings);
    const remoteFormat = await storage.inspectRemoteFormat?.();
    if (remoteFormat !== undefined && remoteFormat !== "empty" && remoteFormat !== protocol.journalFormat) {
        return { available: false, remoteFormat };
    }
    const formatResult = remoteFormat === undefined ? {} : { remoteFormat };
    if (protocol.journalFormat === "opaque-v1") {
        if (remoteFormat === undefined) await storage.listFiles("", 1);
        return { available: true, ...formatResult };
    }
    if (protocol.journalFormat === "adaptive-v1") {
        if (!storage.verifyCapabilities) return { available: false, ...formatResult };
        const required = [
            ...ADAPTIVE_JOURNAL_REQUIRED_CAPABILITIES_V1,
            ...(protocol.packReadPolicy === "range" ? ["byte-range"] : []),
        ];
        const verification = await storage.verifyCapabilities(required);
        return { available: verification.status === "verified", ...formatResult };
    }
    return { available: await storage.isAvailable(), ...formatResult };
}

export async function testJournalStorageConnectivity(
    storage: IJournalStorage,
    settings: RemoteDBSettings
): Promise<boolean> {
    return (await inspectJournalStorageConnectivity(storage, settings)).available;
}
