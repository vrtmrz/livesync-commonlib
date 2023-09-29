import { decrypt, encrypt } from "./e2ee_v2.ts";
import { serialized } from "./lock.ts";
import { Logger } from "./logger.ts";
import { getPath } from "./path.ts";
import { writeString } from "./strbin.ts";
import { mapAllTasksWithConcurrencyLimit } from "./task.ts";
import { VER, VERSIONINFO_DOCID, type EntryVersionInfo, SYNCINFO_ID, type SyncInfo, type EntryDoc, type EntryLeaf, type AnyEntry, type FilePathWithPrefix, type CouchDBConnection, LOG_LEVEL_INFO, LOG_LEVEL_NOTICE, LOG_LEVEL_VERBOSE } from "./types.ts";
import { arrayToChunkedArray, isEncryptedChunkEntry, isObfuscatedEntry, isSyncInfoEntry, resolveWithIgnoreKnownError } from "./utils.ts";

export const isValidRemoteCouchDBURI = (uri: string): boolean => {
    if (uri.startsWith("https://")) return true;
    if (uri.startsWith("http://")) return true;
    return false;
};

export function isCloudantURI(uri: string): boolean {
    if (uri.indexOf(".cloudantnosqldb.") !== -1 || uri.indexOf(".cloudant.com") !== -1) return true;
    return false;
}
// check the version of remote.
// if remote is higher than current(or specified) version, return false.
export const checkRemoteVersion = async (db: PouchDB.Database, migrate: (from: number, to: number) => Promise<boolean>, barrier: number = VER): Promise<boolean> => {
    try {
        const versionInfo = (await db.get(VERSIONINFO_DOCID)) as EntryVersionInfo;
        if (versionInfo.type != "versioninfo") {
            return false;
        }

        const version = versionInfo.version;
        if (version < barrier) {
            const versionUpResult = await migrate(version, barrier);
            if (versionUpResult) {
                await bumpRemoteVersion(db);
                return true;
            }
        }
        if (version == barrier) return true;
        return false;
    } catch (ex: any) {
        if (isErrorOfMissingDoc(ex)) {
            if (await bumpRemoteVersion(db)) {
                return true;
            }
            return false;
        }
        throw ex;
    }
};
export const bumpRemoteVersion = async (db: PouchDB.Database, barrier: number = VER): Promise<boolean> => {
    const vi: EntryVersionInfo = {
        _id: VERSIONINFO_DOCID,
        version: barrier,
        type: "versioninfo",
    };
    const versionInfo = (await resolveWithIgnoreKnownError<EntryVersionInfo>(db.get(VERSIONINFO_DOCID), vi));
    if (versionInfo.type != "versioninfo") {
        return false;
    }
    vi._rev = versionInfo._rev;
    await db.put(vi);
    return true;
};

export const checkSyncInfo = async (db: PouchDB.Database): Promise<boolean> => {
    try {
        const syncinfo = (await db.get(SYNCINFO_ID)) as SyncInfo;
        console.log(syncinfo);
        // if we could decrypt the doc, it must be ok.
        return true;
    } catch (ex: any) {
        if (isErrorOfMissingDoc(ex)) {
            const randomStrSrc = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
            const temp = [...Array(30)]
                .map((e) => Math.floor(Math.random() * randomStrSrc.length))
                .map((e) => randomStrSrc[e])
                .join("");
            const newSyncInfo: SyncInfo = {
                _id: SYNCINFO_ID,
                type: "syncinfo",
                data: temp,
            };
            if (await db.put(newSyncInfo)) {
                return true;
            }
            return false;
        } else {
            console.dir(ex);
            return false;
        }
    }
};


export async function putDesignDocuments(db: PouchDB.Database) {
    type DesignDoc = {
        _id: string;
        _rev?: string;
        ver: number;
        filters: {
            default: string,
            push: string,
            pull: string,
        };
    }
    const design: DesignDoc = {
        "_id": "_design/replicate",
        "_rev": undefined as string | undefined,
        "ver": 2,
        "filters": {
            "default": function (doc: any, req: any) {
                return !("remote" in doc && doc.remote);
            }.toString(),
            "push": function (doc: any, req: any) {
                return true;
            }.toString(),
            "pull": function (doc: any, req: any) {
                return !(doc.type && doc.type == "leaf")
            }.toString(),
        }
    }

    // We can use the filter on replication :   filter: 'replicate/default',

    try {
        const w = await db.get<DesignDoc>(design._id);
        if (w.ver < design.ver) {
            design._rev = w._rev;
            //@ts-ignore
            await db.put(design);
            return true;
        }
    } catch (ex: any) {
        if (isErrorOfMissingDoc(ex)) {
            delete design._rev;
            //@ts-ignore
            await db.put(design);
            return true;
        } else {
            Logger("Could not make design documents", LOG_LEVEL_INFO);
        }
    }
    return false;
}

// requires transform-pouch
export const enableEncryption = (db: PouchDB.Database<EntryDoc>, passphrase: string, useDynamicIterationCount: boolean, migrationDecrypt: boolean, useV1: boolean) => {
    const decrypted = new Map();
    //@ts-ignore
    db.transform({
        incoming: async (doc: AnyEntry | EntryLeaf) => {
            const saveDoc = {
                ...doc,
            } as EntryLeaf | AnyEntry;
            if (isEncryptedChunkEntry(saveDoc) || isSyncInfoEntry(saveDoc)) {
                try {
                    saveDoc.data = await encrypt(saveDoc.data, passphrase, useDynamicIterationCount, useV1);
                } catch (ex) {
                    Logger("Encryption failed.", LOG_LEVEL_NOTICE);
                    Logger(ex);
                    throw ex;
                }
            }
            if (isObfuscatedEntry(saveDoc)) {
                try {
                    saveDoc.path = await encrypt(getPath(saveDoc), passphrase, useDynamicIterationCount, useV1) as unknown as FilePathWithPrefix;
                } catch (ex) {
                    Logger("Encryption failed.", LOG_LEVEL_NOTICE);
                    Logger(ex);
                    throw ex;
                }
            }
            return saveDoc;
        },
        outgoing: async (doc: EntryDoc) => {
            const loadDoc = {
                ...doc,
            } as AnyEntry | EntryLeaf;
            const _isChunkOrSyncInfo = isEncryptedChunkEntry(loadDoc) || isSyncInfoEntry(loadDoc);
            const _isObfuscatedEntry = isObfuscatedEntry(loadDoc);
            if (_isChunkOrSyncInfo || _isObfuscatedEntry) {
                if (migrationDecrypt && decrypted.has(loadDoc._id)) {
                    return loadDoc; // once decrypted.
                }
                try {
                    if (_isChunkOrSyncInfo) {
                        loadDoc.data = await decrypt(loadDoc.data, passphrase, useDynamicIterationCount);
                    }
                    if (_isObfuscatedEntry) {
                        loadDoc.path = await decrypt(getPath(loadDoc), passphrase, useDynamicIterationCount) as unknown as FilePathWithPrefix;
                    }
                    if (migrationDecrypt) {
                        decrypted.set(loadDoc._id, true);
                    }
                } catch (ex) {
                    if (useDynamicIterationCount) {
                        try {
                            if (_isChunkOrSyncInfo) {
                                loadDoc.data = await decrypt(loadDoc.data, passphrase, false);
                            }
                            if (_isObfuscatedEntry) {
                                loadDoc.path = await decrypt(getPath(loadDoc), passphrase, useDynamicIterationCount) as unknown as FilePathWithPrefix;
                            }
                            if (migrationDecrypt) {
                                decrypted.set(loadDoc._id, true);
                            }
                        } catch (ex: any) {
                            if (migrationDecrypt && ex.name == "SyntaxError") {
                                return loadDoc; // This logic will be removed in a while.
                            }
                            Logger("Decryption failed.", LOG_LEVEL_NOTICE);
                            Logger(ex, LOG_LEVEL_VERBOSE);
                            throw ex;
                        }
                    } else {
                        Logger("Decryption failed.", LOG_LEVEL_NOTICE);
                        Logger(ex, LOG_LEVEL_VERBOSE);
                        throw ex;
                    }
                }
            }
            return loadDoc;
        },
    });
};

export function isErrorOfMissingDoc(ex: any) {
    return (ex && ex?.status) == 404;
}

async function prepareChunkDesignDoc(db: PouchDB.Database) {
    const chunkDesignDoc = {
        _id: '_design/chunks',
        _rev: undefined as any,
        ver: 2,
        views: {
            collectDangling: {
                map: function (doc: any) {
                    if (doc._id.startsWith("h:")) {
                        //@ts-ignore
                        emit([doc._id], 0);
                    } else {
                        if ("children" in doc) {
                            //@ts-ignore
                            doc.children.forEach(e => emit([e], 1));
                        }
                    }
                }.toString(),
                reduce: '_sum'
            }

        }
    };
    // save it
    let updateDDoc = false;
    try {
        const old = await db.get<typeof chunkDesignDoc>(chunkDesignDoc._id);
        if (old?.ver ?? 0 < chunkDesignDoc.ver) {
            chunkDesignDoc._rev = old._rev;
            updateDDoc = true;
        }

    } catch (ex) {
        if (ex.status == 404) {
            // NO OP
            updateDDoc = true;
        } else {
            Logger(`Failed to make design document for operating chunks`);
            Logger(ex, LOG_LEVEL_VERBOSE);
            return false;
        }
    }
    try {
        if (updateDDoc) {
            await db.put<typeof chunkDesignDoc>(chunkDesignDoc);
        }
    } catch (ex: any) {
        // NO OP.
        Logger(`Failed to make design document for operating chunks`);
        Logger(ex, LOG_LEVEL_VERBOSE);
        return false;
    }
    return true;
}
export async function collectChunksUsage(db: PouchDB.Database) {
    if (!await prepareChunkDesignDoc(db)) {
        Logger(`Could not prepare design document for operating chunks`);
        return [];
    }
    const q = await db.query("chunks/collectDangling", { reduce: true, group: true });
    const rows = q.rows as { value: number, key: string[] }[];
    return rows;
}
export function collectUnreferencedChunks(db: PouchDB.Database) {
    return collectChunks(db, "DANGLING");
}
export async function collectChunks(db: PouchDB.Database, type: "INUSE" | "DANGLING" | "ALL") {
    const rows = await collectChunksUsage(db);

    const rowF = type == "ALL" ? rows :
        rows.filter(e => type == "DANGLING" ? (e.value == 0) : (e.value != 0));
    const ids = rowF.flatMap(e => e.key);
    const docs = (await db.allDocs({ keys: ids })).rows;
    const items = docs.filter(e => !("error" in e)).map((e: any) => ({ id: e.id, rev: e.value.rev }));
    return items;
}

export async function collectUnbalancedChunkIDs(local: PouchDB.Database, remote: PouchDB.Database) {
    const chunksOnLocal = await collectChunks(local, "INUSE");
    const chunksOnRemote = await collectChunks(remote, "INUSE");
    const onlyOnLocal = chunksOnLocal.filter(e => !chunksOnRemote.some(ee => ee.id == e.id))
    const onlyOnRemote = chunksOnRemote.filter(e => !chunksOnLocal.some(ee => ee.id == e.id))
    return { onlyOnLocal, onlyOnRemote };
}

export async function purgeChunksLocal(db: PouchDB.Database, docs: { id: string, rev: string }[]) {
    await serialized("purge-local", async () => {
        try {
            // Back chunks up to the _local of local database to see the history.
            Logger(`Purging unused ${docs.length} chunks `, LOG_LEVEL_NOTICE, "purge-local-backup");
            const batchDocsBackup = arrayToChunkedArray(docs, 100);
            let total = { ok: 0, exist: 0, error: 0 };
            for (const docsInBatch of batchDocsBackup) {
                const backupDocsFrom = await db.allDocs({ keys: docsInBatch.map(e => e.id), include_docs: true });
                const backupDocs = backupDocsFrom.rows.filter(e => "doc" in e).map(e => {
                    const chunk = { ...(e as any).doc };
                    delete chunk._rev;
                    chunk._id = `_local/${chunk._id}`;
                    return chunk;
                })
                const ret = await db.bulkDocs(backupDocs);
                total = ret.map(e => (
                    {
                        ok: ("ok" in e) ? 1 : 0,
                        exist: ("status" in e && e.status == 409) ? 1 : 0,
                        error: ("status" in e && e.status != 409) ? 1 : 0
                    }
                )).reduce((p, c) => ({ ok: p.ok + c.ok, exist: p.exist + c.exist, error: p.error + c.error }), total);
                Logger(`Local chunk backed up: new:${total.ok} ,exist:${total.exist}, error:${total.error}`, LOG_LEVEL_NOTICE, "purge-local-backup");
                const erroredItems = ret.filter(e => "error" in e && e.status != 409);
                for (const item of erroredItems) {
                    Logger(`Failed to back up: ${item.id} / ${item.rev}`, LOG_LEVEL_VERBOSE);
                }
            }
        } catch (ex) {
            Logger(`Could not back up chunks`);
            Logger(ex, LOG_LEVEL_VERBOSE);
        }

        Logger(`Purging unused ${docs.length} chunks... `, LOG_LEVEL_NOTICE, "purge-local");
        const batchDocs = arrayToChunkedArray(docs, 100);
        let totalRemoved = 0;
        for (const docsInBatch of batchDocs) {
            //@ts-ignore: type def missing
            const removed = await db.purgeMulti(docsInBatch.map(e => [e.id, e.rev]));
            const removedCount = Object.values(removed).filter(e => "ok" in (e as object)).length;
            totalRemoved += removedCount;
            Logger(`Purging:  ${totalRemoved} / ${docs.length}`, LOG_LEVEL_NOTICE, "purge-local");
        }

        Logger(`Purging unused chunks done!: ${totalRemoved} chunks has been deleted.`, LOG_LEVEL_NOTICE, "purge-local");
    });
}

const _requestToCouchDBFetch = async (baseUri: string, username: string, password: string, path?: string, body?: string | any, method?: string) => {
    const utf8str = String.fromCharCode.apply(null, [...writeString(`${username}:${password}`)]);
    const encoded = window.btoa(utf8str);
    const authHeader = "Basic " + encoded;
    const transformedHeaders: Record<string, string> = { authorization: authHeader, "content-type": "application/json" };
    const uri = `${baseUri}/${path}`;
    const requestParam = {
        url: uri,
        method: method || (body ? "PUT" : "GET"),
        headers: new Headers(transformedHeaders),
        contentType: "application/json",
        body: JSON.stringify(body),
    };
    return await fetch(uri, requestParam);
}
export async function purgeChunksRemote(setting: CouchDBConnection, docs: { id: string, rev: string }[]) {
    await serialized("purge-remote", async () => {
        const CHUNK_SIZE = 100;
        function makeChunkedArrayFromArray<T>(items: T[]): T[][] {
            const chunked = [];
            for (let i = 0; i < items.length; i += CHUNK_SIZE) {
                chunked.push(items.slice(i, i + CHUNK_SIZE));
            }
            return chunked;
        }
        const buffer = makeChunkedArrayFromArray(docs);
        for (const chunkedPayload of buffer) {
            const rets = await _requestToCouchDBFetch(
                `${setting.couchDB_URI}/${setting.couchDB_DBNAME}`,
                setting.couchDB_USER,
                setting.couchDB_PASSWORD,
                "_purge",
                chunkedPayload.reduce((p, c) => ({ ...p, [c.id]: [c.rev] }), {}), "POST");
            // const result = await rets();
            Logger(JSON.stringify(await rets.json()), LOG_LEVEL_VERBOSE);
        }
        return;
    });
}

function sizeToHumanReadable(size: number | undefined) {
    if (!size) return "-";
    const i = Math.floor(Math.log(size) / Math.log(1024));
    return Number.parseInt((size / Math.pow(1024, i)).toFixed(2)) + ' ' + ['B', 'kB', 'MB', 'GB', 'TB'][i];
}

export async function purgeUnreferencedChunks(db: PouchDB.Database, dryRun: boolean, connSetting?: CouchDBConnection, performCompact = false) {
    const info = await db.info();
    let resultCount = 0;
    const getSize = function (info: PouchDB.Core.DatabaseInfo, key: "active" | "external" | "file") {
        return Number.parseInt((info as any)?.sizes?.[key] ?? 0);
    }
    const keySuffix = connSetting ? "-remote" : "-local";
    Logger(`${dryRun ? "Counting" : "Cleaning"} ${connSetting ? "remote" : "local"} database`, LOG_LEVEL_NOTICE);

    if (connSetting) {
        Logger(`Database active-size: ${sizeToHumanReadable(getSize(info, "active"))
            }, external-size:${sizeToHumanReadable(getSize(info, "external"))
            }, file-size: ${sizeToHumanReadable(getSize(info, "file"))}`, LOG_LEVEL_NOTICE);
    }
    Logger(`Collecting unreferenced chunks on ${info.db_name}`, LOG_LEVEL_NOTICE, "gc-countchunk" + keySuffix);
    const chunks = await collectUnreferencedChunks(db);
    resultCount = chunks.length;
    if (chunks.length == 0) {
        Logger(`No unreferenced chunks! ${info.db_name}`, LOG_LEVEL_NOTICE, "gc-countchunk" + keySuffix);
    } else {
        Logger(`Number of unreferenced chunks on ${info.db_name}: ${chunks.length}`, LOG_LEVEL_NOTICE, "gc-countchunk" + keySuffix);
        if (dryRun) {
            Logger(`DryRun of cleaning ${connSetting ? "remote" : "local"} database up: Done`, LOG_LEVEL_NOTICE);
            return resultCount;
        }
        if (connSetting) {
            Logger(`Cleaning unreferenced chunks on remote`, LOG_LEVEL_NOTICE, "gc-purge" + keySuffix);
            await purgeChunksRemote(connSetting, chunks);
        } else {
            Logger(`Cleaning unreferenced chunks on local`, LOG_LEVEL_NOTICE, "gc-purge" + keySuffix);
            await purgeChunksLocal(db, chunks);
        }
        Logger(`Cleaning unreferenced chunks done!`, LOG_LEVEL_NOTICE, "gc-purge" + keySuffix);
    }

    if (performCompact) {
        Logger(`Compacting database...`, LOG_LEVEL_NOTICE, "gc-compact" + keySuffix);
        await db.compact();
        Logger(`Compacting database done`, LOG_LEVEL_NOTICE, "gc-compact" + keySuffix);
    }
    if (connSetting) {
        const endInfo = await db.info();
        Logger(`Processed database active-size: ${sizeToHumanReadable(getSize(endInfo, "active"))
            }, external-size:${sizeToHumanReadable(getSize(endInfo, "external"))
            }, file-size: ${sizeToHumanReadable(getSize(endInfo, "file"))}`, LOG_LEVEL_NOTICE);
        Logger(`Reduced sizes: active-size: ${sizeToHumanReadable(getSize(info, "active") - getSize(endInfo, "active"))
            }, external-size:${sizeToHumanReadable(getSize(info, "external") - getSize(endInfo, "external"))
            }, file-size: ${sizeToHumanReadable(getSize(info, "file") - getSize(endInfo, "file"))
            }`, LOG_LEVEL_NOTICE);
    }
    Logger(`Cleaning ${connSetting ? "remote" : "local"} database up: Done`, LOG_LEVEL_NOTICE);
    return resultCount;
}

function transferChunks(key: string, dispKey: string, dbFrom: PouchDB.Database, dbTo: PouchDB.Database, items: {
    id: string;
    rev: string;
}[]) {
    const itemsChunked = arrayToChunkedArray(items, 25);
    let totalProcessed = 0;
    const total = items.length;
    const tasks = [...itemsChunked].map(batched => async () => {
        const processedItems = batched.length;

        try {
            const docs = await dbFrom.allDocs({ keys: batched.map(e => e.id), include_docs: true });
            const docsToSend = docs.rows.filter(e => !("error" in e)).map((e: any) => e.doc);
            await dbTo.bulkDocs(docsToSend, { new_edits: false });
        } catch (ex) {
            Logger(`${dispKey}: Something went wrong on balancing`, LOG_LEVEL_NOTICE);
            Logger(ex, LOG_LEVEL_VERBOSE);
        } finally {
            totalProcessed += processedItems;
            Logger(`${dispKey}: ${totalProcessed} / ${total}`, LOG_LEVEL_NOTICE, "balance-" + key);
        }
    })
    return tasks;
}
// Complement unbalanced chunks between databases which were separately cleaned up.
export async function balanceChunkPurgedDBs(local: PouchDB.Database, remote: PouchDB.Database) {
    Logger(`Complement missing chunks between databases`, LOG_LEVEL_NOTICE);
    try {
        const { onlyOnLocal, onlyOnRemote } = await collectUnbalancedChunkIDs(local, remote);
        const localToRemote = transferChunks("l2r", "local -> remote", local, remote, onlyOnLocal);
        const remoteToLocal = transferChunks("r2l", "remote -> local", remote, local, onlyOnRemote);
        await mapAllTasksWithConcurrencyLimit(6, [...localToRemote, ...remoteToLocal]);
        Logger(`local -> remote: Done`, LOG_LEVEL_NOTICE, "balance-l2r");
        Logger(`remote -> local: Done`, LOG_LEVEL_NOTICE, "balance-r2l");
    } catch (ex) {
        Logger("Something went wrong on balancing!", LOG_LEVEL_NOTICE);
        Logger(ex, LOG_LEVEL_VERBOSE);
    }
    Logger("Complement completed!", LOG_LEVEL_NOTICE);
}

export async function fetchAllUsedChunks(local: PouchDB.Database, remote: PouchDB.Database) {
    try {
        const chunksOnRemote = await collectChunks(remote, "INUSE");
        const remoteToLocal = transferChunks("r2l", "remote -> local", remote, local, chunksOnRemote);
        await mapAllTasksWithConcurrencyLimit(3, remoteToLocal);
        Logger(`remote -> local: Done`, LOG_LEVEL_NOTICE, "balance-r2l");
    } catch (ex) {
        Logger("Something went wrong on balancing!", LOG_LEVEL_NOTICE);
        Logger(ex, LOG_LEVEL_VERBOSE);
    }
}