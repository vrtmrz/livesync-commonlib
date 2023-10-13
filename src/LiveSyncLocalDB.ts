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
    LOG_LEVEL_NOTICE,
    LOG_LEVEL_VERBOSE,
} from "./types.ts";
import { delay, sendSignal, waitForSignal } from "./utils.ts";
import { Logger } from "./logger.ts";
import { isErrorOfMissingDoc } from "./utils_couchdb.ts";
import { LRUCache } from "./LRUCache.ts";

import { putDBEntry, getDBEntry, getDBEntryMeta, deleteDBEntry, deleteDBEntryPrefix, type DBFunctionEnvironment } from "./LiveSyncDBFunctions.ts";
import { skipIfDuplicated } from "./lock.ts";
import type { LiveSyncDBReplicator } from "./LiveSyncReplicator.ts";
import { writeString } from "./strbin.ts";

export interface LiveSyncLocalDBEnv {
    id2path(id: DocumentID, entry: EntryHasPath, stripPrefix?: boolean): FilePathWithPrefix;
    path2id(filename: FilePathWithPrefix | FilePath, prefix?: string): Promise<DocumentID>;
    createPouchDBInstance<T extends object>(name?: string, options?: PouchDB.Configuration.DatabaseConfiguration): PouchDB.Database<T>

    beforeOnUnload(db: LiveSyncLocalDB): void;
    onClose(db: LiveSyncLocalDB): void;
    onInitializeDatabase(db: LiveSyncLocalDB): Promise<void>;
    onResetDatabase(db: LiveSyncLocalDB): Promise<void>;
    getReplicator: () => LiveSyncDBReplicator;
    getSettings(): RemoteDBSettings;

}

export class LiveSyncLocalDB implements DBFunctionEnvironment {
    auth: Credential;
    dbname: string;
    settings: RemoteDBSettings;
    localDatabase!: PouchDB.Database<EntryDoc>;

    isReady = false;

    h32!: (input: string, seed?: number) => string;
    h32Raw!: (input: Uint8Array, seed?: number) => number;
    xxhash32: (input: string, seed?: number) => number;
    xxhash64: ((input: string) => bigint) | false = false;
    hashCaches = new LRUCache<DocumentID, string>(10, 1000);
    corruptedEntries: { [key: string]: EntryDoc } = {};

    changeHandler: PouchDB.Core.Changes<EntryDoc> | null = null;


    chunkVersion = -1;
    maxChunkVersion = -1;
    minChunkVersion = -1;
    needScanning = false;

    env: LiveSyncLocalDBEnv;

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
                sendSignal(`leaf-${e.id}`);
            });
        this.changeHandler = changes;
        this.isReady = true;
        Logger("Database is now ready.");
        return true;

    }

    async prepareHashFunctions() {
        if (this.h32 != null) return;
        try {
            const { h32ToString, h32Raw, h32, h64 } = await (xxhashNew as unknown as () => Promise<XXHashAPI>)();
            this.xxhash64 = h64;
            this.xxhash32 = h32;
            this.h32 = h32ToString;
            this.h32Raw = h32Raw;
            Logger(`Newer xxhash has been initialised`, LOG_LEVEL_VERBOSE);
        } catch (ex) {
            Logger(`Could not initialise xxhash v1`, LOG_LEVEL_VERBOSE);
            this.xxhash64 = false;
            const { h32, h32Raw } = (await xxhashOld()) as unknown as Exports;
            this.h32 = h32;
            this.h32Raw = h32Raw;
            this.xxhash32 = (str) => h32Raw(writeString(str));
            Logger(ex);
        }
    }

    async getDBLeafWithTimeout(id: DocumentID, limitTime: number): Promise<string> {
        const now = Date.now();
        const leaf = this.hashCaches.revGet(id);
        if (leaf) {
            return leaf;
        }
        try {
            const w = await this.localDatabase.get(id);
            if (w.type == "leaf") {
                this.hashCaches.set(id, w.data);
                return w.data;
            }
            throw new Error(`Corrupted chunk has been detected: ${id}`);
        } catch (ex: any) {
            if (isErrorOfMissingDoc(ex)) {
                if (limitTime < now) {
                    throw new Error(`Could not read chunk: Timed out: ${id}`);
                }
                await waitForSignal(`leaf-${id}`, 5000);
                return this.getDBLeafWithTimeout(id, limitTime);
            } else {
                Logger(`Something went wrong while retrieving chunks`);
                throw ex;
            }
        }
    }
    getDBLeaf(id: DocumentID, waitForReady: boolean): Promise<string> {
        return this.getDBLeafWithTimeout(id, waitForReady ? (Date.now() + LEAF_WAIT_TIMEOUT) : 0)
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
    async deleteDBEntry(path: FilePathWithPrefix | FilePath, opt?: PouchDB.Core.GetOptions): Promise<boolean> {
        return deleteDBEntry(this, path, opt);
    }
    // eslint-disable-next-line require-await
    async deleteDBEntryPrefix(prefixSrc: FilePathWithPrefix | FilePath): Promise<boolean> {
        return deleteDBEntryPrefix(this, prefixSrc);
    }
    // eslint-disable-next-line require-await
    async putDBEntry(note: LoadedEntry, saveAsBigChunk?: boolean) {
        return putDBEntry(this, note, saveAsBigChunk);
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
        this.localDatabase = null;
        await this.initializeDatabase();
        Logger("Local Database Reset", LOG_LEVEL_NOTICE);
    }

    async sanCheck(entry: EntryDoc): Promise<boolean> {
        if (entry.type == "plain" || entry.type == "newnote") {
            const children = entry.children;
            Logger(`sancheck:checking:${entry._id} : ${children.length}`, LOG_LEVEL_VERBOSE);
            try {
                const dc = await this.localDatabase.allDocs({ keys: [...children] });
                if (dc.rows.some((e) => "error" in e)) {
                    this.corruptedEntries[entry._id] = entry;
                    Logger(`sancheck:corrupted:${entry._id} : ${children.length}`, LOG_LEVEL_VERBOSE);
                    return false;
                }
                return true;
            } catch (ex) {
                Logger(ex);
            }
        }
        return false;
    }

    isVersionUpgradable(ver: number) {
        if (this.maxChunkVersion < 0) return false;
        if (this.minChunkVersion < 0) return false;
        if (this.maxChunkVersion > 0 && this.maxChunkVersion < ver) return false;
        if (this.minChunkVersion > 0 && this.minChunkVersion > ver) return false;
        return true;
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

    collectThrottleTimeout: ReturnType<typeof setTimeout> = null;
    collectThrottleQueuedIds = [] as string[];

    // It is no de-javu.
    chunkCollectedCallbacks: { [key: string]: { ok: ((chunk: EntryLeaf) => void)[], failed: (() => void) } } = {};
    chunkCollected(chunk: EntryLeaf) {
        const id = chunk._id;
        // Pull the hooks.
        // (One id will pull some hooks)
        if (typeof this.chunkCollectedCallbacks[id] !== "undefined") {
            for (const func of this.chunkCollectedCallbacks[id].ok) {
                func(chunk);
            }
            delete this.chunkCollectedCallbacks[id];
        } else {
            Logger(`Collected handler of ${id} is missing, it might be error but perhaps it already timed out.`, LOG_LEVEL_VERBOSE);
        }
    }
    async collectChunks(ids: string[], showResult = false, waitForReady?: boolean) {

        const localChunks = await this.collectChunksWithCache(ids as DocumentID[]);
        const missingChunks = localChunks.filter(e => !e.chunk).map(e => e.id);
        // If we have enough chunks, return them.
        if (missingChunks.length == 0) {
            return localChunks.map(e => e.chunk) as EntryLeaf[];
        }
        // Register callbacks.
        const promises = ids.map(id => new Promise<EntryLeaf>((res, rej) => {
            // Lay the hook that be pulled when chunks are incoming.
            if (typeof this.chunkCollectedCallbacks[id] == "undefined") {
                this.chunkCollectedCallbacks[id] = { ok: [], failed: () => { delete this.chunkCollectedCallbacks[id]; rej(new Error("Failed to collect one of chunks")); } };
            }
            this.chunkCollectedCallbacks[id].ok.push((chunk) => {
                res(chunk);
            });
        }));

        // Queue chunks for batch request.
        this.collectThrottleQueuedIds = [...new Set([...this.collectThrottleQueuedIds, ...ids])];
        this.execCollect();

        const res = await Promise.all(promises);
        return res;
    }
    execCollect() {
        // do not await.
        skipIfDuplicated("execCollect", async () => {
            do {
                const minimumInterval = this.settings.minimumIntervalOfReadChunksOnline; // three requests per second as maximum
                const start = Date.now();
                const requesting = this.collectThrottleQueuedIds.splice(0, this.settings.concurrencyOfReadChunksOnline);
                if (requesting.length == 0) return;
                try {
                    const chunks = await this.collectChunksInternal(requesting, false);
                    if (chunks) {
                        // Remove duplicated entries.
                        this.collectThrottleQueuedIds = this.collectThrottleQueuedIds.filter(e => !chunks.some(f => f._id == e))
                        for (const chunk of chunks) {
                            this.chunkCollected(chunk);
                        }
                    } else {
                        // TODO: need more explicit message. 
                        Logger(`Could not retrieve chunks`, LOG_LEVEL_NOTICE);
                        for (const id of requesting) {
                            if (id in this.chunkCollectedCallbacks) {
                                this.chunkCollectedCallbacks[id].failed();
                            }
                        }
                    }

                } catch (ex) {
                    Logger(`Exception raised while retrieving chunks`, LOG_LEVEL_NOTICE);
                    Logger(ex, LOG_LEVEL_VERBOSE);
                    for (const id of requesting) {
                        if (id in this.chunkCollectedCallbacks) {
                            this.chunkCollectedCallbacks[id].failed();
                        }
                    }
                }
                const passed = Date.now() - start;
                const intervalLeft = minimumInterval - passed;
                if (this.collectThrottleQueuedIds.length == 0) return;
                await delay(intervalLeft < 0 ? 0 : intervalLeft);
            } while (this.collectThrottleQueuedIds.length > 0);
        }).then(() => { /* fire and forget */ });
    }

    // Collect chunks from both local and remote.
    async collectChunksInternal(ids: string[], showResult = false): Promise<false | EntryLeaf[]> {
        // Collect chunks from the local database and the cache.
        const localChunks = await this.collectChunksWithCache(ids as DocumentID[]);
        const missingChunks = localChunks.filter(e => !e.chunk).map(e => e.id);
        // If we have enough chunks, return them.
        if (missingChunks.length == 0) {
            return localChunks.map(e => e.chunk) as EntryLeaf[];
        }
        // Fetching remote chunks.
        const remoteDocs = await this.env.getReplicator().fetchRemoteChunks(missingChunks, showResult)
        if (remoteDocs == false) {
            // Logger(`Could not fetch chunks from the server. `, showResult ? LOG_LEVEL_NOTICE : LOG_LEVEL_INFO, "fetch");
            return false;
        }

        const max = remoteDocs.length;
        remoteDocs.forEach(e => this.hashCaches.set(e._id, e.data));
        // Cache remote chunks to the local database.
        await this.localDatabase.bulkDocs(remoteDocs, { new_edits: false });
        let last = 0;
        // Chunks should be ordered by as we requested.
        function findChunk(key: string) {
            if (!remoteDocs) throw Error("Chunk collecting error");
            const offset = last;
            for (let i = 0; i < max; i++) {
                const idx = (offset + i) % max;
                last = i;
                if (remoteDocs[idx]._id == key) return remoteDocs[idx];
            }
            throw Error("Chunk collecting error");
        }
        // Merge them
        return localChunks.map(e => !e.chunk ? (findChunk(e.id)) : e.chunk);
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
                if (!("type" in doc)) continue;
                if (doc.type == "newnote" || doc.type == "plain") {
                    yield doc;
                }

            }
        } while (nextKey != "");
    }
    async *findAllDocs(opt?: PouchDB.Core.AllDocsWithKeyOptions | PouchDB.Core.AllDocsOptions | PouchDB.Core.AllDocsWithKeysOptions | PouchDB.Core.AllDocsWithinRangeOptions) {
        const targets = [
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


    getRaw<T extends EntryDoc>(docId: DocumentID, options?: PouchDB.Core.GetOptions): Promise<T & PouchDB.Core.IdMeta & PouchDB.Core.GetMeta> {
        return this.localDatabase.get<T>(docId, options || {});
    }

    removeRaw(docId: DocumentID, revision: string, options?: PouchDB.Core.Options): Promise<PouchDB.Core.Response> {
        return this.localDatabase.remove(docId, revision, options || {});
    }

    putRaw<T extends EntryDoc>(doc: T, options?: PouchDB.Core.PutOptions): Promise<PouchDB.Core.Response> {
        return this.localDatabase.put(doc, options || {})
    }

    allDocsRaw<T extends EntryDoc>(options?: PouchDB.Core.AllDocsWithKeyOptions | PouchDB.Core.AllDocsWithKeysOptions | PouchDB.Core.AllDocsWithinRangeOptions | PouchDB.Core.AllDocsOptions):
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
            const temp = [...existChunks, ...existChunksPurged].reduce((p, c) => ({ ...p, [c._id]: c.data }), {}) as { [key: DocumentID]: string };
            for (const chunk of existChunks) {
                this.hashCaches.set(chunk._id, chunk.data);
            }
            const ret = exists.map(e => ({ id: e.id, chunk: (e.chunk !== false ? e.chunk : (e.id in temp ? temp[e.id] : false)) }));
            return ret.map(e => ({ id: e.id, chunk: e.chunk !== false ? ({ _id: e.id, data: e.chunk, type: "leaf" } as EntryLeaf) : false }));
        } else {
            return exists.map(e => ({ id: e.id, chunk: { _id: e.id, data: e.chunk, type: "leaf" } as EntryLeaf }))
        }
    }
}
