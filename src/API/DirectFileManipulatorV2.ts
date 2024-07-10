/**
 * The API for manipulating files stored in the CouchDB by Self-hosted LiveSync or its families.
 */
import { LRUCache } from "../memory/LRUCache.ts";

import { addPrefix, id2path_base, path2id_base, stripAllPrefixes } from "../string_and_binary/path.ts";
import { type DocumentID, type FilePathWithPrefix, type EntryHasPath, type FilePath, type EntryLeaf, type EntryDoc, LEAF_WAIT_TIMEOUT, type NewEntry, type PlainEntry, type LoadedEntry, DEFAULT_SETTINGS, type HashAlgorithm } from "../common/types.ts";


import { PouchDB } from "../pouchdb/pouchdb-http.ts";
import { deleteDBEntry, getDBEntryFromMeta, getDBEntryMeta, putDBEntry, type DBFunctionEnvironment, type DBFunctionSettings } from "../pouchdb/LiveSyncDBFunctions.ts";
import { enableEncryption, isErrorOfMissingDoc } from "../pouchdb/utils_couchdb.ts";
import { sendValue, waitForValue } from "octagonal-wheels/messagepassing/signal";
import { RESULT_TIMED_OUT } from "octagonal-wheels/common/const.js";
import { LEVEL_INFO, LEVEL_VERBOSE, LOG_LEVEL_INFO, LOG_LEVEL_NOTICE, LOG_LEVEL_VERBOSE, Logger } from "octagonal-wheels/common/logger";
import { QueueProcessor } from "octagonal-wheels/concurrency/processor";
import { createBlob, determineTypeFromBlob, onlyNot } from "../common/utils.ts";
import { xxhashNew } from "octagonal-wheels/hash/xxhash";
export type DirectFileManipulatorOptions = {
    url: string,
    username: string,
    password: string,
    passphrase: string | undefined,
    database: string,
    obfuscatePassphrase: string | undefined,
    useDynamicIterationCount?: boolean,
    customChunkSize?: number,
    minimumChunkSize?: number;
    hashAlg?: HashAlgorithm;
    useEden: boolean;
    maxChunksInEden: number;
    maxTotalLengthInEden: number;
    maxAgeInEden: number;
    enableChunkSplitterV2: boolean;
}

export type ReadyEntry = (NewEntry | PlainEntry) & { data: string[] };
export type MetaEntry = (NewEntry | PlainEntry) & { children: string[] }

function isNoteEntry(doc: EntryDoc | false): doc is NewEntry | PlainEntry {
    if (!doc) return false;
    return doc.type == "newnote" || doc.type == "plain";
}
function isReadyEntry(doc: EntryDoc | false): doc is ReadyEntry {
    if (!doc) return false;
    return "data" in doc;
}
// function isMetaEntry(doc: EntryDoc | false): doc is MetaEntry {
//     if (!doc) return false;
//     return "children" in doc;
// }


export type FileInfo = {
    ctime: number,
    mtime: number,
    size: number,
}

export type EnumerateConditions = {
    startKey?: string, endKey?: string, ids?: string[], metaOnly: boolean
};
const xxhash = await xxhashNew();
export class DirectFileManipulator implements DBFunctionEnvironment {


    options: DirectFileManipulatorOptions;
    hashCaches = new LRUCache<DocumentID, string>(300, 50);

    localDatabase: PouchDB.Database<EntryDoc>;
    constructor(options: DirectFileManipulatorOptions) {
        this.options = options;
        this.localDatabase = new PouchDB(this.options.url + "/" + this.options.database,
            { auth: { username: this.options.username, password: this.options.password } });
        if (this.options.passphrase) {
            enableEncryption(this.localDatabase, this.options.passphrase, this.options.useDynamicIterationCount ?? false, false);
        }

    }
    id2path(id: DocumentID, entry: EntryHasPath, stripPrefix?: boolean): FilePathWithPrefix {
        const path = id2path_base(id, entry);
        if (stripPrefix) {
            return stripAllPrefixes(path);
        }
        return path;
    }
    async path2id(filename: FilePathWithPrefix | FilePath, prefix?: string): Promise<DocumentID> {
        const fileName = prefix ? addPrefix(filename, prefix) : filename;
        const id = await path2id_base(fileName, this.options.obfuscatePassphrase ?? false);
        return id;
    }

    isTargetFile(filenameSrc: string) {
        const file = filenameSrc.startsWith("i:") ? filenameSrc.substring(2) : filenameSrc;
        if (file.startsWith("ix:")) return true;
        if (file.startsWith("ps:")) return true;
        if (file.includes(":")) return false;
        // if (this.settings.syncOnlyRegEx) {
        //     const syncOnly = new RegExp(this.settings.syncOnlyRegEx);
        //     if (!file.match(syncOnly)) return false;
        // }
        // if (this.settings.syncIgnoreRegEx) {
        //     const syncIgnore = new RegExp(this.settings.syncIgnoreRegEx);
        //     if (file.match(syncIgnore)) return false;
        // }
        return true;
    }
    async readChunk(id: DocumentID, timeout: number): Promise<string> {
        const leaf = this.hashCaches.get(id);
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

    get settings() {
        const retObj: DBFunctionSettings = {
            minimumChunkSize: this.options.minimumChunkSize ?? DEFAULT_SETTINGS.minimumChunkSize,
            encrypt: this.options.passphrase ? true : false,
            passphrase: this.options.passphrase ?? "",
            deleteMetadataOfDeletedFiles: DEFAULT_SETTINGS.deleteMetadataOfDeletedFiles,
            customChunkSize: this.options.customChunkSize ?? DEFAULT_SETTINGS.customChunkSize,
            doNotPaceReplication: DEFAULT_SETTINGS.doNotPaceReplication,
            hashAlg: this.options.hashAlg ?? DEFAULT_SETTINGS.hashAlg,
            useEden: this.options.useEden ?? DEFAULT_SETTINGS.useEden,
            maxChunksInEden: this.options.maxChunksInEden ?? DEFAULT_SETTINGS.maxChunksInEden,
            maxTotalLengthInEden: this.options.maxTotalLengthInEden ?? DEFAULT_SETTINGS.maxTotalLengthInEden,
            maxAgeInEden: this.options.maxAgeInEden ?? DEFAULT_SETTINGS.maxAgeInEden,
            enableChunkSplitterV2: this.options.enableChunkSplitterV2 ?? DEFAULT_SETTINGS.enableChunkSplitterV2,
            disableWorkerForGeneratingChunks: true,
            processSmallFilesInUIThread: true,
        }
        return retObj;
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
    }, { batchSize: 100, interval: 100, concurrentLimit: 1, maintainDelay: true, suspended: false });

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

    async collectChunks(ids: string[], showResult = false, waitForReady?: boolean) {
        const localChunks = await this.collectChunksWithCache(ids as DocumentID[]);
        const missingChunks = localChunks.filter(e => !e.chunk).map(e => e.id);
        // If we have enough chunks, return them.
        if (missingChunks.length == 0) {
            return localChunks.map(e => e.chunk) as EntryLeaf[];
        }
        // this._chunkCollectProcessor.batchSize = this.settings.concurrencyOfReadChunksOnline;
        // this._chunkCollectProcessor.interval = this.settings.minimumIntervalOfReadChunksOnline;
        this._chunkCollectProcessor.batchSize = 100;
        this._chunkCollectProcessor.interval = 100;
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
        } else {
            return false;
        }
    }
    h32(input: string, seed?: number): string {
        return xxhash.h32ToString(input, seed);
    }
    h32Raw(input: Uint8Array, seed?: number): number {
        return xxhash.h32Raw(input, seed);
    }
    xxhash32(input: string, seed?: number): number {
        return xxhash.h32(input, seed);
    }
    xxhash64 = (input: string) => xxhash.h64(input)
    isOnDemandChunkEnabled = false;


    /**
    * Get specific document from the Remote Database by path.
    * @param path 
    * @param metaOnly if it has been enabled, the note does not contains the content.
    * @returns 
    */
    async get(path: FilePathWithPrefix, metaOnly = false) {
        Logger(`GET: START: ${path}`, LOG_LEVEL_VERBOSE)
        const meta = await getDBEntryMeta(this, path);
        if (!isNoteEntry(meta)) return false;
        if (metaOnly) return meta;
        const ret = await getDBEntryFromMeta(this, meta);
        Logger(`GET: DONE: ${path}`, LEVEL_INFO);
        return ret;
    }

    /**
     * Get specific document from the Remote Database by ID.
     * @param path 
     * @param metaOnly if it has been enabled, the note does not contains the content.
     * @returns 
     */
    async getById(id: string, metaOnly = false): Promise<false | MetaEntry | ReadyEntry> {
        // TODO: TREAT FOR CONFLICTED FILES or OLD REVISIONS.
        // Logger(`GET: START: ${id}`, LOG_LEVEL_VERBOSE)
        const meta = await getDBEntryMeta(this, id as FilePathWithPrefix);
        if (!isNoteEntry(meta)) return false;
        if (metaOnly) {
            // Logger(`GET: DONE (METAONLY): ${id}`, LOG_LEVEL_INFO)
            return meta;
        }
        return this.getByMeta(meta);
    }
    async getByMeta(doc: MetaEntry): Promise<ReadyEntry> {
        const docX = await getDBEntryFromMeta(this, doc as LoadedEntry);
        if (!isReadyEntry(docX)) {
            throw new Error(`Corrupted document: ${doc.path}`);
        }
        return docX;
    }

    /**
     * Put a note to the remote database
     * @param path 
     * @param data 
     * @param info 
     * @param type 
     * @returns 
     */
    async put(path: string, data: string[] | Blob, info: FileInfo, type: "newnote" | "plain" = "plain") {
        const id = await this.path2id(path as FilePathWithPrefix);
        const saveData = data instanceof Blob ? data : createBlob(data);
        const datatype = determineTypeFromBlob(saveData);
        const putDoc = {
            _id: id,
            path: path as FilePathWithPrefix,
            data: saveData,
            ctime: info.ctime,
            mtime: info.mtime,
            size: info.size,
            type: datatype,
            eden: {},
            children: [] as string[],
            datatype: datatype
        }
        Logger(`PUT: UPLOADING: ${path}`, LOG_LEVEL_VERBOSE);
        const ret = await putDBEntry(this, putDoc);
        if (ret) {
            Logger(`PUT: DONE: ${path}`, LOG_LEVEL_INFO);
            return true;
        } else {
            Logger(`PUT: FAILED: ${path}`, LOG_LEVEL_NOTICE);
            return false;
        }
    }

    async delete(path: string) {
        Logger(`DELETE: START: ${path}`, LOG_LEVEL_VERBOSE);
        const ret = await deleteDBEntry(this, path as FilePathWithPrefix);
        if (ret) {
            Logger(`DELETE: DONE: ${path}`, LOG_LEVEL_INFO);
            return true;
        } else {
            Logger(`DELETE: FAILED: ${path}`, LOG_LEVEL_INFO);
            return false;
        }
    }
    // Untested
    async *enumerate(cond: EnumerateConditions) {
        //TODO
        // const param = {} as Record<string, string>;
        // if (cond.startKey) param.startkey = cond.startKey;
        // if (cond.endKey) param.endkey = cond.endKey;
        // if (cond.ids) param.keys = JSON.stringify(cond.ids);

        // let key = cond.startKey;
        // do {
        //     const result = await this._fetchJson(["_all_docs"], {}, "get", { ...param, include_docs: true, startkey: key, limit: 100 });
        //     if (!result.rows || result.rows.length == 0) {
        //         break;
        //     }
        //     //there are some result
        //     for (const v of result.rows) {
        //         const doc = v.doc;
        //         if (cond.metaOnly) {
        //             yield await doc;
        //         } else {
        //             yield await this.getByMeta(doc);
        //         }
        //         key = doc._id + "\u{10ffff}"
        //     }
        // } while (true);
        // return;
    }
    async *_enumerate(startKey: string, endKey: string, opt: { metaOnly: boolean }) {
        const pageLimit = 100;
        let nextKey = startKey;
        let req = this.localDatabase.allDocs({ limit: pageLimit, startkey: nextKey, endkey: endKey, include_docs: true, ...opt });
        do {
            const docs = await req;
            if (docs.rows.length === 0) {
                break;
            }
            nextKey = `${docs.rows[docs.rows.length - 1].id}`;
            req = this.localDatabase.allDocs({ limit: pageLimit, skip: 1, startkey: nextKey, endkey: endKey, include_docs: true, ...opt });
            for (const row of docs.rows) {
                const doc = row.doc;
                //@ts-ignore: non null by include_docs
                if (!("type" in doc)) continue;
                if (isNoteEntry(doc)) {
                    if (opt.metaOnly) {
                        yield doc;
                    } else {
                        yield await this.getByMeta(doc);
                    }
                }

            }
        } while (nextKey != "");
    }
    async *enumerateAllNormalDocs(opt: { metaOnly: boolean }) {
        // const opt = {};
        const targets = [
            this._enumerate("", "h:", opt),
            this._enumerate(`h:\u{10ffff}`, "i:", opt),
            this._enumerate(`i:\u{10ffff}`, "ix:", opt),
            this._enumerate(`ix:\u{10ffff}`, "ps:", opt),
            this._enumerate(`ps:\u{10ffff}`, "\u{10ffff}", opt),
        ]
        for (const target of targets) {
            for await (const f of target) {
                yield f;
            }
        }
    }


    watching = false;
    // _abortController?: AbortController;
    changes: PouchDB.Core.Changes<EntryDoc> | undefined;
    since = "";

    beginWatch(callback: (doc: ReadyEntry, seq?: string | number) => Promise<any> | void, checkIsInterested?: (doc: MetaEntry) => boolean) {
        if (this.watching) return false;
        this.watching = true;
        this.changes = this.localDatabase.changes(
            {
                include_docs: true,
                since: this.since,
                filter: "replicate/pull",
                live: true
            }
        ).on("change", async (change) => {
            const doc = change.doc;
            if (!doc) {
                return;
            }
            if (!isNoteEntry(doc)) {
                return;
            }
            if (checkIsInterested) {
                if (!checkIsInterested(doc)) {
                    Logger(`WATCH: SKIP ${doc._id}: OUT OF TARGET FOLDER`, LOG_LEVEL_VERBOSE, "watch");
                    return;
                }
            }
            Logger(`WATCH: PROCESSING: ${doc.path}`, LEVEL_VERBOSE, "watch");
            const docX = await this.getByMeta(doc);
            try {
                await callback(docX, change.seq);
                Logger(`WATCH: PROCESS DONE: ${doc.path}`, LEVEL_INFO, "watch");
            } catch (ex) {
                Logger(`WATCH: PROCESS FAILED`, LEVEL_INFO, "watch");
                Logger(ex, LEVEL_VERBOSE, "watch");
            }
        }).on("complete", () => {
            Logger(`WATCH: FINISHED`, LEVEL_INFO, "watch");
            this.watching = false;
            this.changes = undefined;
        }).on("error", err => {
            Logger(`WATCH: ERROR: ${err}`, LEVEL_INFO, "watch");
            if (this.watching) {
                Logger(`WATCH: CONNECTION HAS BEEN CLOSED, RECONNECTING...`, LEVEL_INFO, "watch");
                this.watching = false;
                this.changes = undefined;
                setTimeout(() => {
                    this.beginWatch(callback, checkIsInterested);
                }, 10000)
            } else {
                Logger(`WATCH: CONNECTION HAS BEEN CLOSED.`, LEVEL_INFO, "watch");
            }
        });
    }
    endWatch() {
        if (this.changes) {
            Logger(`WATCH: CANCELLING PROCESS.`, LEVEL_INFO, "watch");
            this.changes.cancel();
            Logger(`WATCH: CANCELLING SIGNAL HAS BEEN SENT.`, LEVEL_INFO, "watch");
        }
    }
    async followUpdates(callback: (doc: ReadyEntry, seq?: string | number) => Promise<any> | void, checkIsInterested?: (doc: MetaEntry) => boolean) {
        try {
            if (this.since == "") {
                this.since = "0";
            }
            Logger(`FOLLOW: START: (since:${this.since})`, LEVEL_INFO, "followUpdates");
            const last = await this.localDatabase.changes(
                {
                    include_docs: true,
                    since: this.since,
                    filter: "replicate/pull",
                    live: false
                }
            ).on("change", async (change) => {
                const doc = change.doc;
                if (!doc) {
                    return;
                }
                if (!isNoteEntry(doc)) {
                    return;
                }
                if (checkIsInterested) {
                    if (!checkIsInterested(doc)) {
                        Logger(`FOLLOW: SKIP ${doc._id}: OUT OF TARGET FOLDER`, LOG_LEVEL_VERBOSE, "watch");
                        return;
                    }
                }
                Logger(`FOLLOW: PROCESSING: ${doc.path}`, LEVEL_VERBOSE, "watch");
                const docX = await this.getByMeta(doc);
                try {
                    await callback(docX, change.seq);
                    Logger(`FOLLOW: PROCESS DONE: ${doc.path}`, LEVEL_INFO, "watch");
                } catch (ex) {
                    Logger(`FOLLOW: PROCESS FAILED`, LEVEL_INFO, "watch");
                    Logger(ex, LEVEL_VERBOSE, "watch");
                }
            }).on("complete", () => {
                Logger(`FOLLOW: FINISHED AT ${this.since}`, LEVEL_INFO, "watch");
                this.watching = false;
                this.changes = undefined;
            }).on("error", err => {
                Logger(`FOLLOW: ERROR at ${this.since}: ${err}`, LEVEL_INFO, "watch");
            });
            return last.last_seq;
        } catch (e) {
            Logger(`FOLLOW: ERROR: ${e}`, LEVEL_INFO, "watch");
        }
        return this.since;
    }
}
