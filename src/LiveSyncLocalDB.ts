//
import xxhash from "xxhash-wasm";
import {
    EntryDoc,
    EntryLeaf, LoadedEntry,
    Credential, LOG_LEVEL,
    LEAF_WAIT_TIMEOUT, VERSIONINFO_DOCID,
    RemoteDBSettings
} from "./types";
import { delay } from "./utils";
import { Logger } from "./logger";
import { isErrorOfMissingDoc } from "./utils_couchdb";
import { LRUCache } from "./LRUCache";

import { putDBEntry, getDBEntry, getDBEntryMeta, deleteDBEntry, deleteDBEntryPrefix, DBFunctionEnvironment } from "./LiveSyncDBFunctions.js";
import { runWithLock } from "./lock.js";
import type { LiveSyncDBReplicator } from "./LiveSyncReplicator";

export interface LiveSyncLocalDBEnv {
    id2path(filename: string): string;
    path2id(filename: string): string;
    createPouchDBInstance<T>(name?: string, options?: PouchDB.Configuration.DatabaseConfiguration): PouchDB.Database<T>

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
    hashCaches = new LRUCache(10, 10);
    corruptedEntries: { [key: string]: EntryDoc } = {};

    changeHandler: PouchDB.Core.Changes<EntryDoc> | null = null;

    leafArrivedCallbacks: { [key: string]: (() => void)[] } = {};

    docSeq = "";

    chunkVersion = -1;
    maxChunkVersion = -1;
    minChunkVersion = -1;
    needScanning = false;

    env: LiveSyncLocalDBEnv;

    onunload() {
        //this.kvDB.close();
        this.env.beforeOnUnload(this);
        this.leafArrivedCallbacks;
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
    id2path(filename: string): string {
        return this.env.id2path(filename);
    }
    path2id(filename: string): string {
        return this.env.path2id(filename);
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
        Logger("Database info", LOG_LEVEL.VERBOSE);
        Logger(await this.localDatabase.info(), LOG_LEVEL.VERBOSE);
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
                this.leafArrived(e.id);
                this.docSeq = `${e.seq}`;
            });
        this.changeHandler = changes;
        this.isReady = true;
        Logger("Database is now ready.");
        return true;

    }

    async prepareHashFunctions() {
        if (this.h32 != null) return;
        const { h32, h32Raw } = await xxhash();
        this.h32 = h32;
        this.h32Raw = h32Raw;
    }

    // leaf waiting

    leafArrived(id: string) {
        if (typeof this.leafArrivedCallbacks[id] !== "undefined") {
            for (const func of this.leafArrivedCallbacks[id]) {
                func();
            }
            delete this.leafArrivedCallbacks[id];
        }
    }
    // wait
    waitForLeafReady(id: string): Promise<boolean> {
        return new Promise((res, rej) => {
            // Set timeout.
            const timer = setTimeout(() => rej(new Error(`Chunk reading timed out:${id}`)), LEAF_WAIT_TIMEOUT);
            if (typeof this.leafArrivedCallbacks[id] == "undefined") {
                this.leafArrivedCallbacks[id] = [];
            }
            this.leafArrivedCallbacks[id].push(() => {
                clearTimeout(timer);
                res(true);
            });
        });
    }

    async getDBLeaf(id: string, waitForReady: boolean): Promise<string> {
        // when in cache, use that.
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
            throw new Error(`Corrupted chunk detected: ${id}`);
        } catch (ex: any) {
            if (isErrorOfMissingDoc(ex)) {
                if (waitForReady) {
                    // just leaf is not ready.
                    // wait for on
                    if ((await this.waitForLeafReady(id)) === false) {
                        throw new Error(`time out (waiting chunk)`);
                    }
                    return this.getDBLeaf(id, false);
                } else {
                    throw new Error(`Chunk was not found: ${id}`);
                }
            } else {
                Logger(`Something went wrong while retrieving chunks`);
                throw ex;
            }
        }
    }

    // eslint-disable-next-line require-await
    async getDBEntryMeta(path: string, opt?: PouchDB.Core.GetOptions, includeDeleted = false): Promise<false | LoadedEntry> {
        return getDBEntryMeta(this, path, opt, includeDeleted);
    }
    // eslint-disable-next-line require-await
    async getDBEntry(path: string, opt?: PouchDB.Core.GetOptions, dump = false, waitForReady = true, includeDeleted = false): Promise<false | LoadedEntry> {
        return getDBEntry(this, path, opt, dump, waitForReady, includeDeleted);
    }
    // eslint-disable-next-line require-await
    async deleteDBEntry(path: string, opt?: PouchDB.Core.GetOptions): Promise<boolean> {
        return deleteDBEntry(this, path, opt);
    }
    // eslint-disable-next-line require-await
    async deleteDBEntryPrefix(prefixSrc: string): Promise<boolean> {
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
        Logger("Local Database Reset", LOG_LEVEL.NOTICE);
    }

    async sanCheck(entry: EntryDoc): Promise<boolean> {
        if (entry.type == "plain" || entry.type == "newnote") {
            const children = entry.children;
            Logger(`sancheck:checking:${entry._id} : ${children.length}`, LOG_LEVEL.VERBOSE);
            try {
                const dc = await this.localDatabase.allDocs({ keys: [...children] });
                if (dc.rows.some((e) => "error" in e)) {
                    this.corruptedEntries[entry._id] = entry;
                    Logger(`sancheck:corrupted:${entry._id} : ${children.length}`, LOG_LEVEL.VERBOSE);
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
            Logger(`Collected handler of ${id} is missing, it might be error but perhaps it already timed out.`, LOG_LEVEL.VERBOSE);
        }
    }
    async collectChunks(ids: string[], showResult = false, waitForReady?: boolean) {

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
        runWithLock("execCollect", true, async () => {
            do {
                const minimumInterval = this.settings.minimumIntervalOfReadChunksOnline; // three requests per second as maximum
                const start = Date.now();
                const requesting = this.collectThrottleQueuedIds.splice(0, this.settings.concurrencyOfReadChunksOnline);
                if (requesting.length == 0) return;
                try {
                    const chunks = await this.CollectChunksInternal(requesting, false);
                    if (chunks) {
                        // Remove duplicated entries.
                        this.collectThrottleQueuedIds = this.collectThrottleQueuedIds.filter(e => !chunks.some(f => f._id == e))
                        for (const chunk of chunks) {
                            this.chunkCollected(chunk);
                        }
                    } else {
                        // TODO: need more explicit message. 
                        Logger(`Could not retrieve chunks`, LOG_LEVEL.NOTICE);
                        for (const id of requesting) {
                            if (id in this.chunkCollectedCallbacks) {
                                this.chunkCollectedCallbacks[id].failed();
                            }
                        }
                    }

                } catch (ex) {
                    Logger(`Exception raised while retrieving chunks`, LOG_LEVEL.NOTICE);
                    Logger(ex, LOG_LEVEL.VERBOSE);
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
    async CollectChunksInternal(ids: string[], showResult = false): Promise<false | EntryLeaf[]> {
        // Fetch local chunks.
        const localChunks = await this.localDatabase.allDocs({ keys: ids, include_docs: true });
        const missingChunks = localChunks.rows.filter(e => "error" in e).map(e => e.key);
        // If we have enough chunks, return them.
        if (missingChunks.length == 0) {
            return localChunks.rows.map(e => e.doc) as EntryLeaf[];
        }

        // Fetching remote chunks.
        const remoteDocs = await this.env.getReplicator().fetchRemoteChunks(missingChunks, showResult)
        if (remoteDocs == false) {
            // Logger(`Could not fetch chunks from the server. `, showResult ? LOG_LEVEL.NOTICE : LOG_LEVEL.INFO, "fetch");
            return false;
        }

        const max = remoteDocs.length;
        remoteDocs.forEach(e => this.hashCaches.set(e._id, (e as EntryLeaf).data));
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
        return localChunks.rows.map(e => ("error" in e) ? (findChunk(e.key)) : e.doc as EntryLeaf);
    }


    async *findEntries(startKey: string, endKey: string, opt: PouchDB.Core.AllDocsWithKeyOptions | PouchDB.Core.AllDocsOptions | PouchDB.Core.AllDocsWithKeysOptions | PouchDB.Core.AllDocsWithinRangeOptions) {
        const pageLimit = 100;
        let nextKey = startKey;
        do {
            const docs = await this.localDatabase.allDocs({ limit: pageLimit, startkey: nextKey, endkey: endKey, include_docs: true, ...opt });
            nextKey = "";
            for (const row of docs.rows) {
                const doc = row.doc;
                nextKey = `${row.id}\u{10ffff}`;
                if (!("type" in doc)) continue;
                if (doc.type == "newnote" || doc.type == "plain") {
                    yield doc;
                }

            }
        } while (nextKey != "");
    }
    async *findAllDocs(opt?: PouchDB.Core.AllDocsWithKeyOptions | PouchDB.Core.AllDocsOptions | PouchDB.Core.AllDocsWithKeysOptions | PouchDB.Core.AllDocsWithinRangeOptions) {
        const f1 = this.findEntries("", "h:", opt ?? {});
        const f2 = this.findEntries(`h:\u{10ffff}`, "", opt ?? {});
        for await (const f of f1) {
            yield f;
        }
        for await (const f of f2) {
            yield f;
        }
    }
    async *findEntryNames(startKey: string, endKey: string, opt: PouchDB.Core.AllDocsWithKeyOptions | PouchDB.Core.AllDocsOptions | PouchDB.Core.AllDocsWithKeysOptions | PouchDB.Core.AllDocsWithinRangeOptions) {
        const pageLimit = 100;
        let nextKey = startKey;
        do {
            const docs = await this.localDatabase.allDocs({ limit: pageLimit, startkey: nextKey, endkey: endKey, ...opt });
            nextKey = "";
            for (const row of docs.rows) {
                nextKey = `${row.id}\u{10ffff}`;
                yield row.id;
            }
        } while (nextKey != "");
    }
    async *findAllDocNames(opt?: PouchDB.Core.AllDocsWithKeyOptions | PouchDB.Core.AllDocsOptions | PouchDB.Core.AllDocsWithKeysOptions | PouchDB.Core.AllDocsWithinRangeOptions) {
        const targets = [
            this.findEntryNames("", "h:", opt ?? {}),
            this.findEntryNames(`h:\u{10ffff}`, "i:", opt ?? {}),
            this.findEntryNames(`i:\u{10ffff}`, "ps:", opt ?? {}),
            this.findEntryNames(`ps:\u{10ffff}`, "", opt ?? {}),

        ]
        for (const target of targets) {
            for await (const f of target) {
                if (f.startsWith("_")) continue;
                if (f == VERSIONINFO_DOCID) continue;
                yield f;
            }
        }

    }
}
