import type { LocalDatabaseReadScope } from "@lib/pouchdb/LocalDatabaseReadScope.ts";
import type { EntryDoc } from "@lib/common/models/db.definition";
import type { DocumentID, EntryLeaf } from "@lib/common/models/db.type";
import type { ISettingService } from "@lib/services/base/IService";
import type { ChangeManager } from "@lib/managers/ChangeManager";
import type {
    EVENT_CHUNK_FAILED,
    EVENT_CHUNK_FETCHED,
    EVENT_MISSING_CHUNK_REMOTE,
    EVENT_MISSING_CHUNKS,
} from "@lib/managers/ChunkFetcher";
import type { ActivityCountSource } from "@lib/managers/ChunkDeliveryCoordinator";
import type { ContentReadResource } from "@lib/interfaces/DatabaseFileAccess.ts";
import type { LogFunction } from "@lib/services/lib/logUtils.ts";
export type ChunkDeliveryFailure = { resources: readonly ContentReadResource[]; cause: unknown };

export type ChunkManagerOptions = {
    /** Host-owned logger; standalone instances default to the global logger. */
    log?: LogFunction;
    database: PouchDB.Database<EntryDoc>;
    readScope?: LocalDatabaseReadScope;
    changeManager: ChangeManager<EntryDoc>;
    // maxCacheSize?: number; // Maximum cache size
    settingService: ISettingService;
    /** Finite replication which may still deliver a requested chunk. */
    finiteReplicationActivity?: ActivityCountSource;
};
export type ChunkReadOptions = {
    skipCache?: boolean; // Skip cache when reading
    /** Wait for an already-observable finite delivery lifecycle. */
    waitForDelivery?: boolean;
    /** @deprecated Use `waitForDelivery`. Positive values no longer represent an arrival duration. */
    timeout?: number;
    preventRemoteRequest?: boolean; // Prevent dispatching missing chunk event
};
export type ChunkWriteOptions = {
    skipCache?: boolean; // Skip cache when writing
    force?: boolean;
};
export type WriteResult = {
    result: boolean;
    processed: {
        cached: number; // Number of chunks processed in cache
        hotPack: number; // Number of chunks processed in hot pack
        written: number; // Number of chunks processed in database
        duplicated: number; // Number of chunks duplicated
    };
};

export type ChunkManagerEventMap = {
    [EVENT_MISSING_CHUNK_REMOTE]: DocumentID; // Event for missing chunk
    [EVENT_MISSING_CHUNKS]: DocumentID[]; // Event for multiple missing chunks
    [EVENT_CHUNK_FETCHED]: EntryLeaf; // Event for chunk arrival
    [EVENT_CHUNK_FAILED]: { id: DocumentID; failure: ChunkDeliveryFailure };
};
