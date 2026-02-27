import {
    type FilePathWithPrefix,
    type FilePath,
    type LoadedEntry,
    type EntryDoc,
    REMOTE_COUCHDB,
    type SavingEntry,
    type MetaEntry,
} from "../../common/types";
import type { ChunkManager } from "../ChunkManager";
import type { ContentSplitter } from "../../ContentSplitter/ContentSplitters";
import type { HashManager } from "../HashManager/HashManager";
import type { GeneratedChunk } from "../../pouchdb/LiveSyncLocalDB";
import type { IPathService, ISettingService } from "../../services/base/IService";
import {
    deleteDBEntryByPath,
    getDBEntryByPath,
    getDBEntryFromMeta,
    getDBEntryMetaByPath,
    isTargetFile,
    prepareChunk,
    putDBEntry,
} from "./EntryManagerImpls";

export interface EntryManagerOptions {
    hashManager: HashManager;
    chunkManager: ChunkManager;
    splitter: ContentSplitter;
    database: PouchDB.Database<EntryDoc>;
    settingService: ISettingService;
    pathService: IPathService;
}

export class EntryManager {
    options: EntryManagerOptions;

    constructor(options: EntryManagerOptions) {
        this.options = options;
    }
    get localDatabase(): PouchDB.Database<EntryDoc> {
        return this.options.database;
    }
    get hashManager(): HashManager {
        return this.options.hashManager;
    }
    get chunkManager(): ChunkManager {
        return this.options.chunkManager;
    }

    get splitter(): ContentSplitter {
        return this.options.splitter;
    }
    get serviceHost() {
        return {
            services: {
                setting: this.options.settingService,
                path: this.options.pathService,
            },
            serviceModules: {},
        };
    }

    get isOnDemandChunkEnabled() {
        const settings = this.options.settingService.currentSettings();
        if (settings.remoteType !== REMOTE_COUCHDB) {
            return false;
        }
        if (settings.useOnlyLocalChunk) {
            return false;
        }
        return true;
    }

    isTargetFile(filenameSrc: string) {
        return isTargetFile(this.serviceHost, filenameSrc);
    }

    async prepareChunk(piece: string): Promise<GeneratedChunk> {
        return await prepareChunk(this, piece);
    }

    async getDBEntryMeta(
        path: FilePathWithPrefix | FilePath,
        opt?: PouchDB.Core.GetOptions,
        includeDeleted = false
    ): Promise<false | LoadedEntry> {
        return await getDBEntryMetaByPath(this.serviceHost, this, path, opt, includeDeleted);
    }
    async getDBEntry(
        path: FilePathWithPrefix | FilePath,
        opt?: PouchDB.Core.GetOptions,
        dump = false,
        waitForReady = true,
        includeDeleted = false
    ): Promise<false | LoadedEntry> {
        return await getDBEntryByPath(this.serviceHost, this, path, opt, dump, waitForReady, includeDeleted);
    }
    async getDBEntryFromMeta(
        meta: LoadedEntry | MetaEntry,
        dump = false,
        waitForReady = true
    ): Promise<false | LoadedEntry> {
        return await getDBEntryFromMeta(this.serviceHost, this, meta, dump, waitForReady);
    }

    async deleteDBEntry(path: FilePathWithPrefix | FilePath, opt?: PouchDB.Core.GetOptions): Promise<boolean> {
        return await deleteDBEntryByPath(this.serviceHost, this, path, opt);
    }

    async putDBEntry(note: SavingEntry, onlyChunks?: boolean) {
        return await putDBEntry(this.serviceHost, this, note, onlyChunks);
    }
}
