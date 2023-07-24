import { decrypt, encrypt } from "./e2ee_v2";
import { Logger } from "./logger";
import { getPath } from "./path";
import { LOG_LEVEL, VER, VERSIONINFO_DOCID, EntryVersionInfo, SYNCINFO_ID, SyncInfo, EntryDoc, EntryLeaf, AnyEntry, FilePathWithPrefix, CouchDBConnection } from "./types";
import { isEncryptedChunkEntry, isObfuscatedEntry, isSyncInfoEntry, resolveWithIgnoreKnownError } from "./utils";

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
            Logger("Could not make design documents", LOG_LEVEL.INFO);
        }
    }
    return false;
}

// requires transform-pouch
export const enableEncryption = (db: PouchDB.Database<EntryDoc>, passphrase: string, useDynamicIterationCount: boolean, migrationDecrypt?: boolean) => {
    const decrypted = new Map();
    //@ts-ignore
    db.transform({
        incoming: async (doc: AnyEntry | EntryLeaf) => {
            const saveDoc = {
                ...doc,
            } as EntryLeaf | AnyEntry;
            if (isEncryptedChunkEntry(saveDoc) || isSyncInfoEntry(saveDoc)) {
                try {
                    saveDoc.data = await encrypt(saveDoc.data, passphrase, useDynamicIterationCount);
                } catch (ex) {
                    Logger("Encryption failed.", LOG_LEVEL.NOTICE);
                    Logger(ex);
                    throw ex;
                }
            }
            if (isObfuscatedEntry(saveDoc)) {
                try {
                    saveDoc.path = await encrypt(getPath(saveDoc), passphrase, useDynamicIterationCount) as unknown as FilePathWithPrefix;
                } catch (ex) {
                    Logger("Encryption failed.", LOG_LEVEL.NOTICE);
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
                            Logger("Decryption failed.", LOG_LEVEL.NOTICE);
                            Logger(ex);
                            throw ex;
                        }
                    } else {
                        Logger("Decryption failed.", LOG_LEVEL.NOTICE);
                        Logger(ex);
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
            Logger(ex, LOG_LEVEL.VERBOSE);
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
        Logger(ex, LOG_LEVEL.VERBOSE);
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
    const items = docs.filter(e => !("error" in e)).map(e => ({ id: e.id, rev: e.value.rev }));
    return items;
}

export async function collectUnbalancedChunks(db1: PouchDB.Database, db2: PouchDB.Database) {
    const chunks1 = await collectChunks(db1, "INUSE");
    const chunks2 = await collectChunks(db2, "INUSE");
    const onlyOnAid = chunks1.filter(e => !chunks2.some(ee => ee.id == e.id))
    const onlyOnBid = chunks2.filter(e => !chunks1.some(ee => ee.id == e.id))
    // TODO: Perhaps too big response.
    const onlyOnA = (await db1.allDocs({ keys: onlyOnAid.map(e => e.id), include_docs: true })).
        rows.filter(e => !("error" in e)).map(e => e.doc);
    const onlyOnB = (await db2.allDocs({ keys: onlyOnBid.map(e => e.id), include_docs: true })).
        rows.filter(e => !("error" in e)).map(e => e.doc);
    return { onlyOnA, onlyOnB };
}

export async function purgeChunksLocal(db: PouchDB.Database, docs: { id: string, rev: string }[]) {
    for (const doc of docs) {
        try {
            // Back the chunk up to show the history
            try {
                const chunk = await db.get(doc.id);
                delete chunk._rev;
                chunk._id = `_local/${chunk._id}`;
                await db.put({ _id: `_local/${chunk._id}`, ...chunk });
            } catch (ex) {
                if (ex.status != 409) {
                    Logger(`Could not escape purging chunk:${doc.id}/${doc.rev}`);
                }
            }
            //@ts-ignore: type def missing
            const ret = await db.purge(doc.id, doc.rev);
            if (("ok" in ret)) {
                Logger(`The chunk has been purged:${doc.id}/${doc.rev}`, LOG_LEVEL.VERBOSE);
                Logger(ret, LOG_LEVEL.VERBOSE);
            } else {
                Logger(`Could not purge the doc:${doc.id}/${doc.rev}`);
            }
        } catch (ex) {
            Logger(`Error while purging docs:${doc.id}/${doc.rev}`);
            Logger(ex, LOG_LEVEL.VERBOSE);
        }
    }
}

const _requestToCouchDBFetch = async (baseUri: string, username: string, password: string, path?: string, body?: string | any, method?: string) => {
    const utf8str = String.fromCharCode.apply(null, new TextEncoder().encode(`${username}:${password}`));
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
        Logger(JSON.stringify(await rets.json()), LOG_LEVEL.VERBOSE);
    }
    return;
}

function sizeToHumanReadable(size: number | undefined) {
    if (!size) return "-";
    const i = Math.floor(Math.log(size) / Math.log(1024));
    return Number.parseInt((size / Math.pow(1024, i)).toFixed(2)) + ' ' + ['B', 'kB', 'MB', 'GB', 'TB'][i];
}

export async function purgeUnreferencedChunks(db: PouchDB.Database, dryRun: boolean, connSetting?: CouchDBConnection, performCompact = false) {
    const info = await db.info();
    const getSize = function (info: PouchDB.Core.DatabaseInfo, key: "active" | "external" | "file") {
        return Number.parseInt((info as any)?.sizes?.[key] ?? 0);
    }
    const keySuffix = connSetting ? "-remote" : "-local";
    Logger(`${dryRun ? "Counting" : "Cleaning"} ${connSetting ? "remote" : "local"} database`, LOG_LEVEL.NOTICE);

    if (connSetting) {
        Logger(`Database active-size: ${sizeToHumanReadable(getSize(info, "active"))
            }, external-size:${sizeToHumanReadable(getSize(info, "external"))
            }, file-size: ${sizeToHumanReadable(getSize(info, "file"))}`, LOG_LEVEL.NOTICE);
    }
    Logger(`Collecting unreferenced chunks on ${info.db_name}`, LOG_LEVEL.NOTICE, "gc-countchunk" + keySuffix);
    const chunks = await collectUnreferencedChunks(db);
    if (chunks.length == 0) {
        Logger(`No unreferenced chunks! ${info.db_name}`, LOG_LEVEL.NOTICE, "gc-countchunk" + keySuffix);
        return;
    }
    Logger(`Number of unreferenced chunks on ${info.db_name}: ${chunks.length}`, LOG_LEVEL.NOTICE, "gc-countchunk" + keySuffix);
    if (dryRun) {
        return;
    }
    if (connSetting) {
        Logger(`Cleaning unreferenced chunks on remote`, LOG_LEVEL.NOTICE, "gc-purge" + keySuffix);
        await purgeChunksRemote(connSetting, chunks);
    } else {
        Logger(`Cleaning unreferenced chunks on local`, LOG_LEVEL.NOTICE, "gc-purge" + keySuffix);
        await purgeChunksLocal(db, chunks);
    }
    Logger(`Cleaning unreferenced chunks done!`, LOG_LEVEL.NOTICE, "gc-purge" + keySuffix);
    if (performCompact) {
        await db.compact();
    }
    if (connSetting) {
        const endInfo = await db.info();
        Logger(`Processed database active-size: ${sizeToHumanReadable(getSize(endInfo, "active"))
            }, external-size:${sizeToHumanReadable(getSize(endInfo, "external"))
            }, file-size: ${sizeToHumanReadable(getSize(endInfo, "file"))}`, LOG_LEVEL.NOTICE);
        Logger(`Reduced sizes: active-size: ${sizeToHumanReadable(getSize(info, "active") - getSize(endInfo, "active"))
            }, external-size:${sizeToHumanReadable(getSize(info, "external") - getSize(endInfo, "external"))
            }, file-size: ${sizeToHumanReadable(getSize(info, "file") - getSize(endInfo, "file"))
            }`, LOG_LEVEL.NOTICE);
    }
    Logger(`Cleaning ${connSetting ? "remote" : "local"} database up: Done`, LOG_LEVEL.NOTICE);
}
// Complement unbalanced chunks between databases which were separately cleaned up.
export async function balanceChunkPurgedDBs(local: PouchDB.Database, remote: PouchDB.Database) {
    Logger(`Complement unbalanced chunks between databases`, LOG_LEVEL.NOTICE);
    try {
        // TODO: Perhaps too big request.
        const { onlyOnA, onlyOnB } = await collectUnbalancedChunks(local, remote);
        Logger(`Local <- remote: ${onlyOnB.length} docs`);
        await local.bulkDocs(onlyOnB, { new_edits: false });
        Logger(`Local -> remote: ${onlyOnA.length} docs`);
        await remote.bulkDocs(onlyOnA, { new_edits: false });
    } catch (ex) {
        Logger("Something went wrong on balancing!", LOG_LEVEL.NOTICE);
        Logger(ex, LOG_LEVEL.VERBOSE);
    }
    Logger("Complement completed!", LOG_LEVEL.NOTICE);
}