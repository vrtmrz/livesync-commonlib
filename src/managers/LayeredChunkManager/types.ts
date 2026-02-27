import type { EntryDoc } from "@lib/common/models/db.definition";
import type { DocumentID, EntryLeaf } from "@lib/common/models/db.type";
import type { ISettingService } from "@lib/services/base/IService";
import type { ChangeManager } from "../ChangeManager";
import type { EVENT_CHUNK_FETCHED, EVENT_MISSING_CHUNK_REMOTE, EVENT_MISSING_CHUNKS } from "../ChunkFetcher";

export type ChunkManagerOptions = {
    database: PouchDB.Database<EntryDoc>;
    changeManager: ChangeManager<EntryDoc>;
    // maxCacheSize?: number; // Maximum cache size
    settingService: ISettingService;
};
export type ChunkReadOptions = {
    skipCache?: boolean; // Skip cache when reading
    timeout?: number; // Timeout in milliseconds
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
};
