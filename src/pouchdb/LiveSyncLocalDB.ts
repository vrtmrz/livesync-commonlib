// 

import { xxhashOld, xxhashNew, sha1 } from "octagonal-wheels/hash/xxhash";
import {
    type EntryDoc,
    type EntryLeaf, type LoadedEntry,
    type Credential,
    LEAF_WAIT_TIMEOUT, VERSIONING_DOCID,
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
    type EntryDocResponse,
    type EntryBase,
    type NoteEntry,
    type EdenChunk,
    type AnyEntry,
    MAX_DOC_SIZE_BIN,
    PREFIX_CHUNK,
    type PlainEntry,
    type NewEntry,
    type UXFileInfo,
    type diff_result_leaf,
    MISSING_OR_ERROR,
    NOT_CONFLICTED,
    LOG_LEVEL_INFO,
    type DIFF_CHECK_RESULT_AUTO,
} from "../common/types.ts";
import { applyPatch, createTextBlob, determineTypeFromBlob, flattenObject, generatePatchObj, getDocData, isObjectMargeApplicable, isSensibleMargeApplicable, isTextBlob, onlyNot, sendValue, tryParseJSON, unique, waitForValue } from "../common/utils.ts";
import { Logger } from "../common/logger.ts";
import { isErrorOfMissingDoc } from "./utils_couchdb.ts";
import { LRUCache } from "../memory/LRUCache.ts";

import type { LiveSyncAbstractReplicator } from "../replication/LiveSyncAbstractReplicator.ts";
import { decodeBinary, readString, writeString } from "../string_and_binary/convert.ts";
import { QueueProcessor } from "../concurrency/processor.ts";
import { collectingChunks } from "../mock_and_interop/stores.ts";
import { shouldSplitAsPlainText, stripAllPrefixes } from "../string_and_binary/path.ts";
import { serialized } from "../concurrency/lock.ts";
import { splitPieces2, splitPieces2V2 } from "../string_and_binary/chunks.ts";
import { splitPieces2Worker, splitPieces2WorkerV2 } from "../worker/bgWorker.ts";
import { DIFF_DELETE, DIFF_EQUAL, DIFF_INSERT, diff_match_patch, type Diff } from "diff-match-patch";


export interface LiveSyncLocalDBEnv {
    $$id2path(id: DocumentID, entry: EntryHasPath, stripPrefix?: boolean): FilePathWithPrefix;
    $$path2id(filename: FilePathWithPrefix | FilePath, prefix?: string): Promise<DocumentID>;
    $$createPouchDBInstance<T extends object>(name?: string, options?: PouchDB.Configuration.DatabaseConfiguration): PouchDB.Database<T>

    $allOnDBUnload(db: LiveSyncLocalDB): void;
    $allOnDBClose(db: LiveSyncLocalDB): void;
    $everyOnInitializeDatabase(db: LiveSyncLocalDB): Promise<boolean>;
    $everyOnResetDatabase(db: LiveSyncLocalDB): Promise<boolean>;
    $$getReplicator: () => LiveSyncAbstractReplicator;
    getSettings(): RemoteDBSettings;

}


function getNoFromRev(rev: string) {
    if (!rev) return 0;
    return parseInt(rev.split("-")[0]);
}

function createChunkRev(chunk: EntryLeaf) {

    const lenC = Math.imul(chunk.data.length, 21 + (chunk._id.charCodeAt(5)));

    return `1-${(lenC.toString(16) + ("0".repeat(32))).slice(0, 32)}`;
}

type GeneratedChunk = {
    isNew: boolean,
    id: DocumentID,
    piece: string
}


export class LiveSyncLocalDB {
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

    async _prepareHashFunctions() {
        if (this.h32 != null) return;
        if (this.settings.hashAlg == "sha1") {
            Logger(`Fallback(SHA1) is used for hashing`, LOG_LEVEL_VERBOSE);
            return;
        }
        try {
            const { h32ToString, h32Raw, h32, h64 } = await xxhashNew();
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
                const { h32, h32Raw } = (await xxhashOld());
                this.h32 = h32 as typeof xxhashNew.prototype.h32ToString;
                this.h32Raw = h32Raw;
                this.xxhash32 = (str) => h32Raw(writeString(str));
            } catch (ex) {
                Logger(`Could not initialise xxhash: use sha1F`, LOG_LEVEL_VERBOSE);
                Logger(ex);
                this.settings.hashAlg = "sha1";
            }

        }
    }

    get isOnDemandChunkEnabled() {
        if (this.settings.remoteType !== REMOTE_COUCHDB) {
            return false
        }
        return this.settings.readChunksOnline;
    }

    onunload() {
        //this.kvDB.close();
        this.env.$allOnDBUnload(this);
        this.changeHandler?.cancel();
        void this.changeHandler?.removeAllListeners();
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
        return this.env.$$id2path(id, entry, stripPrefix);
    }
    async path2id(filename: FilePathWithPrefix | FilePath, prefix?: string): Promise<DocumentID> {
        return await this.env.$$path2id(filename, prefix);
    }

    async close() {
        Logger("Database closed (by close)");
        this.isReady = false;
        this.changeHandler?.cancel();
        void this.changeHandler?.removeAllListeners();
        if (this.localDatabase != null) {
            await this.localDatabase.close();
        }
        this.env.$allOnDBClose(this);
    }


    async initializeDatabase(): Promise<boolean> {
        await this._prepareHashFunctions();
        if (this.localDatabase != null) await this.localDatabase.close();
        this.changeHandler?.cancel();
        await this.changeHandler?.removeAllListeners();
        //@ts-ignore
        this.localDatabase = null;

        this.localDatabase = this.env.$$createPouchDBInstance<EntryDoc>(this.dbname + "-livesync-v2", {
            auto_compaction: false,
            revs_limit: 100,
            deterministic_revs: true,
        });
        if (!await this.env.$everyOnInitializeDatabase(this)) {
            Logger("Initializing Database has been failed on some module", LOG_LEVEL_NOTICE);
            // TODO ask for continue or disable all.
            // return false;
        }
        Logger("Opening Database...");
        Logger("Database info", LOG_LEVEL_VERBOSE);
        Logger(await this.localDatabase.info(), LOG_LEVEL_VERBOSE);
        this.localDatabase.on("close", () => {
            Logger("Database closed.");
            this.isReady = false;
            this.localDatabase.removeAllListeners();
            this.env.$$getReplicator()?.closeReplication();
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


    async getChunk(piece: string, doc: SavingEntry): Promise<GeneratedChunk | false> {
        const cachedChunkId = this.hashCaches.revGet(piece);
        if (cachedChunkId !== undefined) {
            return { isNew: false, id: cachedChunkId, piece: piece };
        }
        const chunkId = PREFIX_CHUNK + await this.generateHashedChunk(piece) as DocumentID;
        if (chunkId in doc.eden) {
            return { isNew: false, id: chunkId, piece: piece };
        }
        const cachedPiece = this.hashCaches.get(chunkId);
        if (cachedPiece && cachedPiece != piece) {
            Logger(`Hash collided! If possible, please report the following string:${chunkId}=>\nA:--${cachedPiece}--\nB:--${piece}--`, LOG_LEVEL_NOTICE);
            return false;
        }
        this.hashCaches.set(chunkId, piece);
        return { isNew: true, id: chunkId, piece: piece };
    }

    async generateHashedChunk(piece: string) {
        const userPassphrase = this.settings.passphrase;
        if (this.settings.hashAlg == "sha1") {
            if (this.settings.encrypt) {
                return "+" + await sha1(`${piece}-${userPassphrase}-${piece.length}`);
            } else {
                return await sha1(`${piece}-${piece.length}`);
            }
        } else if (this.settings.hashAlg === "") {
            if (this.settings.encrypt) {
                const userPasswordHash = this.h32Raw(new TextEncoder().encode(userPassphrase));
                return "+" + (this.h32Raw(new TextEncoder().encode(piece)) ^ userPasswordHash ^ piece.length).toString(36);
            } else {
                return (this.h32Raw(new TextEncoder().encode(piece)) ^ piece.length).toString(36);
            }
        } else if (this.settings.hashAlg == "xxhash64" && this.xxhash64) {
            if (this.settings.encrypt) {
                return "+" + ((this.xxhash64(`${piece}-${userPassphrase}-${piece.length}`)).toString(36));
            } else {
                return this.xxhash64(`${piece}-${piece.length}`).toString(36);
            }
        } else {
            // If we could not use xxhash64, fall back to the 32bit impl.
            // It may happen on iOS before 14.
            if (this.settings.encrypt) {
                return "+" + this.xxhash32(`${piece}-${userPassphrase}-${piece.length}`).toString(36);
            } else {
                return this.xxhash32(`${piece}-${piece.length}`).toString(36);
            }
        }

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

    async getDBEntryMeta(path: FilePathWithPrefix | FilePath, opt?: PouchDB.Core.GetOptions, includeDeleted = false): Promise<false | LoadedEntry> {
        // safety valve
        if (!this.isTargetFile(path)) {
            return false;
        }
        const id = await this.path2id(path);
        try {
            let obj: EntryDocResponse | null = null;
            if (opt) {
                obj = await this.localDatabase.get(id, opt);
            } else {
                obj = await this.localDatabase.get(id);
            }
            const deleted = (obj as any)?.deleted ?? obj._deleted ?? undefined;
            if (!includeDeleted && deleted) return false;
            if (obj.type && obj.type == "leaf") {
                //do nothing for leaf;
                return false;
            }

            // retrieve metadata only
            if (!obj.type || (obj.type && obj.type == "notes") || obj.type == "newnote" || obj.type == "plain") {
                const note = obj as EntryBase;
                let children: string[] = [];
                let type: "plain" | "newnote" = "plain";
                if (obj.type == "newnote" || obj.type == "plain") {
                    children = obj.children;
                    type = obj.type;
                }
                const doc: LoadedEntry & PouchDB.Core.IdMeta & PouchDB.Core.GetMeta = {
                    data: "",
                    _id: (note as EntryDoc)._id,
                    path: path,
                    ctime: note.ctime,
                    mtime: note.mtime,
                    size: note.size,
                    // _deleted: obj._deleted,
                    _rev: obj._rev,
                    _conflicts: obj._conflicts,
                    children: children,
                    datatype: type,
                    deleted: deleted,
                    type: type,
                    eden: "eden" in obj ? obj.eden : {},
                };
                return doc;
            }
        } catch (ex: any) {
            if (isErrorOfMissingDoc(ex)) {
                return false;
            }
            throw ex;
        }
        return false;
    }

    async getDBEntry(path: FilePathWithPrefix | FilePath, opt?: PouchDB.Core.GetOptions, dump = false, waitForReady = true, includeDeleted = false): Promise<false | LoadedEntry> {
        const meta = await this.getDBEntryMeta(path, opt, includeDeleted);
        if (meta) {
            return await this.getDBEntryFromMeta(meta, opt, dump, waitForReady, includeDeleted);
        } else {
            return false;
        }
    }
    async getDBEntryFromMeta(meta: LoadedEntry, opt?: PouchDB.Core.GetOptions, dump = false, waitForReady = true, includeDeleted = false): Promise<false | LoadedEntry> {
        const filename = this.id2path(meta._id, meta);
        if (!this.isTargetFile(filename)) {
            return false;
        }
        const dispFilename = stripAllPrefixes(filename)
        const deleted = meta.deleted ?? meta._deleted ?? undefined;
        if (!meta.type || (meta.type && meta.type == "notes")) {
            const note = meta as NoteEntry;
            const doc: LoadedEntry & PouchDB.Core.IdMeta = {
                data: note.data,
                path: note.path,
                _id: note._id,
                ctime: note.ctime,
                mtime: note.mtime,
                size: note.size,
                // _deleted: obj._deleted,
                _rev: meta._rev,
                _conflicts: meta._conflicts,
                children: [],
                datatype: "newnote",
                deleted: deleted,
                type: "newnote",
                eden: "eden" in meta ? meta.eden : {}
            };
            if (dump) {
                Logger(`--Old fashioned document--`);
                Logger(doc);
            }

            return doc;
            // simple note
        }
        if (meta.type == "newnote" || meta.type == "plain") {
            if (dump) {
                const conflicts = await this.localDatabase.get(meta._id, { conflicts: true, revs_info: true });
                Logger("-- Conflicts --");
                Logger(conflicts._conflicts ?? "No conflicts");
                Logger("-- Revs info -- ");
                Logger(conflicts._revs_info);
            }
            // search children
            try {
                if (dump) {
                    Logger(`--Bare document--`);
                    Logger(meta);
                }

                // let children: string[] = [];
                // Acquire semaphore to pace replication.
                // const weight = Math.min(10, Math.ceil(obj.children.length / 10)) + 1;
                // const resourceSemaphore = this.settings.doNotPaceReplication ? (() => { }) : await globalConcurrencyController.acquire(weight);
                const childrenKeys = [...meta.children] as DocumentID[];
                const loadedChildrenMap = new Map<DocumentID, string>();
                if (meta.eden) {
                    const all = Object.entries((meta.eden));
                    all.forEach(([key, chunk]) => loadedChildrenMap.set(key as DocumentID, chunk.data));
                }
                const missingChunks = unique(childrenKeys).filter(e => !loadedChildrenMap.has(e));
                if (missingChunks.length != 0) {
                    if (this.isOnDemandChunkEnabled) {
                        const items = await this.collectChunks(missingChunks, false, waitForReady);
                        if (!items || items.some(leaf => leaf.type != "leaf")) {
                            Logger(`Chunks of ${dispFilename} (${meta._id.substring(0, 8)}) are not valid. (p1)`, LOG_LEVEL_NOTICE);
                            if (items) {
                                Logger(`Missing chunks: ${items.map(e => e._id).join(",")}`, LOG_LEVEL_VERBOSE);
                            }
                            return false;
                        }
                        items.forEach(chunk => loadedChildrenMap.set(chunk._id, chunk.data));
                    } else {
                        try {
                            if (waitForReady) {
                                const loadedItems = await Promise.all(missingChunks.map((e) => this.getDBLeaf(e, waitForReady)));
                                loadedItems.forEach((value, idx) => loadedChildrenMap.set(missingChunks[idx], value));
                            } else {
                                const chunkDocs = await this.localDatabase.allDocs({ keys: missingChunks, include_docs: true });
                                if (chunkDocs.rows.some(e => "error" in e)) {
                                    const missingChunks = chunkDocs.rows.filter(e => "error" in e).map(e => e.key).join(", ");
                                    Logger(`Chunks of ${dispFilename} (${meta._id.substring(0, 8)}) are not valid. (p2)`, LOG_LEVEL_NOTICE);
                                    Logger(`Missing chunks: ${missingChunks}`, LOG_LEVEL_VERBOSE);
                                    return false;
                                }
                                if (chunkDocs.rows.some((e: any) => e.doc && e.doc.type != "leaf")) {
                                    const missingChunks = chunkDocs.rows.filter((e: any) => e.doc && e.doc.type != "leaf").map((e: any) => e.id).join(", ");
                                    Logger(`Chunks of ${dispFilename} (${meta._id.substring(0, 8)}) are not valid. (p3)`, LOG_LEVEL_NOTICE);
                                    Logger(`Corrupted chunks: ${missingChunks}`, LOG_LEVEL_VERBOSE);
                                    return false;
                                }
                                chunkDocs.rows.forEach((value, idx) => "doc" in value && loadedChildrenMap.set((value.doc as EntryLeaf)._id, (value.doc as EntryLeaf).data));
                            }
                        } catch (ex) {
                            Logger(`Something went wrong on reading chunks of ${dispFilename}(${meta._id.substring(0, 8)}) from database, see verbose info for detail.`, LOG_LEVEL_NOTICE);
                            Logger(ex, LOG_LEVEL_VERBOSE);
                            return false;
                        }
                    }
                }
                const l = childrenKeys.map(e => loadedChildrenMap.get(e));
                if (l.some(e => e === undefined)) {
                    // TODO EXACT MESSAGE
                    throw new Error("Load failed");
                }

                const doc: LoadedEntry & PouchDB.Core.IdMeta = {
                    data: l as string[],
                    path: meta.path,
                    _id: meta._id,
                    ctime: meta.ctime,
                    mtime: meta.mtime,
                    size: meta.size,
                    _rev: meta._rev,
                    children: meta.children,
                    datatype: meta.type,
                    _conflicts: meta._conflicts,
                    eden: meta.eden,
                    deleted: deleted,
                    type: meta.type
                };
                if (dump) {
                    Logger(`--Loaded Document--`);
                    Logger(doc);
                }
                return doc;
            } catch (ex: any) {
                if (isErrorOfMissingDoc(ex)) {
                    Logger(`Missing document content!, could not read ${dispFilename}(${meta._id.substring(0, 8)}) from database.`, LOG_LEVEL_NOTICE);
                    return false;
                }
                Logger(`Something went wrong on reading ${dispFilename}(${meta._id.substring(0, 8)}) from database:`, LOG_LEVEL_NOTICE);
                Logger(ex);
            }
        }
        return false;
    }

    async deleteDBEntry(path: FilePathWithPrefix | FilePath, opt?: PouchDB.Core.GetOptions): Promise<boolean> {
        // safety valve
        if (!this.isTargetFile(path)) {
            return false;
        }
        const id = await this.path2id(path);
        try {
            return await serialized("file:" + path, async () => {
                let obj: EntryDocResponse | null = null;
                if (opt) {
                    obj = await this.localDatabase.get(id, opt);
                } else {
                    obj = await this.localDatabase.get(id);
                }
                const revDeletion = opt && (("rev" in opt ? opt.rev : "") != "");

                if (obj.type && obj.type == "leaf") {
                    //do nothing for leaf;
                    return false;
                }
                //Check it out and fix docs to regular case
                if (!obj.type || (obj.type && obj.type == "notes")) {
                    obj._deleted = true;
                    const r = await this.localDatabase.put(obj, { force: !revDeletion });
                    Logger(`Entry removed:${path} (${obj._id.substring(0, 8)}-${r.rev})`);
                    return true;

                    // simple note
                }
                if (obj.type == "newnote" || obj.type == "plain") {
                    if (revDeletion) {
                        obj._deleted = true;
                    } else {
                        obj.deleted = true;
                        obj.mtime = Date.now();
                        if (this.settings.deleteMetadataOfDeletedFiles) {
                            obj._deleted = true;
                        }
                    }
                    const r = await this.localDatabase.put(obj, { force: !revDeletion });

                    Logger(`Entry removed:${path} (${obj._id.substring(0, 8)}-${r.rev})`);
                    return true;
                } else {
                    return false;
                }
            }) ?? false;
        } catch (ex: any) {
            if (isErrorOfMissingDoc(ex)) {
                return false;
            }
            throw ex;
        }
    }
    // eslint-disable-next-line require-await
    async deleteDBEntryPrefix(prefix: FilePathWithPrefix | FilePath): Promise<boolean> {
        // delete database entries by prefix.
        // it called from folder deletion.
        let c = 0;
        let readCount = 0;
        const delDocs: DocumentID[] = [];
        do {
            const result = await this.localDatabase.allDocs({
                include_docs: false,
                skip: c,
                limit: 100,
                conflicts: true
            });
            readCount = result.rows.length;
            if (readCount > 0) {
                //there are some result
                for (const v of result.rows) {
                    const decodedPath = this.id2path(v.id as DocumentID, v.doc as LoadedEntry);
                    // let doc = v.doc;
                    if (decodedPath.startsWith(prefix)) {
                        if (this.isTargetFile(decodedPath)) delDocs.push(v.id as DocumentID);
                        // console.log("!" + v.id);
                    } else {
                        if (!v.id.startsWith("h:")) {
                            // console.log("?" + v.id);
                        }
                    }
                }
            }
            c += readCount;
        } while (readCount != 0);
        // items collected.
        //bulk docs to delete?
        let deleteCount = 0;
        let notfound = 0;
        for (const v of delDocs) {
            try {
                await serialized("file:" + v, async () => {
                    const item = await this.localDatabase.get(v);
                    if (item.type == "newnote" || item.type == "plain") {
                        item.deleted = true;
                        if (this.settings.deleteMetadataOfDeletedFiles) {
                            item._deleted = true;
                        }
                        item.mtime = Date.now();
                    } else {
                        item._deleted = true;
                    }
                    await this.localDatabase.put(item, { force: true });
                });

                deleteCount++;
            } catch (ex: any) {
                if (isErrorOfMissingDoc(ex)) {
                    notfound++;
                    // NO OP. It should be timing problem.
                } else {
                    throw ex;
                }
            }
        }
        Logger(`deleteDBEntryPrefix:deleted ${deleteCount} items, skipped ${notfound}`);
        return true;
    }

    async putDBEntry(note: SavingEntry, onlyChunks?: boolean) {
        //safety valve
        const filename = this.id2path(note._id, note);
        const dispFilename = stripAllPrefixes(filename);

        //prepare eden
        if (!note.eden) note.eden = {};

        if (!this.isTargetFile(filename)) {
            Logger(`File skipped:${dispFilename}`, LOG_LEVEL_VERBOSE);
            return false;
        }
        let processed = 0;
        const maxChunkSize = Math.floor(MAX_DOC_SIZE_BIN * ((this.settings.customChunkSize || 0) * 1 + 1));
        const pieceSize = maxChunkSize;
        let plainSplit = false;

        const minimumChunkSize = this.settings.minimumChunkSize;

        // const now = Date.now();
        // const diff = now - note.mtime;
        // If enough old, store it as `stable` file.
        // A Stable file will not be split as text, but simply by pieceSize. Because it might not need to transfer differences
        // -- Disabled for now because it has a problem with storage consumption.
        const isStable = false;//(diff > 1000 * 3600 * 24 * 30);
        if (isStable) {
            plainSplit = false;
        } else if (shouldSplitAsPlainText(filename)) {
            plainSplit = true;
        }

        // Set datatype again for modified datatype.
        const data = (note.data instanceof Blob) ? note.data : createTextBlob(note.data);
        note.type = isTextBlob(data) ? "plain" : "newnote";
        note.datatype = note.type;
        const maxSize = 1024;

        const splitFuncInMainThread = (this.settings.enableChunkSplitterV2 ? splitPieces2V2 : splitPieces2);
        const splitFuncInWorker = (this.settings.enableChunkSplitterV2 ? splitPieces2WorkerV2 : splitPieces2Worker);

        const splitFunc = this.settings.disableWorkerForGeneratingChunks ? splitFuncInMainThread
            : (this.settings.processSmallFilesInUIThread && note.data.size < maxSize) ? splitFuncInMainThread : splitFuncInWorker;

        const pieces = await splitFunc(data, pieceSize, plainSplit, minimumChunkSize, filename, this.settings.useSegmenter);
        const chunkTasks = [];

        for await (const piece of pieces()) {
            processed++;
            chunkTasks.push(this.getChunk(piece, note));
        }
        const chunks = await Promise.all(chunkTasks);
        if (chunks.some(e => e === false)) {
            Logger(`This document could not be saved:${dispFilename}`, LOG_LEVEL_NOTICE);
            return false;
        }

        let eden = {} as Record<DocumentID, EdenChunk>;
        let currentRevAsNo = 0;

        if ("eden" in note) {
            eden = note.eden;
        }
        // Load old document meta
        let newChunks = [] as EntryLeaf[];

        if (this.settings.useEden && !onlyChunks) {
            try {
                const old = await this.localDatabase.get<AnyEntry>(note._id);
                currentRevAsNo = getNoFromRev((old._rev));
                const oldEden = "eden" in old ? old.eden : {}
                eden = { ...oldEden, ...eden }
            } catch (ex) {
                if (isErrorOfMissingDoc((ex))) {
                    // NO OP.
                } else {
                    throw ex;
                }
            }
            const chunkOnEdenInitial = Object.keys(eden).length;
            let removedChunkOnEden = 0;
            // Remove unused chunk in eden
            const oldEdenChunks = Object.keys(eden);
            const removeEdenChunks = oldEdenChunks.filter(e => (chunks as GeneratedChunk[]).every(c => c.id !== e));
            for (const removeId of removeEdenChunks) {
                removedChunkOnEden++;
                delete eden[removeId as DocumentID];
            }



            let newChunkOnEden = 0;
            let existChunkOnEden = 0;
            // Add chunks in Eden
            for (const chunk of chunks as GeneratedChunk[]) {
                if (chunk.id in eden) {
                    // NO OP
                    existChunkOnEden++;
                } else {
                    newChunkOnEden++;
                    eden[chunk.id] = {
                        epoch: currentRevAsNo + 1,
                        data: chunk.piece
                    }
                }
            }

            /*
            [design_docs_of_keep_newborn_chunks.md]
            1. Those that have already been confirmed to exist as independent chunks.
                 This confirmation of existence may ideally be determined by a fast first-order determination, e.g. by a Bloom filter.
            2. Those whose length exceeds the configured maximum length.
            3. Those have aged over the configured value, since epoch at the operating revision.
            4. Those whose total length, when added up when they are arranged in reverse order of the revision in which they were generated, is after the point at which they exceed the max length in the configuration. Or, those after the configured maximum items.
            */
            // Find the chunks which should be graduated
            const allEdenChunks = Object.entries(eden).sort((a, b) => b[1].epoch - a[1].epoch);
            let totalLength = 0;
            let count: number = 0;
            const allEdenChunksKey = Object.keys(eden);
            let alreadyIndependent = 0;
            let independent = 0;
            //No.1
            const edenChunkExist = await this.localDatabase.allDocs({ keys: allEdenChunksKey as DocumentID[] });
            const edenChunkOnDB = edenChunkExist.rows.reduce((p, c) => ({ ...p, [c.key]: c }), {} as Record<string, any>);
            for (const [key, chunk] of allEdenChunks) {
                count++;
                let makeChunkIndependent = false;
                // const head = `${count}:${key}->(${chunk.epoch}) `;
                // No.1
                if (key in edenChunkOnDB && !edenChunkOnDB[key].error) {
                    count--;
                    delete eden[key as DocumentID];
                    //Logger(`${head}: Already exists`, LOG_LEVEL_VERBOSE);
                    alreadyIndependent++;
                    continue;
                }
                if (chunk.data.length > 1024) {
                    // No.2
                    makeChunkIndependent = true;
                    // Logger(`${head}: Too big to be in Eden`, LOG_LEVEL_VERBOSE);
                } else if (chunk.epoch + this.settings.maxAgeInEden < currentRevAsNo) {
                    // NO.3
                    makeChunkIndependent = true;
                    // Logger(`${head}: Graduation from Eden`, LOG_LEVEL_VERBOSE);
                }
                if (totalLength > this.settings.maxTotalLengthInEden) {
                    // No.4 - 1
                    makeChunkIndependent = true;
                    // Logger(`${head}: No more space in Eden`, LOG_LEVEL_VERBOSE);
                }
                if (count > this.settings.maxChunksInEden) {
                    // No.4-2
                    makeChunkIndependent = true;
                    // Logger(`${head}: Too many chunks in Eden`, LOG_LEVEL_VERBOSE);
                }
                if (makeChunkIndependent) {
                    count--;
                    independent++;
                    newChunks.push({
                        _id: key as DocumentID,
                        data: chunk.data,
                        type: "leaf"
                    })
                    delete eden[key as DocumentID];
                } else {
                    // Logger(`${head}: Kept in Eden.`, LOG_LEVEL_VERBOSE);
                    totalLength += chunk.data.length;
                }
            }
            const chunkOnEdenAfter = Object.keys(eden).length;
            Logger(`Progress on Eden: doc: ${dispFilename} : ${chunkOnEdenInitial}->${chunkOnEdenAfter} (removed: ${removedChunkOnEden}, new: ${newChunkOnEden}, exist: ${existChunkOnEden}, alreadyIndependent:${alreadyIndependent}, independent:${independent})`, LOG_LEVEL_VERBOSE);
        } else {
            newChunks = (chunks as GeneratedChunk[]).filter(e => e.isNew).map(e => ({
                _id: e.id,
                data: e.piece,
                type: "leaf",
            } as EntryLeaf));
        }
        const cached = processed - newChunks.length;
        if (newChunks.length) {
            if (!this.settings.doNotUseFixedRevisionForChunks) {
                newChunks = newChunks.map(e => ({ ...e, _rev: createChunkRev(e) }));
            }
            const exists = await this.localDatabase.allDocs({ keys: newChunks.map(e => e._id), include_docs: false });
            const existsMap = exists.rows.map(e => ([e.key, "error" in e ? e.error : e.value.rev])).reduce((p, c) => ({ ...p, [c[0]]: c[1] }), {} as Record<string, any>);
            const result = await this.localDatabase.bulkDocs(newChunks, { new_edits: !!this.settings.doNotUseFixedRevisionForChunks });
            if (this.settings.doNotUseFixedRevisionForChunks) {
                const mappedResults = result.reduce((p, item) => {
                    if ("ok" in item) {
                        p.ok.push(item)
                        return p;
                    }
                    if ("error" in item) {
                        if (item.status == 409) {
                            p.skip.push(item);
                            return p;
                        }
                    }
                    p.failed.push(item);
                    return p;
                }, ({ ok: [] as PouchDB.Core.Response[], skip: [] as PouchDB.Core.Error[], failed: [] as any[] }))
                if (mappedResults.failed.length) {
                    Logger(`Save failed.: ${dispFilename} :${mappedResults.failed.map(e => e?.id ?? e.toString()).join(",")}`, LOG_LEVEL_VERBOSE);
                    Logger(`This document could not be saved:${dispFilename}`, LOG_LEVEL_NOTICE);
                    return false;
                }
                const made = mappedResults.ok.length;
                const skipped = mappedResults.skip.length;
                Logger(`Chunks saved: doc: ${dispFilename} ,chunks: ${processed} (new:${made}, recycled:${skipped}, cached:${cached})`);
            } else {
                const erroredItems = newChunks.filter(e => e._id in existsMap && existsMap[e._id].startsWith("1-") && existsMap[e._id] != e._rev);
                const actualNewChunks = newChunks.filter(e => !(e._id in existsMap) || !existsMap[e._id].startsWith("1-"));
                // const skippedChunks = newChunks.filter(e => e._id in existsMap && existsMap[e._id] == e._rev);
                if (erroredItems.length) {
                    Logger(`Save failed.: ${dispFilename} :${erroredItems.length} items mismatched`, LOG_LEVEL_VERBOSE);
                    Logger(`This document could not be saved:${dispFilename}`, LOG_LEVEL_NOTICE);
                    Logger(`Mismatched items: ${erroredItems.map(e => e._id).join(",")}`, LOG_LEVEL_VERBOSE);
                    Logger(`Revision mismatch: ${erroredItems.map(e => `${e._rev}, ${existsMap[e._id]}`).join(",")}`, LOG_LEVEL_VERBOSE);
                    // console.warn(erroredItems)
                    return false;
                }
                const made = actualNewChunks.length;
                const skipped = newChunks.length - actualNewChunks.length;
                Logger(`Chunks saved (with fixed): doc: ${dispFilename} ,chunks: ${processed} (new:${made}, recycled:${skipped}, cached:${cached})`);
            }
        }
        if (onlyChunks) {
            return ({
                id: note._id,
                ok: true,
                rev: "dummy"
            })
        }

        const newDoc: PlainEntry | NewEntry = {
            children: (chunks as GeneratedChunk[]).map(e => e.id),
            _id: note._id,
            path: note.path,
            ctime: note.ctime,
            mtime: note.mtime,
            size: note.size,
            type: note.datatype,
            eden: eden,
        };

        return await serialized("file:" + filename, async () => {
            try {
                const old = await this.localDatabase.get(newDoc._id);
                newDoc._rev = old._rev;
            } catch (ex: any) {
                if (isErrorOfMissingDoc(ex)) {
                    // NO OP/
                } else {
                    throw ex;
                }
            }
            const r = await this.localDatabase.put<PlainEntry | NewEntry>(newDoc, { force: true });
            if (r.ok) {
                return r;
            } else {
                return false;
            }
        }) ?? false;
    }

    async resetDatabase() {
        this.changeHandler?.cancel();
        await this.changeHandler?.removeAllListeners();
        this.env.$$getReplicator().closeReplication();
        if (!await this.env.$everyOnResetDatabase(this)) {
            Logger("Database reset has been prevented or failed on some modules.", LOG_LEVEL_NOTICE);
            return false;
        }
        Logger("Database closed for reset Database.");
        this.isReady = false;
        await this.localDatabase.destroy();
        //@ts-ignore
        this.localDatabase = null;
        await this.initializeDatabase();
        Logger("Local Database Reset", LOG_LEVEL_NOTICE);
    }

    isTargetFile(filenameSrc: string) {
        const file = filenameSrc.startsWith("i:") ? filenameSrc.substring(2) : filenameSrc;
        if (file.startsWith("ix:")) return true;
        if (file.startsWith("ps:")) return true;
        if (file.includes(":")) {
            return false;
        }
        if (this.settings.syncOnlyRegEx) {
            const syncOnly = new RegExp(this.settings.syncOnlyRegEx, this.settings.handleFilenameCaseSensitive ? "" : "i");
            if (!file.match(syncOnly)) return false;
        }
        if (this.settings.syncIgnoreRegEx) {
            const syncIgnore = new RegExp(this.settings.syncIgnoreRegEx, this.settings.handleFilenameCaseSensitive ? "" : "i");
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
        const missingChunks = localChunks.filter(e => e.chunk === false).map(e => e.id);
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
        const missingChunks = localChunks.filter(e => e.chunk === false).map(e => e.id);
        // If we have enough chunks, return them.
        if (missingChunks.length == 0) {
            return localChunks.map(e => e.chunk) as EntryLeaf[];
        }
        // Fetching remote chunks.
        const remoteDocs = await this.env.$$getReplicator().fetchRemoteChunks(missingChunks, showResult);
        if (remoteDocs == false) {
            Logger(`Could not fetch chunks from the server. `, showResult ? LOG_LEVEL_NOTICE : LOG_LEVEL_VERBOSE, "fetch");
            return false;
        }
        remoteDocs.forEach(e => this.hashCaches.set(e._id, e.data));
        // Cache remote chunks to the local database.
        await this.localDatabase.bulkDocs(remoteDocs, { new_edits: false });
        // Chunks should be ordered by as we requested.
        const chunks = Object.fromEntries([...localChunks.map(e => e.chunk).filter(e => e !== false), ...remoteDocs].map(e => [e._id, e]));
        const ret = ids.map(e => chunks?.[e] ?? undefined)
        if (ret.some(e => e === undefined)) return false;
        return ret;

    }

    async *findAllChunks(opt?: PouchDB.Core.AllDocsWithKeyOptions | PouchDB.Core.AllDocsOptions | PouchDB.Core.AllDocsWithKeysOptions | PouchDB.Core.AllDocsWithinRangeOptions) {
        const targets = [
            () => this.findEntries("h:", `h:\u{10ffff}`, opt ?? {}),
        ]
        for (const targetFun of targets) {
            const target = targetFun();
            for await (const f of target) {
                yield f;
            }
        }
    }

    async *findEntries(startKey: string, endKey: string, opt: PouchDB.Core.AllDocsWithKeyOptions | PouchDB.Core.AllDocsOptions | PouchDB.Core.AllDocsWithKeysOptions | PouchDB.Core.AllDocsWithinRangeOptions) {
        const pageLimit = 100;
        let nextKey = startKey;
        if (endKey == "") endKey = "\u{10ffff}";
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
                if (!("type" in doc)) {
                    continue;
                }
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
        if (endKey == "") endKey = "\u{10ffff}";
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
                if (f == VERSIONING_DOCID) continue;
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

    // --- File operations!

    async UXFileInfoToSavingEntry(file: UXFileInfo): Promise<SavingEntry | false> {
        const datatype = determineTypeFromBlob(file.body);
        const fullPath = file.path;
        const id = await this.path2id(fullPath);
        const d: SavingEntry = {
            _id: id,
            path: fullPath,
            data: file.body,
            mtime: file.stat.mtime,
            ctime: file.stat.ctime,
            size: file.stat.size,
            children: [],
            datatype: datatype,
            type: datatype,
            eden: {},
        };
        return d;
    }

    async getConflictedDoc(path: FilePathWithPrefix, rev: string): Promise<false | diff_result_leaf> {
        try {
            const doc = await this.getDBEntry(path, { rev: rev }, false, false, true);
            if (doc === false) return false;
            let data = getDocData(doc.data)
            if (doc.datatype == "newnote") {
                data = readString(new Uint8Array(decodeBinary(doc.data)));
            } else if (doc.datatype == "plain") {
                // NO OP.
            }
            return {
                deleted: doc.deleted || doc._deleted,
                ctime: doc.ctime,
                mtime: doc.mtime,
                rev: rev,
                data: data
            };
        } catch (ex) {
            if (isErrorOfMissingDoc(ex)) {
                return false;
            }
        }
        return false;
    }
    async mergeSensibly(path: FilePathWithPrefix, baseRev: string, currentRev: string, conflictedRev: string): Promise<Diff[] | false> {
        const baseLeaf = await this.getConflictedDoc(path, baseRev);
        const leftLeaf = await this.getConflictedDoc(path, currentRev);
        const rightLeaf = await this.getConflictedDoc(path, conflictedRev);
        let autoMerge = false;
        if (baseLeaf == false || leftLeaf == false || rightLeaf == false) {
            return false;
        }
        if (leftLeaf.deleted && rightLeaf.deleted) {
            // Both are deleted
            return false;
        }
        // diff between base and each revision
        const dmp = new diff_match_patch();
        const mapLeft = dmp.diff_linesToChars_(baseLeaf.data, leftLeaf.data);
        const diffLeftSrc = dmp.diff_main(mapLeft.chars1, mapLeft.chars2, false);
        dmp.diff_charsToLines_(diffLeftSrc, mapLeft.lineArray);
        const mapRight = dmp.diff_linesToChars_(baseLeaf.data, rightLeaf.data);
        const diffRightSrc = dmp.diff_main(mapRight.chars1, mapRight.chars2, false);
        dmp.diff_charsToLines_(diffRightSrc, mapRight.lineArray);
        function splitDiffPiece(src: Diff[]): Diff[] {
            const ret = [] as Diff[];
            do {
                const d = src.shift();
                if (d === undefined) {
                    return ret;
                }
                const pieces = d[1].split(/([^\n]*\n)/).filter(f => f != "");
                if (typeof (d) == "undefined") {
                    break;
                }
                if (d[0] != DIFF_DELETE) {
                    ret.push(...(pieces.map(e => [d[0], e] as Diff)));
                }
                if (d[0] == DIFF_DELETE) {
                    const nd = src.shift();

                    if (typeof (nd) != "undefined") {
                        const piecesPair = nd[1].split(/([^\n]*\n)/).filter(f => f != "");
                        if (nd[0] == DIFF_INSERT) {
                            // it might be pair
                            for (const pt of pieces) {
                                ret.push([d[0], pt]);
                                const pairP = piecesPair.shift();
                                if (typeof (pairP) != "undefined") ret.push([DIFF_INSERT, pairP]);
                            }
                            ret.push(...(piecesPair.map(e => [nd[0], e] as Diff)));
                        } else {
                            ret.push(...(pieces.map(e => [d[0], e] as Diff)));
                            ret.push(...(piecesPair.map(e => [nd[0], e] as Diff)));

                        }
                    } else {
                        ret.push(...(pieces.map(e => [0, e] as Diff)));
                    }
                }
            } while (src.length > 0);
            return ret;
        }

        const diffLeft = splitDiffPiece(diffLeftSrc);
        const diffRight = splitDiffPiece(diffRightSrc);

        let rightIdx = 0;
        let leftIdx = 0;
        const merged = [] as Diff[];
        autoMerge = true;
        LOOP_MERGE:
        do {
            if (leftIdx >= diffLeft.length && rightIdx >= diffRight.length) {
                break LOOP_MERGE;
            }
            const leftItem = diffLeft[leftIdx] ?? [0, ""];
            const rightItem = diffRight[rightIdx] ?? [0, ""];
            leftIdx++;
            rightIdx++;
            // when completely same, leave it .
            if (leftItem[0] == DIFF_EQUAL && rightItem[0] == DIFF_EQUAL && leftItem[1] == rightItem[1]) {
                merged.push(leftItem);
                continue;
            }
            if (leftItem[0] == DIFF_DELETE && rightItem[0] == DIFF_DELETE && leftItem[1] == rightItem[1]) {
                // when deleted evenly,
                const nextLeftIdx = leftIdx;
                const nextRightIdx = rightIdx;
                const [nextLeftItem, nextRightItem] = [diffLeft[nextLeftIdx] ?? [0, ""], diffRight[nextRightIdx] ?? [0, ""]];
                if ((nextLeftItem[0] == DIFF_INSERT && nextRightItem[0] == DIFF_INSERT) && nextLeftItem[1] != nextRightItem[1]) {
                    //but next line looks like different
                    autoMerge = false;
                    break;
                } else {
                    merged.push(leftItem);
                    continue;
                }
            }
            // when inserted evenly
            if (leftItem[0] == DIFF_INSERT && rightItem[0] == DIFF_INSERT) {
                if (leftItem[1] == rightItem[1]) {
                    merged.push(leftItem);
                    continue;
                } else {
                    // sort by file date.
                    if (leftLeaf.mtime <= rightLeaf.mtime) {
                        merged.push(leftItem);
                        merged.push(rightItem);
                        continue;
                    } else {
                        merged.push(rightItem);
                        merged.push(leftItem);
                        continue;
                    }
                }

            }
            // when on inserting, index should be fixed again.
            if (leftItem[0] == DIFF_INSERT) {
                rightIdx--;
                merged.push(leftItem);
                continue;
            }
            if (rightItem[0] == DIFF_INSERT) {
                leftIdx--;
                merged.push(rightItem);
                continue;
            }
            // except insertion, the line should not be different.
            if (rightItem[1] != leftItem[1]) {
                //TODO: SHOULD BE PANIC.
                Logger(`MERGING PANIC:${leftItem[0]},${leftItem[1]} == ${rightItem[0]},${rightItem[1]}`, LOG_LEVEL_VERBOSE);
                autoMerge = false;
                break LOOP_MERGE;
            }
            if (leftItem[0] == DIFF_DELETE) {
                if (rightItem[0] == DIFF_EQUAL) {
                    merged.push(leftItem);
                    continue;
                } else {
                    //we cannot perform auto merge.
                    autoMerge = false;
                    break LOOP_MERGE;
                }
            }
            if (rightItem[0] == DIFF_DELETE) {
                if (leftItem[0] == DIFF_EQUAL) {
                    merged.push(rightItem);
                    continue;
                } else {
                    //we cannot perform auto merge.
                    autoMerge = false;
                    break LOOP_MERGE;
                }
            }
            Logger(`Weird condition:${leftItem[0]},${leftItem[1]} == ${rightItem[0]},${rightItem[1]}`, LOG_LEVEL_VERBOSE);
            // here is the exception
            break LOOP_MERGE;
        } while (leftIdx < diffLeft.length || rightIdx < diffRight.length);
        if (autoMerge) {
            Logger(`Sensibly merge available`, LOG_LEVEL_VERBOSE);
            return merged;
        } else {
            return false;
        }
    }


    async mergeObject(path: FilePathWithPrefix, baseRev: string, currentRev: string, conflictedRev: string): Promise<string | false> {
        try {
            const baseLeaf = await this.getConflictedDoc(path, baseRev);
            const leftLeaf = await this.getConflictedDoc(path, currentRev);
            const rightLeaf = await this.getConflictedDoc(path, conflictedRev);
            if (baseLeaf == false || leftLeaf == false || rightLeaf == false) {
                return false;
            }
            if (leftLeaf.deleted && rightLeaf.deleted) {
                return false;
            }
            const baseObj = { data: tryParseJSON(baseLeaf.data, {}) } as Record<string | number | symbol, any>;
            const leftObj = { data: tryParseJSON(leftLeaf.data, {}) } as Record<string | number | symbol, any>;
            const rightObj = { data: tryParseJSON(rightLeaf.data, {}) } as Record<string | number | symbol, any>;

            const diffLeft = generatePatchObj(baseObj, leftObj);
            const diffRight = generatePatchObj(baseObj, rightObj);

            // If each value of the same key has been modified, the automatic merge should be prevented.
            //TODO Does it have to be a configurable item?
            const diffSetLeft = new Map(flattenObject(diffLeft));
            const diffSetRight = new Map(flattenObject(diffRight));
            for (const [key, value] of diffSetLeft) {
                if (diffSetRight.has(key)) {
                    if (diffSetRight.get(key) == value) {
                        // No matter, if changed to the same value.
                        diffSetRight.delete(key);
                    }
                }
            }
            for (const [key, value] of diffSetRight) {
                if (diffSetLeft.has(key) && diffSetLeft.get(key) != value) {
                    // Some changes are conflicted
                    return false;
                }
            }

            const patches = [
                { mtime: leftLeaf.mtime, patch: diffLeft },
                { mtime: rightLeaf.mtime, patch: diffRight }
            ].sort((a, b) => a.mtime - b.mtime);
            let newObj = { ...baseObj };
            for (const patch of patches) {
                newObj = applyPatch(newObj, patch.patch);
            }
            return JSON.stringify(newObj.data);
        } catch (ex) {
            Logger("Could not merge object");
            Logger(ex, LOG_LEVEL_VERBOSE)
            return false;
        }
    }

    async tryAutoMerge(path: FilePathWithPrefix, enableMarkdownAutoMerge: boolean): Promise<{
        ok: DIFF_CHECK_RESULT_AUTO
    } | {
        result: string, conflictedRev: string
    } | {
        leftRev: string,
        rightRev: string,
        leftLeaf: diff_result_leaf | false,
        rightLeaf: diff_result_leaf | false,
    }> {
        const test = await this.getDBEntry(path, { conflicts: true, revs_info: true }, false, false, true);
        if (test === false) return { ok: MISSING_OR_ERROR };
        if (test == null) return { ok: MISSING_OR_ERROR };
        if (!test._conflicts) return { ok: NOT_CONFLICTED };
        if (test._conflicts.length == 0) return { ok: NOT_CONFLICTED };
        const conflicts = test._conflicts.sort((a, b) => Number(a.split("-")[0]) - Number(b.split("-")[0]));
        if ((isSensibleMargeApplicable(path) || isObjectMargeApplicable(path)) && enableMarkdownAutoMerge) {
            const conflictedRev = conflicts[0];
            const conflictedRevNo = Number(conflictedRev.split("-")[0]);
            //Search 
            const revFrom = (await this.getRaw<EntryDoc>(await this.path2id(path), { revs_info: true }));
            const commonBase = (revFrom._revs_info || []).filter(e => e.status == "available" && Number(e.rev.split("-")[0]) < conflictedRevNo).first()?.rev ?? "";
            let p = undefined;
            if (commonBase) {
                if (isSensibleMargeApplicable(path)) {
                    const result = await this.mergeSensibly(path, commonBase, test._rev!, conflictedRev);
                    if (result) {
                        p = result.filter(e => e[0] != DIFF_DELETE).map((e) => e[1]).join("");
                        // can be merged.
                        Logger(`Sensible merge:${path}`, LOG_LEVEL_INFO);
                    } else {
                        Logger(`Sensible merge is not applicable.`, LOG_LEVEL_VERBOSE);
                    }
                } else if (isObjectMargeApplicable(path)) {
                    // can be merged.
                    const result = await this.mergeObject(path, commonBase, test._rev!, conflictedRev);
                    if (result) {
                        Logger(`Object merge:${path}`, LOG_LEVEL_INFO);
                        p = result;
                    } else {
                        Logger(`Object merge is not applicable.`, LOG_LEVEL_VERBOSE);
                    }
                }
                if (p !== undefined) {
                    return { result: p, conflictedRev };
                }
            }
        }
        // should be one or more conflicts;
        const leftLeaf = await this.getConflictedDoc(path, test._rev!);
        const rightLeaf = await this.getConflictedDoc(path, conflicts[0]);
        return { leftRev: test._rev!, rightRev: conflicts[0], leftLeaf, rightLeaf }
    }
}
