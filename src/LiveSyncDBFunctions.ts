import { serialized } from "./lock.ts";
import { Logger } from "./logger.ts";
import { LRUCache } from "./LRUCache.ts";
import { shouldSplitAsPlainText, stripAllPrefixes } from "./path.ts";
import { splitPieces2 } from "./strbin.ts";
import { type Entry, type EntryDoc, type EntryDocResponse, type EntryLeaf, type EntryMilestoneInfo, type LoadedEntry, MAX_DOC_SIZE_BIN, MILSTONE_DOCID as MILESTONE_DOC_ID, type NewEntry, type NoteEntry, type PlainEntry, type RemoteDBSettings, type ChunkVersionRange, type EntryHasPath, type DocumentID, type FilePathWithPrefix, type FilePath, type HashAlgorithm, LOG_LEVEL_NOTICE, LOG_LEVEL_VERBOSE } from "./types.ts";
import { globalConcurrencyController, resolveWithIgnoreKnownError } from "./utils.ts";
import { isErrorOfMissingDoc } from "./utils_couchdb.ts";


interface DBFunctionSettings {
    minimumChunkSize: number;
    encrypt: boolean;
    passphrase: string;
    deleteMetadataOfDeletedFiles: boolean;
    customChunkSize: number;
    readChunksOnline: boolean;
    doNotPaceReplication: boolean;
    hashAlg: HashAlgorithm;
    useV1: boolean;
}
// This interface is expected to be unnecessary because of the change in dependency direction
export interface DBFunctionEnvironment {
    localDatabase: PouchDB.Database<EntryDoc>,
    id2path(id: DocumentID, entry: EntryHasPath, stripPrefix?: boolean): FilePathWithPrefix;
    path2id(filename: FilePathWithPrefix | FilePath, prefix?: string): Promise<DocumentID>;
    isTargetFile: (file: string) => boolean,
    settings: DBFunctionSettings,
    corruptedEntries: { [key: string]: EntryDoc },
    collectChunks(ids: string[], showResult?: boolean, waitForReady?: boolean): Promise<false | EntryLeaf[]>,
    getDBLeaf(id: string, waitForReady: boolean): Promise<string>,
    hashCaches: LRUCache<DocumentID, string>,
    h32(input: string, seed?: number): string,
    h32Raw(input: Uint8Array, seed?: number): number,
    xxhash32(input: string, seed?: number): number,
    xxhash64: ((input: string) => bigint) | false,
}
export async function putDBEntry(
    env: DBFunctionEnvironment,
    note: LoadedEntry,
    saveAsBigChunk?: boolean): Promise<false | PouchDB.Core.Response> {
    //safety valve
    const filename = env.id2path(note._id, note);
    if (!env.isTargetFile(filename)) {
        return false;
    }
    const dispFilename = stripAllPrefixes(filename);
    // let leftData = note.data;
    const savedNotes = [];
    let processed = 0;
    let made = 0;
    let skipped = 0;
    const maxChunkSize = Math.floor(MAX_DOC_SIZE_BIN * ((env.settings.customChunkSize || 0) * (env.settings.useV1 ? 1 : 0.1) + 1));
    const pieceSize = maxChunkSize;
    let plainSplit = false;
    let cacheUsed = 0;
    const userPassphrase = env.settings.passphrase;
    const userPasswordHash = env.h32Raw(new TextEncoder().encode(userPassphrase));
    const minimumChunkSize = env.settings.minimumChunkSize;
    if (!saveAsBigChunk && shouldSplitAsPlainText(filename)) {
        // pieceSize = MAX_DOC_SIZE;
        plainSplit = true;
    }

    const newLeafs: EntryLeaf[] = [];

    const pieces = splitPieces2(note.data, pieceSize, plainSplit, minimumChunkSize, filename, env.settings.useV1);
    const currentDocPiece = new Map<DocumentID, string>();
    let saved = true;
    for (const piece of pieces()) {
        processed++;
        let leafId = "" as DocumentID;
        // Get hash of piece.
        let hashedPiece = "";
        const cache = env.hashCaches.revGet(piece);
        if (cache) {
            hashedPiece = "";
            leafId = cache;
            skipped++;
            cacheUsed++;
            currentDocPiece.set(leafId, piece);
        } else {
            // When encryption has been enabled, make hash to be different between each passphrase to avoid inferring passphrase.
            // On the old algorithm, xor is used to keep the throughput.
            // On new algorithms, the xxhash is enough to fast. so we just add the passphrase after the content.
            if (env.settings.hashAlg === "") {
                if (env.settings.encrypt) {
                    hashedPiece = "+" + (env.h32Raw(new TextEncoder().encode(piece)) ^ userPasswordHash ^ piece.length).toString(36);
                } else {
                    hashedPiece = (env.h32Raw(new TextEncoder().encode(piece)) ^ piece.length).toString(36);
                }
            } else if (env.settings.hashAlg == "xxhash64" && env.xxhash64) {
                if (env.settings.encrypt) {
                    hashedPiece = "+" + ((env.xxhash64(`${piece}-${userPassphrase}-${piece.length}`)).toString(36));
                } else {
                    hashedPiece = env.xxhash64(`${piece}-${piece.length}`).toString(36);
                }
            } else {
                // If we could not use xxhash64, fall back to the 32bit impl.
                // It may happen on iOS before 14.
                if (env.settings.encrypt) {
                    hashedPiece = "+" + env.xxhash32(`${piece}-${userPassphrase}-${piece.length}`).toString(36);
                } else {
                    hashedPiece = env.xxhash32(`${piece}-${piece.length}`).toString(36);
                }
            }
            leafId = ("h:" + hashedPiece) as DocumentID;
        }
        if (currentDocPiece.has(leafId)) {
            if (currentDocPiece.get(leafId) != piece) {
                // conflicted
                // I realise that avoiding chunk name collisions is pointless here.
                // After replication, we will have conflicted chunks.
                Logger(`Hash collided! If possible, please report the following string:${leafId}=>\nA:--${currentDocPiece.get(leafId)}--\nB:--${piece}--`, LOG_LEVEL_NOTICE);
                Logger(`This document could not be saved:${dispFilename}`, LOG_LEVEL_NOTICE);
                saved = false;
            }
        } else {
            currentDocPiece.set(leafId, piece);
        }
        savedNotes.push(leafId);
    }
    const newChunkIds = [...currentDocPiece.keys()];
    do {
        const procChunks = newChunkIds.splice(0, 100);
        if (procChunks.length > 0) {
            const existChunks = await env.localDatabase.allDocs({ keys: [...procChunks], include_docs: true });
            for (const chunk of existChunks.rows) {
                if ("error" in chunk && (chunk as unknown as any).error == "not_found") {
                    const data = currentDocPiece.get(chunk.key as DocumentID);
                    if (typeof data === "undefined") {
                        Logger("Saving chunk error: Missing data:" + (chunk.key));
                        console.log(data);
                        saved = false;
                        continue;
                    }
                    const d: EntryLeaf = {
                        _id: chunk.key as DocumentID,
                        data: data,
                        type: "leaf",
                    };
                    newLeafs.push(d);
                } else if ("error" in chunk) {
                    Logger("Saving chunk error: " + (chunk as unknown as any).error);
                    saved = false;
                } else {
                    const pieceData = chunk.doc;
                    if (pieceData.type == "leaf" && pieceData.data == currentDocPiece.get(chunk.key as DocumentID)) {
                        skipped++;
                    } else if (pieceData.type == "leaf") {
                        Logger(`Hash collided on saving! If possible, please report the following string\nA:--${currentDocPiece.get(chunk.key as DocumentID)}--\nB:--${pieceData.data}--`, LOG_LEVEL_NOTICE);
                        Logger(`This document could not be saved:${dispFilename}`, LOG_LEVEL_NOTICE);
                        saved = false;
                    }
                }
            }
        }
    } while (newChunkIds.length > 0);


    if (newLeafs.length > 0) {
        try {
            const result = await env.localDatabase.bulkDocs(newLeafs);
            for (const item of result) {
                if ("ok" in item) {
                    const id = item.id as DocumentID;

                    const pieceData = currentDocPiece.get(id);
                    if (typeof pieceData === "undefined") {
                        saved = false;
                        Logger(`Save failed.: ${dispFilename} (${item.id} rev:${item.rev})`, LOG_LEVEL_NOTICE);
                        continue
                    }
                    env.hashCaches.set(id, pieceData);
                    made++;
                } else {
                    if ((item as any)?.status == 409) {
                        // conflicted, but it would be ok in children.
                        // env.hashCaches.set(id, pieceData);
                        skipped++
                    } else {
                        Logger(`Save failed..: ${dispFilename} (${item.id} rev:${item.rev})`, LOG_LEVEL_NOTICE);
                        Logger(item);
                        saved = false;
                    }
                }
            }
        } catch (ex) {
            Logger("Chunk save failed:", LOG_LEVEL_NOTICE);
            Logger(ex, LOG_LEVEL_NOTICE);
            saved = false;
        }
    }
    if (saved) {
        Logger(`Content saved:${dispFilename} ,chunks: ${processed} (new:${made}, skip:${skipped}, cache:${cacheUsed})`);
        const newDoc: PlainEntry | NewEntry = {
            children: savedNotes,
            _id: note._id,
            path: note.path,
            ctime: note.ctime,
            mtime: note.mtime,
            size: note.size,
            type: note.datatype,
        };

        return await serialized("file:" + filename, async () => {
            try {
                const old = await env.localDatabase.get(newDoc._id);
                if (!old.type || old.type == "notes" || old.type == "newnote" || old.type == "plain") {
                    // simple use rev for new doc
                    newDoc._rev = old._rev;
                }
            } catch (ex: any) {
                if (isErrorOfMissingDoc(ex)) {
                    // NO OP/
                } else {
                    throw ex;
                }
            }
            const r = await env.localDatabase.put<PlainEntry | NewEntry>(newDoc, { force: true });
            if (typeof env.corruptedEntries[note._id] != "undefined") {
                delete env.corruptedEntries[note._id];
            }
            if (r.ok) {
                return r;
            } else {
                return false;
            }
        }) ?? false;
    } else {
        Logger(`note could not saved:${dispFilename}`);
        return false;
    }
}

export async function getDBEntryMeta(env: DBFunctionEnvironment, path: FilePathWithPrefix | FilePath, opt?: PouchDB.Core.GetOptions, includeDeleted = false): Promise<false | LoadedEntry> {
    // safety valve
    if (!env.isTargetFile(path)) {
        return false;
    }
    const id = await env.path2id(path);
    try {
        let obj: EntryDocResponse | null = null;
        if (opt) {
            obj = await env.localDatabase.get(id, opt);
        } else {
            obj = await env.localDatabase.get(id);
        }
        const deleted = "deleted" in obj ? obj.deleted : undefined;
        if (!includeDeleted && deleted) return false;
        if (obj.type && obj.type == "leaf") {
            //do nothing for leaf;
            return false;
        }

        // retrieve metadata only
        if (!obj.type || (obj.type && obj.type == "notes") || obj.type == "newnote" || obj.type == "plain") {
            const note = obj as Entry;
            let children: string[] = [];
            let type: "plain" | "newnote" = "plain";
            if (obj.type == "newnote" || obj.type == "plain") {
                children = obj.children;
                type = obj.type;
            }
            const doc: LoadedEntry & PouchDB.Core.IdMeta & PouchDB.Core.GetMeta = {
                data: "",
                _id: note._id,
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
                type: type
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
export async function getDBEntryFromMeta(env: DBFunctionEnvironment, obj: LoadedEntry, opt?: PouchDB.Core.GetOptions, dump = false, waitForReady = true, includeDeleted = false): Promise<false | LoadedEntry> {
    const filename = env.id2path(obj._id, obj);
    if (!env.isTargetFile(filename)) {
        return false;
    }
    const dispFilename = stripAllPrefixes(filename)
    const deleted = "deleted" in obj ? obj.deleted : undefined;
    if (!obj.type || (obj.type && obj.type == "notes")) {
        const note = obj as NoteEntry;
        const doc: LoadedEntry & PouchDB.Core.IdMeta = {
            data: note.data,
            path: note.path,
            _id: note._id,
            ctime: note.ctime,
            mtime: note.mtime,
            size: note.size,
            // _deleted: obj._deleted,
            _rev: obj._rev,
            _conflicts: obj._conflicts,
            children: [],
            datatype: "newnote",
            deleted: deleted,
            type: "newnote",
        };
        if (typeof env.corruptedEntries[doc._id] != "undefined") {
            delete env.corruptedEntries[doc._id];
        }
        if (dump) {
            Logger(`Simple doc`);
            Logger(doc);
        }

        return doc;
        // simple note
    }
    if (obj.type == "newnote" || obj.type == "plain") {
        // search children
        try {
            if (dump) {
                Logger(`Enhanced doc`);
                Logger(obj);
            }
            let children: string[] = [];
            // Acquire semaphore to pace replication.
            const weight = Math.min(10, Math.ceil(obj.children.length / 10)) + 1;
            const resourceSemaphore = env.settings.doNotPaceReplication ? (() => { }) : await globalConcurrencyController.acquire(weight);
            try {
                if (env.settings.readChunksOnline) {
                    const items = await env.collectChunks(obj.children, false, waitForReady);
                    if (items) {
                        for (const v of items) {
                            if (v && v.type == "leaf") {
                                children.push(v.data);
                            } else {
                                if (!opt) {
                                    Logger(`Chunks of ${dispFilename} (${obj._id}) are not valid.`, LOG_LEVEL_NOTICE);
                                    // env.needScanning = true;
                                    env.corruptedEntries[obj._id] = obj;
                                }
                                return false;
                            }
                        }
                    } else {
                        if (opt) {
                            Logger(`Could not retrieve chunks of ${dispFilename} (${obj._id}). we have to `, LOG_LEVEL_NOTICE);
                            // env.needScanning = true;
                        }
                        return false;
                    }
                } else {
                    try {
                        if (waitForReady) {
                            children = await Promise.all(obj.children.map((e) => env.getDBLeaf(e, waitForReady)));
                            if (dump) {
                                Logger(`Chunks:`);
                                Logger(children);
                            }
                        } else {
                            const chunkDocs = await env.localDatabase.allDocs({ keys: obj.children, include_docs: true });
                            if (chunkDocs.rows.some(e => "error" in e)) {
                                const missingChunks = chunkDocs.rows.filter(e => "error" in e).map(e => e.key).join(", ");
                                Logger(`Could not retrieve chunks of ${dispFilename}(${obj._id}). Chunks are missing:${missingChunks}`, LOG_LEVEL_NOTICE);
                                return false;
                            }
                            if (chunkDocs.rows.some((e: any) => e.doc && e.doc.type != "leaf")) {
                                const missingChunks = chunkDocs.rows.filter((e: any) => e.doc && e.doc.type != "leaf").map((e: any) => e.id).join(", ");
                                Logger(`Could not retrieve chunks of ${dispFilename}(${obj._id}). corrupted chunks::${missingChunks}`, LOG_LEVEL_NOTICE);
                                return false;
                            }
                            children = chunkDocs.rows.map((e: any) => (e.doc as EntryLeaf).data);
                        }
                    } catch (ex) {
                        Logger(`Something went wrong on reading chunks of ${dispFilename}(${obj._id}) from database, see verbose info for detail.`, LOG_LEVEL_NOTICE);
                        Logger(ex, LOG_LEVEL_VERBOSE);
                        env.corruptedEntries[obj._id] = obj;
                        return false;
                    }
                }
            } finally {
                resourceSemaphore();
            }
            const data = children;
            const doc: LoadedEntry & PouchDB.Core.IdMeta = {
                data: data,
                path: obj.path,
                _id: obj._id,
                ctime: obj.ctime,
                mtime: obj.mtime,
                size: obj.size,
                // _deleted: obj._deleted,
                _rev: obj._rev,
                children: obj.children,
                datatype: obj.type,
                _conflicts: obj._conflicts,
                deleted: deleted,
                type: obj.type
            };
            if (dump) {
                Logger(`therefore:`);
                Logger(doc);
            }
            if (typeof env.corruptedEntries[doc._id] != "undefined") {
                delete env.corruptedEntries[doc._id];
            }
            return doc;
        } catch (ex: any) {
            if (isErrorOfMissingDoc(ex)) {
                Logger(`Missing document content!, could not read ${dispFilename}(${obj._id}) from database.`, LOG_LEVEL_NOTICE);
                return false;
            }
            Logger(`Something went wrong on reading ${dispFilename}(${obj._id}) from database:`, LOG_LEVEL_NOTICE);
            Logger(ex);
        }
    }
    return false;
}
export async function getDBEntry(env: DBFunctionEnvironment, path: FilePathWithPrefix | FilePath, opt?: PouchDB.Core.GetOptions, dump = false, waitForReady = true, includeDeleted = false): Promise<false | LoadedEntry> {
    const meta = await getDBEntryMeta(env, path, opt, includeDeleted);
    if (meta) {
        return await getDBEntryFromMeta(env, meta, opt, dump, waitForReady, includeDeleted);
    } else {
        return false;
    }
}
export async function deleteDBEntry(env: DBFunctionEnvironment, path: FilePathWithPrefix | FilePath, opt?: PouchDB.Core.GetOptions): Promise<boolean> {
    // safety valve
    if (!env.isTargetFile(path)) {
        return false;
    }
    const id = await env.path2id(path);

    try {
        return await serialized("file:" + path, async () => {
            let obj: EntryDocResponse | null = null;
            if (opt) {
                obj = await env.localDatabase.get(id, opt);
            } else {
                obj = await env.localDatabase.get(id);
            }
            const revDeletion = opt && (("rev" in opt ? opt.rev : "") != "");

            if (obj.type && obj.type == "leaf") {
                //do nothing for leaf;
                return false;
            }
            //Check it out and fix docs to regular case
            if (!obj.type || (obj.type && obj.type == "notes")) {
                obj._deleted = true;
                const r = await env.localDatabase.put(obj, { force: !revDeletion });

                Logger(`Entry removed:${path} (${obj._id}-${r.rev})`);
                if (typeof env.corruptedEntries[obj._id] != "undefined") {
                    delete env.corruptedEntries[obj._id];
                }
                return true;

                // simple note
            }
            if (obj.type == "newnote" || obj.type == "plain") {
                if (revDeletion) {
                    obj._deleted = true;
                } else {
                    obj.deleted = true;
                    obj.mtime = Date.now();
                    if (env.settings.deleteMetadataOfDeletedFiles) {
                        obj._deleted = true;
                    }
                }
                const r = await env.localDatabase.put(obj, { force: !revDeletion });

                Logger(`Entry removed:${path} (${obj._id}-${r.rev})`);
                if (typeof env.corruptedEntries[obj._id] != "undefined") {
                    delete env.corruptedEntries[obj._id];
                }

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
export async function deleteDBEntryPrefix(env: DBFunctionEnvironment, prefix: FilePathWithPrefix | FilePath): Promise<boolean> {
    // delete database entries by prefix.
    // it called from folder deletion.
    let c = 0;
    let readCount = 0;
    const delDocs: DocumentID[] = [];
    do {
        const result = await env.localDatabase.allDocs<EntryDoc>({ include_docs: false, skip: c, limit: 100, conflicts: true });
        readCount = result.rows.length;
        if (readCount > 0) {
            //there are some result
            for (const v of result.rows) {
                const decodedPath = env.id2path(v.id as DocumentID, v.doc as LoadedEntry);
                // let doc = v.doc;
                if (decodedPath.startsWith(prefix)) {
                    if (env.isTargetFile(decodedPath)) delDocs.push(v.id as DocumentID);
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
                const item = await env.localDatabase.get(v);
                if (item.type == "newnote" || item.type == "plain") {
                    item.deleted = true;
                    if (env.settings.deleteMetadataOfDeletedFiles) {
                        item._deleted = true;
                    }
                    item.mtime = Date.now();
                } else {
                    item._deleted = true;
                }
                await env.localDatabase.put(item, { force: true });
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

/// Connectivity

export type ENSURE_DB_RESULT = "OK" | "INCOMPATIBLE" | "LOCKED" | "NODE_LOCKED" | "NODE_CLEANED";
export async function ensureDatabaseIsCompatible(db: PouchDB.Database<EntryDoc>, setting: RemoteDBSettings, deviceNodeID: string, currentVersionRange: ChunkVersionRange): Promise<ENSURE_DB_RESULT> {
    const defMilestonePoint: EntryMilestoneInfo = {
        _id: MILESTONE_DOC_ID,
        type: "milestoneinfo",
        created: (new Date() as any) / 1,
        locked: false,
        accepted_nodes: [deviceNodeID],
        node_chunk_info: { [deviceNodeID]: currentVersionRange }
    };

    const remoteMilestone: EntryMilestoneInfo = { ...defMilestonePoint, ...(await resolveWithIgnoreKnownError(db.get(MILESTONE_DOC_ID), defMilestonePoint)) };
    remoteMilestone.node_chunk_info = { ...defMilestonePoint.node_chunk_info, ...remoteMilestone.node_chunk_info };

    const writeMilestone = (
        (
            remoteMilestone.node_chunk_info[deviceNodeID].min != currentVersionRange.min
            || remoteMilestone.node_chunk_info[deviceNodeID].max != currentVersionRange.max
        )
        || typeof remoteMilestone._rev == "undefined");

    if (writeMilestone) {
        remoteMilestone.node_chunk_info[deviceNodeID].min = currentVersionRange.min;
        remoteMilestone.node_chunk_info[deviceNodeID].max = currentVersionRange.max;
        await db.put(remoteMilestone);
    }

    // Check compatibility and make sure available version
    // 
    // v min of A                  v max of A
    // |   v  min of B             |   v max of B
    // |   |                       |   |
    // |   |<---   We can use  --->|   |
    // |   |                       |   |
    // If globalMin and globalMax is suitable, we can upgrade.
    let globalMin = currentVersionRange.min;
    let globalMax = currentVersionRange.max;
    for (const nodeId of remoteMilestone.accepted_nodes) {
        if (nodeId == deviceNodeID) continue;
        if (nodeId in remoteMilestone.node_chunk_info) {
            const nodeInfo = remoteMilestone.node_chunk_info[nodeId];
            globalMin = Math.max(nodeInfo.min, globalMin);
            globalMax = Math.min(nodeInfo.max, globalMax);
        } else {
            globalMin = 0;
            globalMax = 0;
        }
    }

    if (globalMax < globalMin) {
        if (!setting.ignoreVersionCheck) {
            return "INCOMPATIBLE";
        }
    }

    if (remoteMilestone.locked) {
        if (remoteMilestone.accepted_nodes.indexOf(deviceNodeID) == -1) {
            if (remoteMilestone.cleaned) {
                return "NODE_CLEANED";
            }
            return "NODE_LOCKED";
        }
        return "LOCKED";
    }
    return "OK";

}