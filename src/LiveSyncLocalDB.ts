//
import { default as xxhashOld, type Exports } from "xxhash-wasm";
import { default as xxhashNew } from "../patched_xxhash_wasm/xxhash-wasm.js";
import type { XXHashAPI } from "xxhash-wasm-102";
import {
    type EntryDoc,
    type EntryLeaf, type LoadedEntry,
    type Credential,
    LEAF_WAIT_TIMEOUT, VERSIONINFO_DOCID,
    type RemoteDBSettings,
    type EntryHasPath,
    type DocumentID,
    type FilePathWithPrefix,
    type FilePath,
    type SavingEntry,
    type DatabaseEntry,
    LOG_LEVEL_NOTICE,
    LOG_LEVEL_VERBOSE,
    RESULT_TIMED_OUT,
    REMOTE_COUCHDB,
} from "./types.ts";
import { onlyNot, sendValue, waitForValue } from "./utils.ts";
import { Logger } from "./logger.ts";
import { isErrorOfMissingDoc } from "./utils_couchdb.ts";
import { LRUCache } from "./LRUCache.ts";

import { putDBEntry, getDBEntry, getDBEntryMeta, deleteDBEntry, deleteDBEntryPrefix, type DBFunctionEnvironment, getDBEntryFromMeta } from "./LiveSyncDBFunctions.ts";
import type { LiveSyncAbstractReplicator } from "./LiveSyncAbstractReplicator.ts";
import { writeString } from "./strbin.ts";
import { QueueProcessor } from "./processor.ts";
import { collectingChunks } from "./stores.ts";

export interface LiveSyncLocalDBEnv {
    id2path(id: DocumentID, entry: EntryHasPath, stripPrefix?: boolean): FilePathWithPrefix;
    path2id(filename: FilePathWithPrefix | FilePath, prefix?: string): Promise<DocumentID>;
    createPouchDBInstance<T extends object>(name?: string, options?: PouchDB.Configuration.DatabaseConfiguration): PouchDB.Database<T>

    beforeOnUnload(db: LiveSyncLocalDB): void;
    onClose(db: LiveSyncLocalDB): void;
    onInitializeDatabase(db: LiveSyncLocalDB): Promise<void>;
    onResetDatabase(db: LiveSyncLocalDB): Promise<void>;
    getReplicator: () => LiveSyncAbstractReplicator;
    getSettings(): RemoteDBSettings;

}

export class LiveSyncLocalDB implements DBFunctionEnvironment {
    auth: Credential;
    dbname: string;
    settings!: RemoteDBSettings;
    localDatabase!: PouchDB.Database<EntryDoc>;

    isReady = false;

    h32!: (input: string, seed?: number) => string;
    h32Raw!: (input: Uint8Array, seed?: number) => number;
    xxhash32!: (input: string, seed?: number) => number;
    xxhash64: ((input: string) => bigint) | false = false;
    hashCaches = new LRUCache<DocumentID, string>(10, 1000);

    changeHandler: PouchDB.Core.Changes<EntryDoc> | null = null;


    chunkVersion = -1;
    maxChunkVersion = -1;
    minChunkVersion = -1;
    needScanning = false;

    env: LiveSyncLocalDBEnv;

    get isOnDemandChunkEnabled() {
        if (this.settings.remoteType !== REMOTE_COUCHDB) {
            return false
        }
        return this.settings.readChunksOnline;
    }

    onunload() {
        //this.kvDB.close();
        this.env.beforeOnUnload(this);
        this.changeHandler?.cancel();
        this.changeHandler?.removeAllListeners();
        this.localDatabase.removeAllListeners();
    }

    refreshSettings() {
        const settings = this.env.getSettings();
        this.settings = settings;
        this.hashCaches = new LRUCache(settings.hashCacheMaxCount, settings.hashCacheMaxAmount);
    }

    constructor(dbname: string, env: LiveSyncLocalDBEnv) {
        this.auth = {
            username: "",
            password: "",
        };
        this.dbname = dbname;
        this.env = env;
        this.refreshSettings();

    }
    id2path(id: DocumentID, entry: EntryHasPath, stripPrefix?: boolean): FilePathWithPrefix {
        return this.env.id2path(id, entry, stripPrefix);
    }
    async path2id(filename: FilePathWithPrefix | FilePath, prefix?: string): Promise<DocumentID> {
        return await this.env.path2id(filename, prefix);
    }

    async close() {
        Logger("Database closed (by close)");
        this.isReady = false;
        this.changeHandler?.cancel();
        this.changeHandler?.removeAllListeners();
        if (this.localDatabase != null) {
            await this.localDatabase.close();
        }
        this.env.onClose(this);
    }


    async initializeDatabase(): Promise<boolean> {
        await this.prepareHashFunctions();
        if (this.localDatabase != null) await this.localDatabase.close();
        this.changeHandler?.cancel();
        this.changeHandler?.removeAllListeners();
        //@ts-ignore
        this.localDatabase = null;

        this.localDatabase = this.env.createPouchDBInstance<EntryDoc>(this.dbname + "-livesync-v2", {
            auto_compaction: false,
            revs_limit: 100,
            deterministic_revs: true,
        });
        await this.env.onInitializeDatabase(this);
        Logger("Opening Database...");
        Logger("Database info", LOG_LEVEL_VERBOSE);
        Logger(await this.localDatabase.info(), LOG_LEVEL_VERBOSE);
        this.localDatabase.on("close", () => {
            Logger("Database closed.");
            this.isReady = false;
            this.localDatabase.removeAllListeners();
            this.env.getReplicator()?.closeReplication();
        });


        // Tracings the leaf id
        const changes = this.localDatabase
            .changes({
                since: "now",
                live: true,
                filter: (doc) => doc.type == "leaf",
            })
            .on("change", (e) => {
                if (e.deleted) return;
                sendValue(`leaf-${e.id}`, e.doc);
            });
        this.changeHandler = changes;
        this.isReady = true;
        Logger("Database is now ready.");
        return true;

    }

    async prepareHashFunctions() {
        if (this.h32 != null) return;
        if (this.settings.hashAlg == "sha1") {
            Logger(`Fallback(SHA1) is used for hashing`, LOG_LEVEL_VERBOSE);
            return;
        }
        try {
            const { h32ToString, h32Raw, h32, h64 } = await (xxhashNew as unknown as () => Promise<XXHashAPI>)();
            this.xxhash64 = h64;
            this.xxhash32 = h32;
            this.h32 = h32ToString;
            this.h32Raw = h32Raw;
            Logger(`Newer xxhash has been initialised`, LOG_LEVEL_VERBOSE);
        } catch (ex) {
            Logger(`Could not initialise xxhash: use v1`, LOG_LEVEL_VERBOSE);
            Logger(ex);
            try {
                this.xxhash64 = false;
                const { h32, h32Raw } = (await xxhashOld()) as unknown as Exports;
                this.h32 = h32;
                this.h32Raw = h32Raw;
                this.xxhash32 = (str) => h32Raw(writeString(str));
            } catch (ex) {
                Logger(`Could not initialise xxhash: use sha1F`, LOG_LEVEL_VERBOSE);
                Logger(ex);
                this.settings.hashAlg = "sha1";
            }

        }
    }

    async readChunk(id: DocumentID, timeout: number): Promise<string> {
        const leaf = this.hashCaches.revGet(id);
        if (leaf) {
            return leaf;
        }
        let w: EntryDoc | undefined;
        try {
            w = await this.localDatabase.get(id);
        } catch (ex) {
            if (!isErrorOfMissingDoc(ex)) {
                throw ex;
            }
        }
        if (w === undefined && timeout != 0) {
            const ret = await waitForValue<EntryDoc>(`leaf-${id}`, timeout);
            if (ret === RESULT_TIMED_OUT) {
                throw new Error(`Timed out: ${id}`);
            }
            w = ret;
        }
        if (w === undefined) {
            throw new Error(`Missing chunks of: ${id}`);
        }
        if (w.type != "leaf") {
            throw new Error(`Corrupted chunk has been detected: ${id}`);
        }
        this.hashCaches.set(id, w.data);
        return w.data;
    }
    async getDBLeafWithTimeout(id: DocumentID, timeout: number): Promise<string> {
        try {
            return await this.readChunk(id, timeout);
        } catch (ex) {
            Logger(`Something went wrong while retrieving chunks`);
            Logger(ex, LOG_LEVEL_VERBOSE);
            throw ex;
        }
    }
    getDBLeaf(id: DocumentID, waitForReady: boolean): Promise<string> {
        return this.getDBLeafWithTimeout(id, waitForReady ? LEAF_WAIT_TIMEOUT : 0)
    }

    // eslint-disable-next-line require-await
    async getDBEntryMeta(path: FilePathWithPrefix | FilePath, opt?: PouchDB.Core.GetOptions, includeDeleted = false): Promise<false | LoadedEntry> {
        return getDBEntryMeta(this, path, opt, includeDeleted);
    }
    // eslint-disable-next-line require-await
    async getDBEntry(path: FilePathWithPrefix | FilePath, opt?: PouchDB.Core.GetOptions, dump = false, waitForReady = true, includeDeleted = false): Promise<false | LoadedEntry> {
        return getDBEntry(this, path, opt, dump, waitForReady, includeDeleted);
    }
    // eslint-disable-next-line require-await
    async getDBEntryFromMeta(meta: LoadedEntry, opt?: PouchDB.Core.GetOptions, dump = false, waitForReady = true, includeDeleted = false): Promise<false | LoadedEntry> {
        return getDBEntryFromMeta(this, meta, opt, dump, waitForReady, includeDeleted);
    }
    // eslint-disable-next-line require-await
    async deleteDBEntry(path: FilePathWithPrefix | FilePath, opt?: PouchDB.Core.GetOptions): Promise<boolean> {
        return deleteDBEntry(this, path, opt);
    }
    // eslint-disable-next-line require-await
    async deleteDBEntryPrefix(prefixSrc: FilePathWithPrefix | FilePath): Promise<boolean> {
        return deleteDBEntryPrefix(this, prefixSrc);
    }
    // eslint-disable-next-line require-await
    async putDBEntry(note: SavingEntry) {
        return putDBEntry(this, note);
    }



    async resetDatabase() {
        this.changeHandler?.cancel();
        this.changeHandler?.removeAllListeners();
        this.env.getReplicator().closeReplication();
        await this.env.onResetDatabase(this);
        Logger("Database closed for reset Database.");
        this.isReady = false;
        await this.localDatabase.destroy();
        //await this.kvDB.destroy();
        //@ts-ignore
        this.localDatabase = null;
        await this.initializeDatabase();
        Logger("Local Database Reset", LOG_LEVEL_NOTICE);
    }

    isTargetFile(filenameSrc: string) {
        const file = filenameSrc.startsWith("i:") ? filenameSrc.substring(2) : filenameSrc;
        if (file.startsWith("ix:")) return true;
        if (file.startsWith("ps:")) return true;
        if (file.includes(":")) return false;
        if (this.settings.syncOnlyRegEx) {
            const syncOnly = new RegExp(this.settings.syncOnlyRegEx);
            if (!file.match(syncOnly)) return false;
        }
        if (this.settings.syncIgnoreRegEx) {
            const syncIgnore = new RegExp(this.settings.syncIgnoreRegEx);
            if (file.match(syncIgnore)) return false;
        }
        return true;
    }

    _chunkCollectProcessor = new QueueProcessor(async (requesting: string[]) => {
        try {
            const chunks = await this._collectChunks(requesting, false);
            if (chunks) {
                chunks.forEach(chunk => sendValue(`chunk-fetch-${chunk._id}`, chunk));
            } else {
                throw new Error("Failed: CollectChunksInternal");
            }
        } catch (ex) {
            Logger(`Exception raised while retrieving chunks`, LOG_LEVEL_NOTICE);
            Logger(ex, LOG_LEVEL_VERBOSE);
            requesting.forEach((id) => sendValue(`chunk-fetch-${id}`, []));
        }
        return;
    }, { batchSize: 100, interval: 100, concurrentLimit: 1, maintainDelay: true, suspended: false, totalRemainingReactiveSource: collectingChunks });
    async collectChunks(ids: string[], showResult = false, waitForReady?: boolean) {
        const localChunks = await this.collectChunksWithCache(ids as DocumentID[]);
        const missingChunks = localChunks.filter(e => !e.chunk).map(e => e.id);
        // If we have enough chunks, return them.
        if (missingChunks.length == 0) {
            return localChunks.map(e => e.chunk) as EntryLeaf[];
        }
        this._chunkCollectProcessor.batchSize = this.settings.concurrencyOfReadChunksOnline;
        this._chunkCollectProcessor.interval = this.settings.minimumIntervalOfReadChunksOnline;
        this._chunkCollectProcessor.enqueueAll(ids)
        const fetchChunkTasks = ids.map(id => waitForValue<EntryLeaf>(`chunk-fetch-${id}`));
        const res = (await Promise.all(fetchChunkTasks)).filter(onlyNot(RESULT_TIMED_OUT));
        return res;
    }

    async _collectChunks(ids: string[], showResult = false): Promise<false | EntryLeaf[]> {
        // Collect chunks from the local database and the cache.
        const localChunks = await this.collectChunksWithCache(ids as DocumentID[]);
        const missingChunks = localChunks.filter(e => !e.chunk).map(e => e.id);
        // If we have enough chunks, return them.
        if (missingChunks.length == 0) {
            return localChunks.map(e => e.chunk) as EntryLeaf[];
        }
        // Fetching remote chunks.
        const remoteDocs = await this.env.getReplicator().fetchRemoteChunks(missingChunks, showResult);
        if (remoteDocs == false) {
            Logger(`Could not fetch chunks from the server. `, showResult ? LOG_LEVEL_NOTICE : LOG_LEVEL_VERBOSE, "fetch");
            return false;
        }
        remoteDocs.forEach(e => this.hashCaches.set(e._id, e.data));
        // Cache remote chunks to the local database.
        await this.localDatabase.bulkDocs(remoteDocs, { new_edits: false });
        // Chunks should be ordered by as we requested.
        const chunks = Object.fromEntries([...localChunks.map(e => e.chunk).filter(e => e !== false) as EntryLeaf[], ...remoteDocs].map(e => [e._id, e]));
        const ret = ids.map(e => chunks?.[e] ?? undefined)
        if (ret.some(e => e === undefined)) return false;
        return ret;

    }


    async *findEntries(startKey: string, endKey: string, opt: PouchDB.Core.AllDocsWithKeyOptions | PouchDB.Core.AllDocsOptions | PouchDB.Core.AllDocsWithKeysOptions | PouchDB.Core.AllDocsWithinRangeOptions) {
        const pageLimit = 100;
        let nextKey = startKey;
        let req = this.allDocsRaw({ limit: pageLimit, startkey: nextKey, endkey: endKey, include_docs: true, ...opt });
        do {
            const docs = await req;
            if (docs.rows.length === 0) {
                break;
            }
            nextKey = `${docs.rows[docs.rows.length - 1].id}`;
            req = this.allDocsRaw({ limit: pageLimit, skip: 1, startkey: nextKey, endkey: endKey, include_docs: true, ...opt });
            for (const row of docs.rows) {
                const doc = row.doc;
                //@ts-ignore: non null by include_docs
                if (!("type" in doc)) continue;
                if (doc.type == "newnote" || doc.type == "plain") {
                    yield doc;
                }

            }
        } while (nextKey != "");
    }
    async *findAllDocs(opt?: PouchDB.Core.AllDocsWithKeyOptions | PouchDB.Core.AllDocsOptions | PouchDB.Core.AllDocsWithKeysOptions | PouchDB.Core.AllDocsWithinRangeOptions) {
        const targets = [
            () => this.findEntries("", "_", opt ?? {}),
            () => this.findEntries("_\u{10ffff}", "h:", opt ?? {}),
            () => this.findEntries(`h:\u{10ffff}`, "", opt ?? {}),
        ]
        for (const targetFun of targets) {
            const target = targetFun();
            for await (const f of target) {
                yield f;
            }
        }
    }
    async *findEntryNames(startKey: string, endKey: string, opt: PouchDB.Core.AllDocsWithKeyOptions | PouchDB.Core.AllDocsOptions | PouchDB.Core.AllDocsWithKeysOptions | PouchDB.Core.AllDocsWithinRangeOptions) {
        const pageLimit = 100;
        let nextKey = startKey;
        let req = this.allDocsRaw({ limit: pageLimit, startkey: nextKey, endkey: endKey, ...opt });
        do {
            const docs = await req;
            if (docs.rows.length == 0) {
                nextKey = "";
                break;
            }
            nextKey = `${docs.rows[docs.rows.length - 1].key}`;
            req = this.allDocsRaw({ limit: pageLimit, skip: 1, startkey: nextKey, endkey: endKey, ...opt });
            for (const row of docs.rows) {
                yield row.id;
            }
        } while (nextKey != "");
    }
    async *findAllDocNames(opt?: PouchDB.Core.AllDocsWithKeyOptions | PouchDB.Core.AllDocsOptions | PouchDB.Core.AllDocsWithKeysOptions | PouchDB.Core.AllDocsWithinRangeOptions) {
        const targets = [
            () => this.findEntryNames("", "_", opt ?? {}),
            () => this.findEntryNames("_\u{10ffff}", "h:", opt ?? {}),
            () => this.findEntryNames(`h:\u{10ffff}`, "i:", opt ?? {}),
            () => this.findEntryNames(`i:\u{10ffff}`, "ix:", opt ?? {}),
            () => this.findEntryNames(`ix:\u{10ffff}`, "ps:", opt ?? {}),
            () => this.findEntryNames(`ps:\u{10ffff}`, "", opt ?? {}),

        ]
        for (const targetFun of targets) {
            const target = targetFun();
            for await (const f of target) {
                if (f.startsWith("_")) continue;
                if (f == VERSIONINFO_DOCID) continue;
                yield f;
            }
        }
    }
    async *findAllNormalDocs(opt?: PouchDB.Core.AllDocsWithKeyOptions | PouchDB.Core.AllDocsOptions | PouchDB.Core.AllDocsWithKeysOptions | PouchDB.Core.AllDocsWithinRangeOptions) {
        const targets = [
            () => this.findEntries("", "_", opt ?? {}),
            () => this.findEntries("_\u{10ffff}", "h:", opt ?? {}),
            () => this.findEntries(`h:\u{10ffff}`, "i:", opt ?? {}),
            () => this.findEntries(`i:\u{10ffff}`, "ix:", opt ?? {}),
            () => this.findEntries(`ix:\u{10ffff}`, "ps:", opt ?? {}),
            () => this.findEntries(`ps:\u{10ffff}`, "", opt ?? {}),
        ]
        for (const targetFun of targets) {
            const target = targetFun();
            for await (const f of target) {
                if (f._id.startsWith("_")) continue;
                if (f.type != "newnote" && f.type != "plain") continue;
                yield f;
            }
        }
    }

    async removeRevision(docId: DocumentID, revision: string): Promise<boolean> {
        try {
            const doc = await this.localDatabase.get(docId, { rev: revision });
            doc._deleted = true;
            await this.localDatabase.put(doc);
            return true;
        } catch (ex) {
            if (isErrorOfMissingDoc(ex)) {
                Logger(`Remove revision: Missing target revision, ${docId}-${revision}`, LOG_LEVEL_VERBOSE);
            }
        }
        return false;
    }

    getRaw<T extends EntryDoc>(docId: DocumentID, options?: PouchDB.Core.GetOptions): Promise<T & PouchDB.Core.IdMeta & PouchDB.Core.GetMeta> {
        return this.localDatabase.get<T>(docId, options || {});
    }

    removeRaw(docId: DocumentID, revision: string, options?: PouchDB.Core.Options): Promise<PouchDB.Core.Response> {
        return this.localDatabase.remove(docId, revision, options || {});
    }

    putRaw<T extends EntryDoc>(doc: T, options?: PouchDB.Core.PutOptions): Promise<PouchDB.Core.Response> {
        return this.localDatabase.put(doc, options || {})
    }

    allDocsRaw<T extends EntryDoc | DatabaseEntry>(options?: PouchDB.Core.AllDocsWithKeyOptions | PouchDB.Core.AllDocsWithKeysOptions | PouchDB.Core.AllDocsWithinRangeOptions | PouchDB.Core.AllDocsOptions):
        Promise<PouchDB.Core.AllDocsResponse<T>> {
        return this.localDatabase.allDocs<T>(options);
    }

    bulkDocsRaw<T extends EntryDoc>(docs: Array<PouchDB.Core.PutDocument<T>>, options?: PouchDB.Core.BulkDocsOptions): Promise<Array<PouchDB.Core.Response | PouchDB.Core.Error>> {
        return this.localDatabase.bulkDocs(docs, options || {});
    }

    /* Read chunks from local database with cached chunks */
    async collectChunksWithCache(keys: DocumentID[]): Promise<{ id: DocumentID, chunk: EntryLeaf | false }[]> {
        const exists = keys.map(e => this.hashCaches.has(e) ? ({ id: e, chunk: this.hashCaches.get(e) }) : { id: e, chunk: false });
        const notExists = exists.filter(e => e.chunk === false);
        if (notExists.length > 0) {
            const chunks = await this.localDatabase.allDocs({ keys: notExists.map(e => e.id), include_docs: true });
            const existChunks = chunks.rows.filter(e => !("error" in e)).map((e: any) => e.doc as EntryLeaf);
            // If the chunks are missing, possibly backed up while cleaning up.
            const nonExistsLocal = chunks.rows.filter(e => ("error" in e)).map(e => e.key);
            const purgedChunks = await this.localDatabase.allDocs({ keys: nonExistsLocal.map(e => `_local/${e}`), include_docs: true });
            const existChunksPurged = purgedChunks.rows.filter(e => !("error" in e)).map((e: any) => ({ ...e.doc, _id: e.id.substring(7) }) as EntryLeaf);
            const temp = Object.fromEntries(existChunksPurged.map(e => [e._id, e.data]));
            for (const chunk of existChunks) {
                temp[chunk._id] = chunk.data;
                this.hashCaches.set(chunk._id, chunk.data);
            }
            const ret = exists.map(e => ({ id: e.id, chunk: (e.chunk !== false ? e.chunk : (e.id in temp ? temp[e.id] : false)) }));
            return ret.map(e => ({ id: e.id, chunk: e.chunk !== false ? ({ _id: e.id, data: e.chunk, type: "leaf" } as EntryLeaf) : false }));
        } else {
            return exists.map(e => ({ id: e.id, chunk: { _id: e.id, data: e.chunk, type: "leaf" } as EntryLeaf }))
        }
    }
}
