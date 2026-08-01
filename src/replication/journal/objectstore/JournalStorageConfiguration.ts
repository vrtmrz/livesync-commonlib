import {
    REMOTE_MINIO,
    REMOTE_POSTGREST,
    REMOTE_WEBDAV,
    type AdaptiveJournalPackReadPolicyV1,
    type JournalFormatV1,
    type RemoteDBSettings,
} from "@lib/common/types.ts";
import { resolveJournalProtocolOptionsV1 } from "@lib/common/models/journalProtocol.ts";
import type { JournalStorageKind } from "./JournalStorageAdapter.ts";
import { parsePostgRESTConnectionURI } from "./JournalStorageConnection.ts";

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
    if (remoteType === REMOTE_POSTGREST) return "postgrest";
    if (remoteType === REMOTE_WEBDAV) return "webdav";
    throw new Error(`Unsupported Journal remote type: ${remoteType}`);
}

/**
 * Returns the non-secret endpoint used to identify a configured Journal remote in host UI.
 *
 * @throws If the selected provider is not implemented by this delivery.
 */
export function getJournalRemoteDisplayName(settings: RemoteDBSettings): string {
    switch (journalStorageKindForRemoteType(settings.remoteType)) {
        case "s3":
            return settings.endpoint;
        case "postgrest":
            try {
                return parsePostgRESTConnectionURI(settings.postgrestActiveConnectionURI).endpoint;
            } catch {
                return "PostgREST";
            }
        case "webdav":
            try {
                const match = /^sls\+webdav:(\/\/.*)$/u.exec(settings.webDAVactiveConnectionURI);
                if (!match) throw new Error("Invalid WebDAV connection URI");
                const url = new URL(`https:${match[1]}`);
                const protocol = url.searchParams.get("insecure") === "true" ? "http:" : "https:";
                return `${protocol}//${url.host}${url.pathname}`;
            } catch {
                return "WebDAV";
            }
    }
}

/** Resolves the protocol fields carried by the active provider profile. */
export function journalProtocolConfigurationForSettings(
    settings: RemoteDBSettings
): ResolvedJournalProtocolConfigurationV1 {
    const kind = journalStorageKindForRemoteType(settings.remoteType);
    const protocol = resolveJournalProtocolOptionsV1(settings);
    if (kind === "postgrest" && protocol.journalFormat !== "adaptive-v1") {
        throw new Error("PostgREST Journal storage requires the Adaptive format");
    }
    if (kind === "postgrest" && protocol.packReadPolicy !== "whole-pack") {
        throw new Error("PostgREST native Chunk storage does not support object Pack range reads");
    }
    return protocol;
}
