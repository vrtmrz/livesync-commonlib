/**
 * Host-facing configuration primitives for Journal storage providers.
 *
 * These exports resolve and label settings only. The host owns credential collection,
 * encrypted persistence, custom request handling, and the replication lifecycle.
 *
 * @packageDocumentation
 */

import type { RemoteDBSettings } from "./common/models/setting.type.ts";
import type { JournalStorageConnectivityResult } from "./replication/journal/objectstore/JournalStorageAdapterFactory.ts";

export { REMOTE_MINIO, REMOTE_POSTGREST, REMOTE_WEBDAV, isJournalRemoteType } from "./common/models/setting.const.ts";
export type {
    AdaptiveJournalPackReadPolicyV1,
    BucketSyncSetting,
    JournalFormatV1,
    PostgRESTSyncSetting,
    RemoteDBSettings,
    WebDAVSyncSetting,
} from "./common/models/setting.type.ts";
export type {
    JournalStorageKind,
    JournalStorageRemoteFormatV1,
} from "./replication/journal/objectstore/JournalStorageAdapter.ts";
export type {
    JournalStorageAdaptiveCapabilityInspection,
    JournalStorageCapabilityInspection,
    JournalStorageConnectivityResult,
} from "./replication/journal/objectstore/JournalStorageAdapterFactory.ts";
export {
    getJournalRemoteDisplayName,
    journalProtocolConfigurationForSettings,
    journalStorageKindForRemoteType,
} from "./replication/journal/objectstore/JournalStorageConfiguration.ts";
export type { ResolvedJournalProtocolConfigurationV1 } from "./replication/journal/objectstore/JournalStorageConfiguration.ts";
export {
    parsePostgRESTConnectionURI,
    parseWebDAVConnectionURI,
    serialisePostgRESTConnectionURI,
    serialiseWebDAVConnectionURI,
    type PostgRESTConnection,
    type WebDAVConnection,
} from "./replication/journal/objectstore/JournalStorageConnection.ts";

export interface JournalStorageConnectionInspector {
    inspectJournalStorageConnection(settings: RemoteDBSettings): Promise<JournalStorageConnectivityResult>;
}

/** Identifies the provider-neutral Journal connection inspection offered by a Journal replicator. */
export function isJournalStorageConnectionInspector(value: unknown): value is JournalStorageConnectionInspector {
    if ((typeof value !== "object" && typeof value !== "function") || value === null) return false;
    return typeof (value as Partial<JournalStorageConnectionInspector>).inspectJournalStorageConnection === "function";
}
