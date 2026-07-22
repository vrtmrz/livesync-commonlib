import type PouchDB from "pouchdb-core";
import { Logger, LOG_LEVEL_VERBOSE, LOG_LEVEL_NOTICE } from "octagonal-wheels/common/logger";
import {
    type SavingEntry,
    type EntryLeaf,
    type DocumentID,
    type EntryDoc,
    type NewEntry,
    type PlainEntry,
    IDPrefixes,
    type EntryBase,
    type EntryDocResponse,
    type FilePath,
    type FilePathWithPrefix,
    type LoadedEntry,
    REMOTE_COUCHDB,
    type ObsidianLiveSyncSettings,
    type MetaEntry,
    RemoteTypes,
    type NoteEntry,
} from "@lib/common/types";
import type { ContentSplitter } from "@lib/ContentSplitter/ContentSplitters";
import type { HashManager } from "@lib/managers/HashManager/HashManager";
import type { LayeredChunkManager as ChunkManager } from "@lib/managers/LayeredChunkManager";
import type { ChunkWriteOptions } from "@lib/managers/LayeredChunkManager/types";
import { serialized } from "octagonal-wheels/concurrency/lock";
import { createTextBlob, getFileRegExp, isTextBlob } from "@lib/common/utils";
import type { NecessaryServicesInterfaces } from "@lib/interfaces/ServiceModule";
import { isErrorOfMissingDoc } from "@lib/pouchdb/utils_couchdb";
import { stripAllPrefixes } from "@lib/string_and_binary/path";
import { ICHeader, ICXHeader, PSCHeader } from "@lib/common/models/fileaccess.const";
import type { GeneratedChunk } from "@lib/pouchdb/LiveSyncLocalDB";

type Managers = {
    hashManager: HashManager;
    chunkManager: ChunkManager;
    splitter: ContentSplitter;
    localDatabase: PouchDB.Database<EntryDoc>;
};
type NecessaryManagers<T extends keyof Managers> = Pick<Managers, T>;

export async function createChunks(
    managers: NecessaryManagers<"chunkManager" | "hashManager" | "splitter">,
    dispFilename: string,
    note: SavingEntry
) {
    const { chunkManager, splitter } = managers;
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
    const chunks: DocumentID[] = [];

    let writeChars = 0;
    const flushBufferedChunks = async () => {
        if (bufferedChunk.length === 0) {
            Logger(`No chunks to flush for ${dispFilename}`, LOG_LEVEL_VERBOSE);
            return true;
        }
        const writeBuf = [...bufferedChunk];
        bufferedSize = 0;
        bufferedChunk = [];
        const result = await chunkManager.write(
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
        writeChars += writeBuf.map((e) => e.data.length).reduce((a, b) => a + b, 0);
        // chunks.push(...writeBuf.map((e) => e._id));
        Logger(`Flushed ${writeBuf.length} (${writeChars}) chunks for ${dispFilename}`, LOG_LEVEL_VERBOSE);
        return true;
    };
    const flushIfNeeded = async () => {
        if (bufferedSize > MAX_WRITE_SIZE) {
            if (!(await flushBufferedChunks())) {
                Logger(`Failed to flush buffered chunks for ${dispFilename}`, LOG_LEVEL_NOTICE);
                return false;
            }
        }
        return true;
    };
    const addBuffer = async (id: DocumentID, data: string) => {
        const chunk = {
            _id: id,
            data: data,
            type: "leaf",
        } as const;
        bufferedChunk.push(chunk);
        chunks.push(chunk._id);
        bufferedSize += chunk.data.length;
        return await flushIfNeeded();
    };
    const pieces = await splitter.splitContent(note);
    let totalChunkCount = 0;
    try {
        for await (const piece of pieces) {
            totalChunkCount++;
            if (piece.length === 0) {
                continue;
            }
            createChunkCount++;
            const chunk = await prepareChunk(managers, piece);
            cachedCount += chunk.isNew ? 0 : 1;
            newCount += chunk.isNew ? 1 : 0;
            if (!(await addBuffer(chunk.id, chunk.piece))) {
                return false;
            }
        }
    } catch (ex) {
        Logger(`Error processing pieces for ${dispFilename}`);
        Logger(ex, LOG_LEVEL_VERBOSE);
        return false;
    }
    if (!(await flushBufferedChunks())) {
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
    return chunks;
}

export async function putDBEntry(
    host: NecessaryServicesInterfaces<"path" | "setting", never>,
    managers: NecessaryManagers<"localDatabase" | "chunkManager" | "hashManager" | "splitter">,
    note: SavingEntry,
    onlyChunks?: boolean,
    conflictBaseRev?: string
) {
    const { localDatabase, chunkManager, splitter } = managers;

    //safety valve
    const filename = host.services.path.id2path(note._id, note);
    const dispFilename = stripAllPrefixes(filename);

    //prepare eden
    if (!note.eden) note.eden = {};

    if (!isTargetFile(host, filename)) {
        Logger(`File skipped:${dispFilename}`, LOG_LEVEL_VERBOSE);
        return false;
    }

    // Set datatype again for modified datatype.
    const data = note.data instanceof Blob ? note.data : createTextBlob(note.data);
    note.data = data;
    note.type = isTextBlob(data) ? "plain" : "newnote";
    note.datatype = note.type;

    await splitter.initialised;

    // TODO: Pack chunks in a single file for performance.
    const result = await chunkManager.transaction(async () => {
        const chunks = await createChunks(managers, dispFilename, note);
        if (chunks === false) {
            return false;
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
                if (conflictBaseRev) {
                    newDoc._rev = conflictBaseRev;
                } else {
                    try {
                        const old = await localDatabase.get(newDoc._id);
                        newDoc._rev = old._rev;
                    } catch (ex) {
                        if (isErrorOfMissingDoc(ex)) {
                            // NO OP/
                        } else {
                            throw ex;
                        }
                    }
                }
                const r = await localDatabase.put<PlainEntry | NewEntry>(newDoc, { force: true });
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
export function isTargetFile(host: NecessaryServicesInterfaces<"setting", never>, filenameSrc: string) {
    const settings = host.services.setting.currentSettings();
    const file = filenameSrc.startsWith(ICHeader) ? filenameSrc.substring(ICHeader.length) : filenameSrc;
    if (file.startsWith(ICXHeader)) return true;
    if (file.startsWith(PSCHeader)) return true;
    if (file.includes(":")) {
        return false;
    }
    if (!settings.syncInternalFiles) {
        if (file.startsWith(".")) {
            return false;
        }
    }
    if (settings.syncOnlyRegEx) {
        const syncOnly = getFileRegExp(settings, "syncOnlyRegEx");
        if (syncOnly.length > 0 && !syncOnly.some((e) => e.test(file))) return false;
    }
    if (settings.syncIgnoreRegEx) {
        const syncIgnore = getFileRegExp(settings, "syncIgnoreRegEx");
        if (syncIgnore.some((e) => e.test(file))) return false;
    }
    return true;
}
export async function prepareChunk(
    { chunkManager, hashManager }: NecessaryManagers<"chunkManager" | "hashManager">,
    piece: string
): Promise<GeneratedChunk> {
    const cachedChunkId = chunkManager.getChunkIDFromCache(piece);
    if (cachedChunkId !== false) {
        return { isNew: false, id: cachedChunkId, piece: piece };
    }

    // Generate a new chunk ID based on the piece and the hashed passphrase.
    const chunkId = (await hashManager.computeHash(piece)) as DocumentID;
    return { isNew: true, id: `${IDPrefixes.Chunk}${chunkId}` as DocumentID, piece: piece };
}

export async function getDBEntryMetaByPath(
    host: NecessaryServicesInterfaces<"path" | "setting", never>,
    { localDatabase }: NecessaryManagers<"localDatabase">,
    path: FilePathWithPrefix | FilePath,
    opt?: PouchDB.Core.GetOptions,
    includeDeleted = false
): Promise<false | LoadedEntry> {
    if (!isTargetFile(host, path)) {
        return false;
    }
    const id = await host.services.path.path2id(path);
    try {
        let obj: EntryDocResponse | null = null;
        if (opt) {
            obj = await localDatabase.get(id, opt);
        } else {
            obj = await localDatabase.get(id);
        }
        const deleted: boolean | undefined =
            (obj as unknown as { deleted?: boolean })?.deleted ?? obj._deleted ?? undefined;
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
                _revisions: obj?._revisions ?? undefined,
                _revs_info: obj?._revs_info ?? undefined,
                type: type,
                eden: "eden" in obj ? obj.eden : {},
            };
            return doc;
        }
    } catch (ex) {
        if (isErrorOfMissingDoc(ex)) {
            return false;
        }
        throw ex;
    }
    return false;
}

export function isLegacyNote(meta: LoadedEntry | MetaEntry) {
    return !meta.type || (meta.type && meta.type == "notes");
}
function complementEntryMeta(note: NoteEntry) {
    const deleted = note.deleted ?? note._deleted ?? undefined;
    const doc: LoadedEntry & PouchDB.Core.IdMeta = {
        data: note.data,
        path: note.path,
        _id: note._id,
        ctime: note.ctime,
        mtime: note.mtime,
        size: note.size,
        // _deleted: obj._deleted,
        _rev: note._rev,
        _conflicts: note._conflicts,
        children: [],
        datatype: "newnote",
        deleted: deleted,
        type: "newnote",
        eden: "eden" in note ? note.eden : {},
    };
    return doc;
}

// only for legacy support. Will be removed in the future. No longer this type will be stored in the database, but we need to support it for a while until all documents are migrated.
function respondOldFashionedEntry(note: NoteEntry, dump = false) {
    const doc = complementEntryMeta(note);
    if (dump) {
        Logger(`--Old fashioned document--`);
        Logger(doc);
    }
    return doc;
}

export function canUseOnDemandChunking(settings: ObsidianLiveSyncSettings) {
    if (settings.remoteType !== REMOTE_COUCHDB) {
        return false;
    }
    if (settings.useOnlyLocalChunk) {
        return false;
    }
    return true;
}

function canFetchRemotely(settings: ObsidianLiveSyncSettings) {
    if (!canUseOnDemandChunking(settings)) {
        return false;
    }
    if (settings.remoteType === RemoteTypes.REMOTE_MINIO) {
        return false;
    }
    return true;
}
/**
 * Decide how to retrieve chunks based on settings and waitForReady flag.
 * `waitForReady` allows an already-observable finite delivery lifecycle to finish.
 */
export function computeChunkRetrievalMethod(waitForReady: boolean, settings: ObsidianLiveSyncSettings) {
    const isOnDemandFetchEnabled = canFetchRemotely(settings);
    if (!waitForReady) {
        // Normally this requests an immediate local result. CouchDB on-demand
        // delivery is the exception because synchronous dispatch creates a
        // producer claim which has a meaningful completion boundary.
        if (isOnDemandFetchEnabled) {
            return {
                waitForDelivery: true,
                preventRemoteRequest: false,
            };
        }
        return {
            waitForDelivery: false,
            preventRemoteRequest: true,
        };
    }
    // Wait only for an already-observable finite replication, or for the
    // per-identifier claim created by CouchDB on-demand fetching.
    return {
        waitForDelivery: true,
        preventRemoteRequest: !isOnDemandFetchEnabled,
    };
}

async function respondEntryFromMeta(
    { localDatabase, chunkManager }: NecessaryManagers<"localDatabase" | "chunkManager">,
    settings: ObsidianLiveSyncSettings,
    filename: FilePathWithPrefix | FilePath,
    meta: NewEntry | PlainEntry,
    dump: boolean,
    waitForReady: boolean
) {
    const dispFilename = stripAllPrefixes(filename);
    const deleted = meta.deleted ?? meta._deleted ?? undefined;
    if (dump) {
        const conflicts = await localDatabase.get(meta._id, {
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

        const { waitForDelivery, preventRemoteRequest } = computeChunkRetrievalMethod(waitForReady, settings);

        const childrenKeys = [...meta.children] as DocumentID[];
        const chunks = await chunkManager.read(
            childrenKeys,
            {
                skipCache: false,
                waitForDelivery,
                preventRemoteRequest: preventRemoteRequest,
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
    } catch (ex) {
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
    return false;
}

export async function getDBEntryFromMeta(
    host: NecessaryServicesInterfaces<"path" | "setting", never>,
    { localDatabase, chunkManager }: NecessaryManagers<"localDatabase" | "chunkManager">,
    meta: LoadedEntry | MetaEntry,
    dump = false,
    waitForReady = true
) {
    const filename = host.services.path.id2path(meta._id, meta);
    if (!isTargetFile(host, filename)) {
        return false;
    }
    const settings = host.services.setting.currentSettings();

    if (isLegacyNote(meta)) {
        // simple note
        const note = meta as NoteEntry;
        return respondOldFashionedEntry(note, dump);
    }
    if (meta.type == "newnote" || meta.type == "plain") {
        // newnote or plain
        return await respondEntryFromMeta(
            { localDatabase, chunkManager },
            settings,
            filename,
            meta,
            dump,
            waitForReady
        );
    }
    return false;
}
export async function getDBEntryByPath(
    host: NecessaryServicesInterfaces<"path" | "setting", never>,
    managers: NecessaryManagers<"localDatabase" | "chunkManager">,
    path: FilePathWithPrefix | FilePath,
    opt?: PouchDB.Core.GetOptions,
    dump = false,
    waitForReady = true,
    includeDeleted = false
) {
    const meta = await getDBEntryMetaByPath(host, managers, path, opt, includeDeleted);
    if (meta) {
        return await getDBEntryFromMeta(host, managers, meta, dump, waitForReady);
    } else {
        return false;
    }
}
export async function deleteDBEntryByPath(
    host: NecessaryServicesInterfaces<"path" | "setting", never>,
    { localDatabase }: NecessaryManagers<"localDatabase">,
    path: FilePathWithPrefix | FilePath,
    opt?: PouchDB.Core.GetOptions
): Promise<boolean> {
    if (!isTargetFile(host, path)) {
        return false;
    }
    const id = await host.services.path.path2id(path);
    try {
        return (
            (await serialized("file:" + path, async () => {
                const settings = host.services.setting.currentSettings();
                let obj: EntryDocResponse | null = null;
                if (opt) {
                    obj = await localDatabase.get(id, opt);
                } else {
                    obj = await localDatabase.get(id);
                }
                const revDeletion = opt && ("rev" in opt ? opt.rev : "") != "";

                if (obj.type && obj.type == "leaf") {
                    //do nothing for leaf;
                    return false;
                }
                //Check it out and fix docs to regular case
                if (!obj.type || (obj.type && obj.type == "notes")) {
                    obj._deleted = true;
                    const r = await localDatabase.put(obj, { force: !revDeletion });
                    Logger(`Entry removed: ${path} (${obj._id.substring(0, 8)}-${r.rev}) `);
                    return true;

                    // simple note
                }
                if (obj.type == "newnote" || obj.type == "plain") {
                    if (revDeletion) {
                        obj._deleted = true;
                    } else {
                        obj.deleted = true;
                        obj.mtime = Date.now();
                        if (settings.deleteMetadataOfDeletedFiles) {
                            obj._deleted = true;
                        }
                    }
                    const r = await localDatabase.put(obj, { force: !revDeletion });

                    Logger(
                        `Entry removed: [${revDeletion ? "REV" : "DEL"}] ${path} (${obj._id.substring(0, 8)}-${r.rev})`
                    );
                    return true;
                } else {
                    return false;
                }
            })) ?? false
        );
    } catch (ex) {
        if (isErrorOfMissingDoc(ex)) {
            return false;
        }
        throw ex;
    }
}

export async function storeDeletionByPathAtRevision(
    host: NecessaryServicesInterfaces<"path" | "setting", never>,
    { localDatabase }: NecessaryManagers<"localDatabase">,
    path: FilePathWithPrefix | FilePath,
    baseRevision: string
): Promise<PouchDB.Core.Response | false> {
    if (!isTargetFile(host, path)) {
        return false;
    }
    const id = await host.services.path.path2id(path);
    try {
        return (
            (await serialized("file:" + path, async () => {
                const obj = (await localDatabase.get<EntryDocResponse>(id, {
                    rev: baseRevision,
                })) as EntryDocResponse & EntryBase;
                if (obj.type === "leaf") {
                    return false;
                }
                delete obj._deleted;
                obj.deleted = true;
                obj.mtime = Date.now();
                const result = await localDatabase.put(obj, { force: true });
                Logger(`Entry soft-deleted from revision: ${path} (${obj._id.substring(0, 8)}-${result.rev})`);
                return result;
            })) ?? false
        );
    } catch (ex) {
        if (isErrorOfMissingDoc(ex)) {
            return false;
        }
        throw ex;
    }
}
