/**
 * Host-facing configuration primitives for S3-compatible Journal storage.
 *
 * These exports resolve and label settings only. The host owns credential collection,
 * encrypted persistence, custom request handling, and the replication lifecycle.
 *
 * @packageDocumentation
 */

export { REMOTE_MINIO } from "./common/models/setting.const.ts";
export type {
    AdaptiveJournalPackReadPolicyV1,
    BucketSyncSetting,
    JournalFormatV1,
    RemoteDBSettings,
} from "./common/models/setting.type.ts";
export type {
    JournalStorageKind,
    JournalStorageRemoteFormatV1,
} from "./replication/journal/objectstore/JournalStorageAdapter.ts";
export {
    getJournalRemoteDisplayName,
    journalProtocolConfigurationForSettings,
    journalStorageKindForRemoteType,
} from "./replication/journal/objectstore/JournalStorageConfiguration.ts";
export type { ResolvedJournalProtocolConfigurationV1 } from "./replication/journal/objectstore/JournalStorageConfiguration.ts";
