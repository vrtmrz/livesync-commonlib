import { serialized } from "../concurrency/lock.ts";
import { Logger } from "../common/logger.ts";
import { LRUCache } from "../memory/LRUCache.ts";
import { shouldSplitAsPlainText, stripAllPrefixes } from "../string_and_binary/path.ts";
import { sha1, splitPieces2 } from "../string_and_binary/strbin.ts";
import { type Entry, type EntryDoc, type EntryDocResponse, type EntryLeaf, type EntryMilestoneInfo, type LoadedEntry, MAX_DOC_SIZE_BIN, MILSTONE_DOCID as MILESTONE_DOC_ID, type NewEntry, type PlainEntry, type RemoteDBSettings, type ChunkVersionRange, type EntryHasPath, type DocumentID, type FilePathWithPrefix, type FilePath, type HashAlgorithm, LOG_LEVEL_NOTICE, LOG_LEVEL_VERBOSE, type SavingEntry, PREFIX_CHUNK, NoteEntry } from "../common/types.ts";
import { createTextBlob, isTextBlob, resolveWithIgnoreKnownError } from "../common/utils.ts";
import { isErrorOfMissingDoc } from "./utils_couchdb.ts";


interface DBFunctionSettings {
    minimumChunkSize: number;
    encrypt: boolean;
    passphrase: string;
    deleteMetadataOfDeletedFiles: boolean;
    customChunkSize: number;
    doNotPaceReplication: boolean;
    hashAlg: HashAlgorithm;
}
// This interface is expected to be unnecessary because of the change in dependency direction
export interface DBFunctionEnvironment {
    localDatabase: PouchDB.Database<EntryDoc>,
    id2path(id: DocumentID, entry: EntryHasPath, stripPrefix?: boolean): FilePathWithPrefix;
    path2id(filename: FilePathWithPrefix | FilePath, prefix?: string): Promise<DocumentID>;
    isTargetFile: (file: string) => boolean,
    settings: DBFunctionSettings,
    getDBLeaf(id: string, waitForReady: boolean): Promise<string>,
    collectChunks(ids: string[], showResult?: boolean, waitForReady?: boolean): Promise<false | EntryLeaf[]>,
    hashCaches: LRUCache<DocumentID, string>,
    h32(input: string, seed?: number): string,
    h32Raw(input: Uint8Array, seed?: number): number,
    xxhash32(input: string, seed?: number): number,
    xxhash64: ((input: string) => bigint) | false,
    isOnDemandChunkEnabled: boolean;
}
type GeneratedChunk = {
    isNew: boolean,
    id: DocumentID,
    piece: string
}
async function getChunk(env: DBFunctionEnvironment, piece: string): Promise<GeneratedChunk | false> {
    const cachedChunkId = env.hashCaches.revGet(piece);
    if (cachedChunkId !== undefined) {
        return { isNew: false, id: cachedChunkId, piece: piece };
    }
    const chunkId = PREFIX_CHUNK + await generateHashedChunk(env, piece) as DocumentID;
    const cachedPiece = env.hashCaches.get(chunkId);
    if (cachedPiece && cachedPiece != piece) {
        Logger(`Hash collided! If possible, please report the following string:${chunkId}=>\nA:--${cachedPiece}--\nB:--${piece}--`, LOG_LEVEL_NOTICE);
        return false;
    }
    env.hashCaches.set(chunkId, piece);
    return { isNew: true, id: chunkId, piece: piece };
}
async function generateHashedChunk(env: DBFunctionEnvironment, piece: string) {
    const userPassphrase = env.settings.passphrase;
    if (env.settings.hashAlg == "sha1") {
        if (env.settings.encrypt) {
            return "+" + await sha1(`${piece}-${userPassphrase}-${piece.length}`);
        } else {
            return await sha1(`${piece}-${piece.length}`);
        }
    } else if (env.settings.hashAlg === "") {
        if (env.settings.encrypt) {
            const userPasswordHash = env.h32Raw(new TextEncoder().encode(userPassphrase));
            return "+" + (env.h32Raw(new TextEncoder().encode(piece)) ^ userPasswordHash ^ piece.length).toString(36);
        } else {
            return (env.h32Raw(new TextEncoder().encode(piece)) ^ piece.length).toString(36);
        }
    } else if (env.settings.hashAlg == "xxhash64" && env.xxhash64) {
        if (env.settings.encrypt) {
            return "+" + ((env.xxhash64(`${piece}-${userPassphrase}-${piece.length}`)).toString(36));
        } else {
            return env.xxhash64(`${piece}-${piece.length}`).toString(36);
        }
    } else {
        // If we could not use xxhash64, fall back to the 32bit impl.
        // It may happen on iOS before 14.
        if (env.settings.encrypt) {
            return "+" + env.xxhash32(`${piece}-${userPassphrase}-${piece.length}`).toString(36);
        } else {
            return env.xxhash32(`${piece}-${piece.length}`).toString(36);
        }
    }

}

export async function putDBEntry(
    env: DBFunctionEnvironment,
    note: SavingEntry): Promise<false | PouchDB.Core.Response> {
    //safety valve
    const filename = env.id2path(note._id, note);
    const dispFilename = stripAllPrefixes(filename);
    if (!env.isTargetFile(filename)) {
        Logger(`File skipped:${dispFilename}`, LOG_LEVEL_VERBOSE);
        return false;
    }
    let processed = 0;
    const maxChunkSize = Math.floor(MAX_DOC_SIZE_BIN * ((env.settings.customChunkSize || 0) * 1 + 1));
    const pieceSize = maxChunkSize;
    let plainSplit = false;

    const minimumChunkSize = env.settings.minimumChunkSize;

    const now = Date.now();
    const diff = now - note.mtime;
    // If enough old, store it as `stable` file.
    // A Stable file will not be split as text, but simply by pieceSize. Because it might not need to transfer differences
    const isStable = (diff > 1000 * 3600 * 24 * 30);
    if (isStable) {
        plainSplit = false;
    } else if (shouldSplitAsPlainText(filename)) {
        plainSplit = true;
    }

    // Set datatype again for modified datatype.
    const data = (note.data instanceof Blob) ? note.data : createTextBlob(note.data);
    note.type = isTextBlob(data) ? "plain" : "newnote";
    note.datatype = note.type;

    const pieces = await splitPieces2(data, pieceSize, plainSplit, minimumChunkSize, filename);
    const chunkTasks = [];

    for await (const piece of pieces()) {
        processed++;
        chunkTasks.push(getChunk(env, piece));
    }
    const chunks = await Promise.all(chunkTasks);
    if (chunks.some(e => e === false)) {
        Logger(`This document could not be saved:${dispFilename}`, LOG_LEVEL_NOTICE);
        return false;
    }
    const newChunks = (chunks as GeneratedChunk[]).filter(e => e.isNew).map(e => ({
        _id: e.id,
        data: e.piece,
        type: "leaf",
    } as EntryLeaf));
    const cached = processed - newChunks.length;
    if (newChunks.length) {
        const result = await env.localDatabase.bulkDocs(newChunks);
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
        // // Check verbosely
        // const p = await env.localDatabase.allDocs({ keys: mappedResults.skip.map(e => e.id), include_docs: true });
        // for (const doc of p.rows) {
        //     if ("doc" in doc) {
        //         const chunk = newChunks.find(e => e._id == doc.id);
        //         if (doc.doc.data != chunk.data) {
        //             debugger;
        //         }
        //     }
        // }
        Logger(`Chunks saved: doc: ${dispFilename} ,chunks: ${processed} (new:${made}, recycled:${skipped}, cached:${cached})`);
    }

    const newDoc: PlainEntry | NewEntry = {
        children: (chunks as GeneratedChunk[]).map(e => e.id),
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
            newDoc._rev = old._rev;
        } catch (ex: any) {
            if (isErrorOfMissingDoc(ex)) {
                // NO OP/
            } else {
                throw ex;
            }
        }
        const r = await env.localDatabase.put<PlainEntry | NewEntry>(newDoc, { force: true });
        if (r.ok) {
            return r;
        } else {
            return false;
        }
    }) ?? false;
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
        const deleted = (obj as any)?.deleted ?? obj._deleted ?? undefined;
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
    const deleted = obj.deleted ?? obj._deleted ?? undefined;
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
        if (dump) {
            Logger(`--Old fashioned document--`);
            Logger(doc);
        }

        return doc;
        // simple note
    }
    if (obj.type == "newnote" || obj.type == "plain") {
        if (dump) {
            const conflicts = await env.localDatabase.get(obj._id, { conflicts: true, revs_info: true });
            Logger("-- Conflicts --");
            Logger(conflicts._conflicts ?? "No conflicts");
            Logger("-- Revs info -- ");
            Logger(conflicts._revs_info);
        }
        // search children
        try {
            if (dump) {
                Logger(`--Bare document--`);
                Logger(obj);
            }
            let children: string[] = [];
            // Acquire semaphore to pace replication.
            // const weight = Math.min(10, Math.ceil(obj.children.length / 10)) + 1;
            // const resourceSemaphore = env.settings.doNotPaceReplication ? (() => { }) : await globalConcurrencyController.acquire(weight);
            if (env.isOnDemandChunkEnabled) {
                const items = await env.collectChunks(obj.children, false, waitForReady);
                if (items === false || items.some(leaf => leaf.type != "leaf")) {
                    Logger(`Chunks of ${dispFilename} (${obj._id.substring(0, 8)}) are not valid.`, LOG_LEVEL_NOTICE);
                    if (items) {
                        Logger(`Missing chunks: ${items.map(e => e._id).join(",")}`, LOG_LEVEL_VERBOSE);
                    }
                    return false;
                }
                children = items.map(leaf => leaf.data);
            } else {
                try {
                    if (waitForReady) {
                        children = await Promise.all(obj.children.map((e) => env.getDBLeaf(e, waitForReady)));
                        if (dump) {
                            Logger(`--Chunks--`);
                            Logger(children);
                        }
                    } else {
                        const chunkDocs = await env.localDatabase.allDocs({ keys: obj.children, include_docs: true });
                        if (chunkDocs.rows.some(e => "error" in e)) {
                            const missingChunks = chunkDocs.rows.filter(e => "error" in e).map(e => e.key).join(", ");
                            Logger(`Chunks of ${dispFilename} (${obj._id.substring(0, 8)}) are not valid.`, LOG_LEVEL_NOTICE);
                            Logger(`Missing chunks: ${missingChunks}`, LOG_LEVEL_VERBOSE);
                            return false;
                        }
                        if (chunkDocs.rows.some((e: any) => e.doc && e.doc.type != "leaf")) {
                            const missingChunks = chunkDocs.rows.filter((e: any) => e.doc && e.doc.type != "leaf").map((e: any) => e.id).join(", ");
                            Logger(`Chunks of ${dispFilename} (${obj._id.substring(0, 8)}) are not valid.`, LOG_LEVEL_NOTICE);
                            Logger(`Corrupted chunks: ${missingChunks}`, LOG_LEVEL_VERBOSE);
                            return false;
                        }
                        children = chunkDocs.rows.map((e: any) => (e.doc as EntryLeaf).data);
                    }
                } catch (ex) {
                    Logger(`Something went wrong on reading chunks of ${dispFilename}(${obj._id.substring(0, 8)}) from database, see verbose info for detail.`, LOG_LEVEL_NOTICE);
                    Logger(ex, LOG_LEVEL_VERBOSE);
                    return false;
                }
            }

            const data = children;
            const doc: LoadedEntry & PouchDB.Core.IdMeta = {
                data: data,
                path: obj.path,
                _id: obj._id,
                ctime: obj.ctime,
                mtime: obj.mtime,
                size: obj.size,
                _rev: obj._rev,
                children: obj.children,
                datatype: obj.type,
                _conflicts: obj._conflicts,
                deleted: deleted,
                type: obj.type
            };
            if (dump) {
                Logger(`--Loaded Document--`);
                Logger(doc);
            }
            return doc;
        } catch (ex: any) {
            if (isErrorOfMissingDoc(ex)) {
                Logger(`Missing document content!, could not read ${dispFilename}(${obj._id.substring(0, 8)}) from database.`, LOG_LEVEL_NOTICE);
                return false;
            }
            Logger(`Something went wrong on reading ${dispFilename}(${obj._id.substring(0, 8)}) from database:`, LOG_LEVEL_NOTICE);
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
                    if (env.settings.deleteMetadataOfDeletedFiles) {
                        obj._deleted = true;
                    }
                }
                const r = await env.localDatabase.put(obj, { force: !revDeletion });

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