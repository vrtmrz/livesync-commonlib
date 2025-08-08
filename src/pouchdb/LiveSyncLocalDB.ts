import {
    type EntryDoc,
    type EntryLeaf,
    type LoadedEntry,
    type Credential,
    LEAF_WAIT_TIMEOUT,
    VERSIONING_DOCID,
    type RemoteDBSettings,
    type EntryHasPath,
    type DocumentID,
    type FilePathWithPrefix,
    type FilePath,
    type SavingEntry,
    type DatabaseEntry,
    LOG_LEVEL_NOTICE,
    LOG_LEVEL_VERBOSE,
    REMOTE_COUCHDB,
    type EntryDocResponse,
    type EntryBase,
    type NoteEntry,
    type PlainEntry,
    type NewEntry,
    type UXFileInfo,
    type diff_result_leaf,
    MISSING_OR_ERROR,
    NOT_CONFLICTED,
    LOG_LEVEL_INFO,
    type DIFF_CHECK_RESULT_AUTO,
    type MetaEntry,
    LEAF_WAIT_ONLY_REMOTE,
} from "../common/types.ts";
import {
    applyPatch,
    createTextBlob,
    determineTypeFromBlob,
    flattenObject,
    generatePatchObj,
    getDocData,
    getFileRegExp,
    isObjectMargeApplicable,
    isSensibleMargeApplicable,
    isTextBlob,
    tryParseJSON,
} from "../common/utils.ts";
import { Logger } from "../common/logger.ts";
import { isErrorOfMissingDoc } from "./utils_couchdb.ts";

import type { LiveSyncAbstractReplicator } from "../replication/LiveSyncAbstractReplicator.ts";
import { decodeBinary, readString } from "../string_and_binary/convert.ts";
import { stripAllPrefixes } from "../string_and_binary/path.ts";
import { serialized } from "../concurrency/lock.ts";
import { DIFF_DELETE, DIFF_EQUAL, DIFF_INSERT, diff_match_patch, type Diff } from "diff-match-patch";
import { ChangeManager } from "./managers/ChangeManager.ts";
import { HashManager } from "./managers/HashManager/HashManager.ts";
import { ChunkManager, EVENT_CHUNK_FETCHED, type ChunkWriteOptions } from "./managers/ChunkManager.ts";
import { ChunkFetcher } from "./managers/ChunkFetcher.ts";
import { ContentSplitter } from "./ContentSplitter/ContentSplitters.ts";
import { eventHub } from "../hub/hub.ts";
import { FallbackWeakRef } from "octagonal-wheels/common/polyfill";

export const REMOTE_CHUNK_FETCHED = "remote-chunk-fetched";
export type REMOTE_CHUNK_FETCHED = typeof REMOTE_CHUNK_FETCHED;
declare global {
    interface LSEvents {
        [REMOTE_CHUNK_FETCHED]: EntryLeaf;
    }
}

export type ChunkRetrievalResultSuccess = { _id: DocumentID; data: string; type: "leaf" };
export type ChunkRetrievalResultError = { _id: DocumentID; error: string };
export type ChunkRetrievalResult = ChunkRetrievalResultSuccess | ChunkRetrievalResultError;
export interface LiveSyncLocalDBEnv {
    $$id2path(id: DocumentID, entry: EntryHasPath, stripPrefix?: boolean): FilePathWithPrefix;
    $$path2id(filename: FilePathWithPrefix | FilePath, prefix?: string): Promise<DocumentID>;
    $$createPouchDBInstance<T extends object>(
        name?: string,
        options?: PouchDB.Configuration.DatabaseConfiguration
    ): PouchDB.Database<T>;

    $allOnDBUnload(db: LiveSyncLocalDB): void;
    $allOnDBClose(db: LiveSyncLocalDB): void;
    $everyOnInitializeDatabase(db: LiveSyncLocalDB): Promise<boolean>;
    $everyOnResetDatabase(db: LiveSyncLocalDB): Promise<boolean>;
    $$getReplicator: () => LiveSyncAbstractReplicator;
    getSettings(): RemoteDBSettings;
}

export function getNoFromRev(rev: string) {
    if (!rev) return 0;
    return parseInt(rev.split("-")[0]);
}

type GeneratedChunk = {
    isNew: boolean;
    id: DocumentID;
    piece: string;
};

type AutoMergeOutcomeOK = {
    ok: DIFF_CHECK_RESULT_AUTO;
};

type AutoMergeCanBeDoneByDeletingRev = {
    result: string;
    conflictedRev: string;
};

type UserActionRequired = {
    leftRev: string;
    rightRev: string;
    leftLeaf: diff_result_leaf | false;
    rightLeaf: diff_result_leaf | false;
};

type AutoMergeResult = Promise<AutoMergeOutcomeOK | AutoMergeCanBeDoneByDeletingRev | UserActionRequired>;

export class LiveSyncLocalDB {
    auth: Credential;
    dbname: string;
    settings!: RemoteDBSettings;
    localDatabase!: PouchDB.Database<EntryDoc>;

    isReady = false;

    needScanning = false;

    hashManager!: HashManager;
    chunkFetcher!: ChunkFetcher;
    changeManager!: ChangeManager<EntryDoc>;
    chunkManager!: ChunkManager;
    splitter!: ContentSplitter;

    env: LiveSyncLocalDBEnv;

    clearCaches() {
        this.chunkManager?.clearCaches();
    }

    async _prepareHashFunctions() {
        const getSettingFunc = () => this.settings;
        this.hashManager = new HashManager({
            get settings() {
                return getSettingFunc();
            },
        });
        await this.hashManager.initialise();
    }

    get isOnDemandChunkEnabled() {
        if (this.settings.remoteType !== REMOTE_COUCHDB) {
            return false;
        }
        return this.settings.readChunksOnline;
    }

    onunload() {
        //this.kvDB.close();
        this.env.$allOnDBUnload(this);
        this.localDatabase.removeAllListeners();
    }

    refreshSettings() {
        const settings = this.env.getSettings();
        this.settings = settings;
        this.splitter = new ContentSplitter({ settings: this.settings });
        void this._prepareHashFunctions();
    }

    offRemoteChunkFetchedHandler?: ReturnType<typeof eventHub.onEvent>;
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
        this.offRemoteChunkFetchedHandler?.();
        if (this.localDatabase != null) {
            await this.localDatabase.close();
        }
        this.env.$allOnDBClose(this);
    }

    async teardownManagers() {
        if (this.changeManager) {
            this.changeManager.teardown();
            this.changeManager = undefined!;
        }
        if (this.chunkFetcher) {
            this.chunkFetcher.destroy();
            this.chunkFetcher = undefined!;
        }
        if (this.chunkManager) {
            this.chunkManager.destroy();
            this.chunkManager = undefined!;
        }
        return await Promise.resolve();
    }
    async initManagers() {
        await this.teardownManagers();
        const getDB = () => this.localDatabase;
        const getChangeManager = () => this.changeManager;
        const getChunkManager = () => this.chunkManager;
        const getReplicator = () => this.env.$$getReplicator();
        const getSettings = () => this.env.getSettings();
        const proxy = {
            get database() {
                return getDB();
            },
            get changeManager() {
                return getChangeManager();
            },
            get chunkManager() {
                return getChunkManager();
            },
            getActiveReplicator() {
                return getReplicator();
            },
            get settings() {
                return getSettings();
            },
        };
        this.changeManager = new ChangeManager(proxy);

        this.chunkManager = new ChunkManager({
            ...proxy,
            maxCacheSize: this.settings.hashCacheMaxCount * 10,
        });
        this.chunkFetcher = new ChunkFetcher(proxy);
    }

    onNewLeaf(chunk: EntryLeaf) {
        this.chunkManager?.emitEvent(EVENT_CHUNK_FETCHED, chunk);
    }

    async initializeDatabase(): Promise<boolean> {
        await this._prepareHashFunctions();
        if (this.localDatabase != null) await this.localDatabase.close();
        //@ts-ignore
        this.localDatabase = null;

        this.localDatabase = this.env.$$createPouchDBInstance<EntryDoc>(this.dbname + "-livesync-v2", {
            auto_compaction: false,
            revs_limit: 100,
            deterministic_revs: true,
        });
        if (!(await this.env.$everyOnInitializeDatabase(this))) {
            Logger("Initializing Database has been failed on some module", LOG_LEVEL_NOTICE);
            // TODO ask for continue or disable all.
            // return false;
        }
        Logger("Opening Database...");
        Logger("Database info", LOG_LEVEL_VERBOSE);
        Logger(await this.localDatabase.info(), LOG_LEVEL_VERBOSE);
        await this.initManagers();
        this.localDatabase.on("close", () => {
            Logger("Database closed.");
            this.isReady = false;
            this.localDatabase.removeAllListeners();
            this.env.$$getReplicator()?.closeReplication();
            void this.teardownManagers();
        });
        const _instance = new FallbackWeakRef(this);
        const unload = eventHub.onEvent(REMOTE_CHUNK_FETCHED, (chunk: EntryLeaf) => {
            if (_instance.deref() == null) {
                unload();
            }
            _instance.deref()?.onNewLeaf(chunk);
        });
        this.offRemoteChunkFetchedHandler = unload;
        this.isReady = true;
        Logger("Database is now ready.");
        return true;
    }

    async prepareChunk(piece: string): Promise<GeneratedChunk> {
        const cachedChunkId = this.chunkManager.getChunkIDFromCache(piece);
        if (cachedChunkId !== false) {
            return { isNew: false, id: cachedChunkId, piece: piece };
        }

        // Generate a new chunk ID based on the piece and the hashed passphrase.
        const chunkId = (await this.hashManager.computeHash(piece)) as DocumentID;
        return { isNew: true, id: chunkId, piece: piece };
    }

    async getDBEntryMeta(
        path: FilePathWithPrefix | FilePath,
        opt?: PouchDB.Core.GetOptions,
        includeDeleted = false
    ): Promise<false | LoadedEntry> {
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

    /**
     * Retrieve all used and existing chunks in the database.
     * @param includeDeleted  include deleted chunks in the result.
     * @returns {used: Set<string>, existing: Map<string, EntryLeaf>} used: Set of chunk ids that are used in the database. existing: Map of chunk id and EntryLeaf that are existing in the database.
     */
    async allChunks(includeDeleted = false): Promise<{
        used: Set<string>;
        existing: Map<string, EntryLeaf>;
    }> {
        const used = new Set<string>();
        const existing = new Map<string, EntryLeaf>();
        let since = 0 as string | number;
        do {
            const changes = await this.localDatabase.changes({
                since: since,
                limit: 100,
                include_docs: true,
                conflicts: true,
                style: includeDeleted ? "all_docs" : "main_only",
            });
            if (changes.results.length == 0) {
                break;
            }
            for (const change of changes.results) {
                // console.log(`${change.seq}: ${change.id} ${change.deleted ? "deleted" : ""}`);
                const doc = change.doc as EntryDoc | EntryLeaf;
                if (doc.type == "leaf") {
                    if (doc._deleted) {
                        if (!includeDeleted) {
                            continue;
                        }
                    }
                    existing.set(doc._id, doc);
                }
                if ("children" in doc) {
                    if (change.deleted) {
                        if (!doc._conflicts || doc._conflicts.length == 0) {
                            continue;
                        }
                    }
                    doc.children.forEach((e: string) => used.add(e));
                    if (doc._conflicts) {
                        const revs = await this.localDatabase.get(doc._id, { revs: true, revs_info: true });
                        const mineRevInfo = revs._revs_info || [];
                        // Collect all revs that should be kept.
                        // (All revs that are conflicted and its history before the maximum not conflicted rev).
                        const keepRevs = new Set<string>();
                        for (const conflict of doc._conflicts) {
                            const conflictedRevs = await this.localDatabase.get(doc._id, {
                                rev: conflict,
                                revs: true,
                                revs_info: true,
                            });
                            const conflictedRevInfo = conflictedRevs._revs_info || [];
                            const diffRevs = mineRevInfo.filter(
                                (e) => !conflictedRevInfo.some((f) => f.rev == e.rev && f.status == e.status)
                            );
                            const diffRevs2 = conflictedRevInfo.filter(
                                (e) => !mineRevInfo.some((f) => f.rev == e.rev && f.status == e.status)
                            );
                            const diffRevs3 = diffRevs.concat(diffRevs2);
                            const sameRevs = mineRevInfo
                                .filter((e) => conflictedRevInfo.some((f) => f.rev == e.rev && f.status == e.status))
                                .filter((e) => e.status == "available")
                                .sort((a, b) => getNoFromRev(b.rev) - getNoFromRev(a.rev));
                            const sameRevsTop = sameRevs.length > 0 ? [sameRevs[0].rev] : [];
                            const keepRevList = [
                                ...diffRevs3.filter((e) => e.status == "available").map((e) => e.rev),
                                ...sameRevsTop,
                            ];
                            keepRevList.forEach((e) => keepRevs.add(e));
                        }
                        const detail = await this.localDatabase.bulkGet<EntryDoc>({
                            docs: [...keepRevs.values()].map((e) => ({ id: doc._id, rev: e })),
                        });
                        for (const e of detail.results) {
                            if ("docs" in e) {
                                const docs = e.docs;
                                for (const doc of docs) {
                                    if ("ok" in doc) {
                                        if ("children" in doc.ok) {
                                            doc.ok.children.forEach((e: string) => used.add(e));
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
            since = changes.results[changes.results.length - 1].seq;
        } while (true);
        return { used, existing };
    }

    async getDBEntry(
        path: FilePathWithPrefix | FilePath,
        opt?: PouchDB.Core.GetOptions,
        dump = false,
        waitForReady = true,
        includeDeleted = false
    ): Promise<false | LoadedEntry> {
        const meta = await this.getDBEntryMeta(path, opt, includeDeleted);
        if (meta) {
            return await this.getDBEntryFromMeta(meta, dump, waitForReady);
        } else {
            return false;
        }
    }
    async getDBEntryFromMeta(
        meta: LoadedEntry | MetaEntry,
        dump = false,
        waitForReady = true
    ): Promise<false | LoadedEntry> {
        const filename = this.id2path(meta._id, meta);
        if (!this.isTargetFile(filename)) {
            return false;
        }
        const dispFilename = stripAllPrefixes(filename);
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
                eden: "eden" in meta ? meta.eden : {},
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
                const conflicts = await this.localDatabase.get(meta._id, {
                    rev: meta._rev,
                    conflicts: true,
                    revs_info: true,
                });
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

                // Reading `Eden` for legacy support.
                // It will be removed in the future.
                let edenChunks: Record<string, EntryLeaf> = {};
                if (meta.eden && Object.keys(meta.eden).length > 0) {
                    const chunks = Object.entries(meta.eden).map(([id, data]) => ({
                        _id: id as DocumentID,
                        data: data.data,
                        type: "leaf",
                    })) as EntryLeaf[];
                    edenChunks = Object.fromEntries(chunks.map((e) => [e._id, e]));
                }

                const isNetworkEnabled = this.isOnDemandChunkEnabled;
                const timeout = waitForReady ? LEAF_WAIT_TIMEOUT : isNetworkEnabled ? LEAF_WAIT_ONLY_REMOTE : 0;

                const childrenKeys = [...meta.children] as DocumentID[];
                const chunks = await this.chunkManager.read(
                    childrenKeys,
                    {
                        skipCache: false,
                        timeout: timeout,
                        preventRemoteRequest: !isNetworkEnabled,
                    },
                    edenChunks
                );

                if (chunks.some((e) => e === false)) {
                    // TODO EXACT MESSAGE
                    throw new Error("Load failed");
                }

                const doc: LoadedEntry & PouchDB.Core.IdMeta = {
                    data: (chunks as EntryLeaf[]).map((e) => e.data),
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
                    type: meta.type,
                };
                if (dump) {
                    Logger(`--Loaded Document--`);
                    Logger(doc);
                }
                return doc;
            } catch (ex: any) {
                if (isErrorOfMissingDoc(ex)) {
                    Logger(
                        `Missing document content!, could not read ${dispFilename}(${meta._id.substring(0, 8)}) from database.`,
                        LOG_LEVEL_NOTICE
                    );
                    return false;
                }
                Logger(
                    `Something went wrong on reading ${dispFilename}(${meta._id.substring(0, 8)}) from database:`,
                    LOG_LEVEL_NOTICE
                );
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
            return (
                (await serialized("file:" + path, async () => {
                    let obj: EntryDocResponse | null = null;
                    if (opt) {
                        obj = await this.localDatabase.get(id, opt);
                    } else {
                        obj = await this.localDatabase.get(id);
                    }
                    const revDeletion = opt && ("rev" in opt ? opt.rev : "") != "";

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
                })) ?? false
            );
        } catch (ex: any) {
            if (isErrorOfMissingDoc(ex)) {
                return false;
            }
            throw ex;
        }
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

        // Set datatype again for modified datatype.
        const data = note.data instanceof Blob ? note.data : createTextBlob(note.data);
        note.data = data;
        note.type = isTextBlob(data) ? "plain" : "newnote";
        note.datatype = note.type;

        await this.splitter.initialised;

        let bufferedChunk = [] as EntryLeaf[];
        let bufferedSize = 0;

        let writeCount = 0;
        let newCount = 0;
        let cachedCount = 0;
        let resultCachedCount = 0;
        let duplicatedCount = 0;
        let totalWritingCount = 0;
        let createChunkCount = 0;
        // If total size of current buffered chunks exceeds this, they will be flushed to the database to avoid memory extravagance.
        const MAX_WRITE_SIZE = 1000 * 1024 * 2; // 2MB
        // TODO: Pack chunks in a single file for performance.
        const result = await this.chunkManager.transaction(async () => {
            const chunks: DocumentID[] = [];
            const flushBufferedChunks = async () => {
                if (bufferedChunk.length === 0) return true;
                const writeBuf = [...bufferedChunk];
                bufferedSize = 0;
                bufferedChunk = [];
                const result = await this.chunkManager.write(
                    writeBuf,
                    {
                        skipCache: false,
                        timeout: 0,
                    } as ChunkWriteOptions,
                    note._id
                );
                if (result.result === false) {
                    Logger(`Failed to write buffered chunks for ${dispFilename}`, LOG_LEVEL_NOTICE);
                    return false;
                }
                totalWritingCount++;
                writeCount += result.processed.written;
                resultCachedCount += result.processed.cached;
                duplicatedCount += result.processed.duplicated;
                chunks.push(...writeBuf.map((e) => e._id));

                return true;
            };
            const pieces = await this.splitter.splitContent(note);
            let totalChunkCount = 0;
            for await (const piece of pieces) {
                totalChunkCount++;
                if (piece.length === 0) {
                    continue;
                }
                createChunkCount++;
                const chunk = await this.prepareChunk(piece);
                cachedCount += chunk.isNew ? 0 : 1;
                newCount += chunk.isNew ? 1 : 0;
                bufferedChunk.push({
                    _id: chunk.id,
                    data: chunk.piece,
                    type: "leaf",
                });
                bufferedSize += chunk.piece.length;
                if (bufferedSize > MAX_WRITE_SIZE) {
                    if (!(await flushBufferedChunks())) {
                        Logger(`Failed to flush buffered chunks for ${dispFilename}`, LOG_LEVEL_NOTICE);
                        return false;
                    }
                }
            }
            if (!(await flushBufferedChunks())) {
                Logger(`Failed to flush final buffered chunks for ${dispFilename}`, LOG_LEVEL_NOTICE);
                return false;
            }

            const dataSize = note.data.size;
            const stats = `(✨: ${newCount}, 🗃️: ${cachedCount} (${resultCachedCount}) / 🗄️: ${writeCount}, ♻:${duplicatedCount})`;
            Logger(
                `Chunks processed for ${dispFilename} (${dataSize}): 📚:${totalChunkCount} (${createChunkCount}) , 📥:${totalWritingCount} ${stats}`,
                LOG_LEVEL_VERBOSE
            );

            if (dataSize > 0 && totalWritingCount === 0) {
                Logger(
                    `No data to save in ${dispFilename}!! This document may be corrupted in the local database! Please back it up immediately, and report an issue!`,
                    LOG_LEVEL_NOTICE
                );
            }

            if (onlyChunks) {
                return {
                    id: note._id,
                    ok: true,
                    rev: "dummy",
                };
            }

            const newDoc: PlainEntry | NewEntry = {
                children: chunks,
                _id: note._id,
                path: note.path,
                ctime: note.ctime,
                mtime: note.mtime,
                size: note.size,
                type: note.datatype,
                eden: {},
            };

            return (
                (await serialized("file:" + filename, async () => {
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
                })) ?? false
            );
        });
        if (result === false) {
            Logger(`Failed to write document ${dispFilename}`, LOG_LEVEL_NOTICE);
            return false;
        }
        Logger(`Document saved: ${dispFilename} (${result.id.substring(0, 8)}-${result.rev})`, LOG_LEVEL_VERBOSE);
        return result;
    }

    async resetDatabase() {
        await this.teardownManagers();
        this.env.$$getReplicator().closeReplication();
        if (!(await this.env.$everyOnResetDatabase(this))) {
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
            const syncOnly = getFileRegExp(this.settings, "syncOnlyRegEx");
            if (syncOnly.length > 0 && !syncOnly.some((e) => e.test(file))) return false;
        }
        if (this.settings.syncIgnoreRegEx) {
            const syncIgnore = getFileRegExp(this.settings, "syncIgnoreRegEx");
            if (syncIgnore.some((e) => e.test(file))) return false;
        }
        return true;
    }

    async *findEntries(
        startKey: string,
        endKey: string,
        opt:
            | PouchDB.Core.AllDocsWithKeyOptions
            | PouchDB.Core.AllDocsOptions
            | PouchDB.Core.AllDocsWithKeysOptions
            | PouchDB.Core.AllDocsWithinRangeOptions
    ) {
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
            req = this.allDocsRaw({
                limit: pageLimit,
                skip: 1,
                startkey: nextKey,
                endkey: endKey,
                include_docs: true,
                ...opt,
            });
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
    async *findAllDocs(
        opt?:
            | PouchDB.Core.AllDocsWithKeyOptions
            | PouchDB.Core.AllDocsOptions
            | PouchDB.Core.AllDocsWithKeysOptions
            | PouchDB.Core.AllDocsWithinRangeOptions
    ) {
        const targets = [
            () => this.findEntries("", "_", opt ?? {}),
            () => this.findEntries("_\u{10ffff}", "h:", opt ?? {}),
            () => this.findEntries(`h:\u{10ffff}`, "", opt ?? {}),
        ];
        for (const targetFun of targets) {
            yield* targetFun();
        }
    }
    async *findEntryNames(
        startKey: string,
        endKey: string,
        opt:
            | PouchDB.Core.AllDocsWithKeyOptions
            | PouchDB.Core.AllDocsOptions
            | PouchDB.Core.AllDocsWithKeysOptions
            | PouchDB.Core.AllDocsWithinRangeOptions
    ) {
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
    async *findAllDocNames(
        opt?:
            | PouchDB.Core.AllDocsWithKeyOptions
            | PouchDB.Core.AllDocsOptions
            | PouchDB.Core.AllDocsWithKeysOptions
            | PouchDB.Core.AllDocsWithinRangeOptions
    ) {
        const targets = [
            () => this.findEntryNames("", "_", opt ?? {}),
            () => this.findEntryNames("_\u{10ffff}", "h:", opt ?? {}),
            () => this.findEntryNames(`h:\u{10ffff}`, "i:", opt ?? {}),
            () => this.findEntryNames(`i:\u{10ffff}`, "ix:", opt ?? {}),
            () => this.findEntryNames(`ix:\u{10ffff}`, "ps:", opt ?? {}),
            () => this.findEntryNames(`ps:\u{10ffff}`, "", opt ?? {}),
        ];
        for (const targetFun of targets) {
            const target = targetFun();
            for await (const f of target) {
                if (f.startsWith("_")) continue;
                if (f == VERSIONING_DOCID) continue;
                yield f;
            }
        }
    }
    async *findAllNormalDocs(
        opt?:
            | PouchDB.Core.AllDocsWithKeyOptions
            | PouchDB.Core.AllDocsOptions
            | PouchDB.Core.AllDocsWithKeysOptions
            | PouchDB.Core.AllDocsWithinRangeOptions
    ) {
        const targets = [
            () => this.findEntries("", "_", opt ?? {}),
            () => this.findEntries("_\u{10ffff}", "h:", opt ?? {}),
            () => this.findEntries(`h:\u{10ffff}`, "i:", opt ?? {}),
            () => this.findEntries(`i:\u{10ffff}`, "ix:", opt ?? {}),
            () => this.findEntries(`ix:\u{10ffff}`, "ps:", opt ?? {}),
            () => this.findEntries(`ps:\u{10ffff}`, "", opt ?? {}),
        ];
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

    getRaw<T extends EntryDoc>(
        docId: DocumentID,
        options?: PouchDB.Core.GetOptions
    ): Promise<T & PouchDB.Core.IdMeta & PouchDB.Core.GetMeta> {
        return this.localDatabase.get<T>(docId, options || {});
    }

    removeRaw(docId: DocumentID, revision: string, options?: PouchDB.Core.Options): Promise<PouchDB.Core.Response> {
        return this.localDatabase.remove(docId, revision, options || {});
    }

    putRaw<T extends EntryDoc>(doc: T, options?: PouchDB.Core.PutOptions): Promise<PouchDB.Core.Response> {
        return this.localDatabase.put(doc, options || {});
    }

    allDocsRaw<T extends EntryDoc | DatabaseEntry>(
        options?:
            | PouchDB.Core.AllDocsWithKeyOptions
            | PouchDB.Core.AllDocsWithKeysOptions
            | PouchDB.Core.AllDocsWithinRangeOptions
            | PouchDB.Core.AllDocsOptions
    ): Promise<PouchDB.Core.AllDocsResponse<T>> {
        return this.localDatabase.allDocs<T>(options);
    }

    bulkDocsRaw<T extends EntryDoc>(
        docs: Array<PouchDB.Core.PutDocument<T>>,
        options?: PouchDB.Core.BulkDocsOptions
    ): Promise<Array<PouchDB.Core.Response | PouchDB.Core.Error>> {
        return this.localDatabase.bulkDocs(docs, options || {});
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
            const doc = await this.getDBEntry(path, { rev: rev }, false, true, true);
            if (doc === false) return false;
            let data = getDocData(doc.data);
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
                data: data,
            };
        } catch (ex) {
            if (isErrorOfMissingDoc(ex)) {
                return false;
            }
        }
        return false;
    }
    async mergeSensibly(
        path: FilePathWithPrefix,
        baseRev: string,
        currentRev: string,
        conflictedRev: string
    ): Promise<Diff[] | false> {
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
                const pieces = d[1].split(/([^\n]*\n)/).filter((f) => f != "");
                if (typeof d == "undefined") {
                    break;
                }
                if (d[0] != DIFF_DELETE) {
                    ret.push(...pieces.map((e) => [d[0], e] as Diff));
                }
                if (d[0] == DIFF_DELETE) {
                    const nd = src.shift();

                    if (typeof nd != "undefined") {
                        const piecesPair = nd[1].split(/([^\n]*\n)/).filter((f) => f != "");
                        if (nd[0] == DIFF_INSERT) {
                            // it might be pair
                            for (const pt of pieces) {
                                ret.push([d[0], pt]);
                                const pairP = piecesPair.shift();
                                if (typeof pairP != "undefined") ret.push([DIFF_INSERT, pairP]);
                            }
                            ret.push(...piecesPair.map((e) => [nd[0], e] as Diff));
                        } else {
                            ret.push(...pieces.map((e) => [d[0], e] as Diff));
                            ret.push(...piecesPair.map((e) => [nd[0], e] as Diff));
                        }
                    } else {
                        ret.push(...pieces.map((e) => [0, e] as Diff));
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
        LOOP_MERGE: do {
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
                const [nextLeftItem, nextRightItem] = [
                    diffLeft[nextLeftIdx] ?? [0, ""],
                    diffRight[nextRightIdx] ?? [0, ""],
                ];
                if (
                    nextLeftItem[0] == DIFF_INSERT &&
                    nextRightItem[0] == DIFF_INSERT &&
                    nextLeftItem[1] != nextRightItem[1]
                ) {
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
                Logger(
                    `MERGING PANIC:${leftItem[0]},${leftItem[1]} == ${rightItem[0]},${rightItem[1]}`,
                    LOG_LEVEL_VERBOSE
                );
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
            Logger(
                `Weird condition:${leftItem[0]},${leftItem[1]} == ${rightItem[0]},${rightItem[1]}`,
                LOG_LEVEL_VERBOSE
            );
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

    async mergeObject(
        path: FilePathWithPrefix,
        baseRev: string,
        currentRev: string,
        conflictedRev: string
    ): Promise<string | false> {
        try {
            const baseLeaf = await this.getConflictedDoc(path, baseRev);
            const leftLeaf = await this.getConflictedDoc(path, currentRev);
            const rightLeaf = await this.getConflictedDoc(path, conflictedRev);
            if (baseLeaf == false || leftLeaf == false || rightLeaf == false) {
                Logger(`Could not load leafs for merge`, LOG_LEVEL_VERBOSE);
                Logger(
                    `${baseLeaf ? "base" : "missing base"}, ${leftLeaf ? "left" : "missing left"}, ${rightLeaf ? "right" : "missing right"} }`,
                    LOG_LEVEL_VERBOSE
                );
                return false;
            }
            if (leftLeaf.deleted && rightLeaf.deleted) {
                Logger(`Both are deleted`, LOG_LEVEL_VERBOSE);
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
                    Logger(`Conflicted key:${key}`, LOG_LEVEL_VERBOSE);
                    return false;
                }
            }

            const patches = [
                { mtime: leftLeaf.mtime, patch: diffLeft },
                { mtime: rightLeaf.mtime, patch: diffRight },
            ].sort((a, b) => a.mtime - b.mtime);
            let newObj = { ...baseObj };
            for (const patch of patches) {
                newObj = applyPatch(newObj, patch.patch);
            }
            Logger(`Object merge is applicable!`, LOG_LEVEL_VERBOSE);
            return JSON.stringify(newObj.data);
        } catch (ex) {
            Logger("Could not merge object");
            Logger(ex, LOG_LEVEL_VERBOSE);
            return false;
        }
    }
    async tryAutoMergeSensibly(path: FilePathWithPrefix, test: LoadedEntry, conflicts: string[]) {
        const conflictedRev = conflicts[0];
        const conflictedRevNo = Number(conflictedRev.split("-")[0]);
        //Search
        const revFrom = await this.getRaw<EntryDoc>(await this.path2id(path), { revs_info: true });
        const commonBase =
            (revFrom._revs_info || []).filter(
                (e) => e.status == "available" && Number(e.rev.split("-")[0]) < conflictedRevNo
            )?.[0]?.rev ?? "";
        let p = undefined;
        if (commonBase) {
            if (isSensibleMargeApplicable(path)) {
                const result = await this.mergeSensibly(path, commonBase, test._rev!, conflictedRev);
                if (result) {
                    p = result
                        .filter((e) => e[0] != DIFF_DELETE)
                        .map((e) => e[1])
                        .join("");
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
                    Logger(`Object merge is not applicable..`, LOG_LEVEL_VERBOSE);
                }
            }
            if (p !== undefined) {
                return { result: p, conflictedRev };
            }
        }
        return false;
    }
    async tryAutoMerge(path: FilePathWithPrefix, enableMarkdownAutoMerge: boolean): AutoMergeResult {
        const test = await this.getDBEntry(path, { conflicts: true, revs_info: true }, false, false, true);
        if (test === false) return { ok: MISSING_OR_ERROR };
        if (test == null) return { ok: MISSING_OR_ERROR };
        if (!test._conflicts) return { ok: NOT_CONFLICTED };
        if (test._conflicts.length == 0) return { ok: NOT_CONFLICTED };
        const conflicts = test._conflicts.sort((a, b) => Number(a.split("-")[0]) - Number(b.split("-")[0]));
        if ((isSensibleMargeApplicable(path) || isObjectMargeApplicable(path)) && enableMarkdownAutoMerge) {
            const autoMergeResult = await this.tryAutoMergeSensibly(path, test, conflicts);
            if (autoMergeResult !== false) {
                return autoMergeResult;
            }
        }
        // should be one or more conflicts;
        const leftLeaf = await this.getConflictedDoc(path, test._rev!);
        const rightLeaf = await this.getConflictedDoc(path, conflicts[0]);
        return { leftRev: test._rev!, rightRev: conflicts[0], leftLeaf, rightLeaf };
    }
}
