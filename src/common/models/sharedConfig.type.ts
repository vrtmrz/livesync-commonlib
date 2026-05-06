import type { AutoConfigSyncableKey, ObsidianLiveSyncSettings } from "./setting.type";

/**
 * Interface representing the Shared Configuration document stored on CouchDB.
 */
export interface SharedConfigDocument {
    _id: string; // Always "hls_shared_config"
    _rev?: string; // PouchDB revision
    _deleted?: boolean; // PouchDB deleted flag
    version: number; // Unix timestamp denoting the generation time
    type: "shared_config"; // Type identifier
    settings: Pick<ObsidianLiveSyncSettings, AutoConfigSyncableKey>;
}
