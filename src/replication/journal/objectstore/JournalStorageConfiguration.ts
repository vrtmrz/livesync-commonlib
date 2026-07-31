import {
    REMOTE_MINIO,
    type AdaptiveJournalPackReadPolicyV1,
    type JournalFormatV1,
    type RemoteDBSettings,
} from "@lib/common/types.ts";
import { resolveJournalProtocolOptionsV1 } from "@lib/common/models/journalProtocol.ts";
import type { JournalStorageKind } from "./JournalStorageAdapter.ts";

export interface ResolvedJournalProtocolConfigurationV1 {
    expectedRepositoryId: string;
    journalFormat: JournalFormatV1;
    packReadPolicy: AdaptiveJournalPackReadPolicyV1;
}

/**
 * Maps a persisted remote type to the Journal storage implementation family.
 *
 * @throws If the remote type is not supported by Journal synchronisation.
 */
export function journalStorageKindForRemoteType(remoteType: string): JournalStorageKind {
    if (remoteType === REMOTE_MINIO) return "s3";
    throw new Error(`Unsupported Journal remote type: ${remoteType}`);
}

/**
 * Returns the non-secret endpoint used to identify a configured Journal remote in host UI.
 *
 * @throws If the selected provider is not implemented by this delivery.
 */
export function getJournalRemoteDisplayName(settings: RemoteDBSettings): string {
    journalStorageKindForRemoteType(settings.remoteType);
    return settings.endpoint;
}

/** Resolves the protocol fields carried by the active provider profile. */
export function journalProtocolConfigurationForSettings(
    settings: RemoteDBSettings
): ResolvedJournalProtocolConfigurationV1 {
    journalStorageKindForRemoteType(settings.remoteType);
    return resolveJournalProtocolOptionsV1(settings);
}
