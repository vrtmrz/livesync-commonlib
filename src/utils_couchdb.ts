import { decrypt, encrypt } from "./e2ee_v2";
import { Logger } from "./logger";
import { getPath } from "./path";
import { LOG_LEVEL, VER, VERSIONINFO_DOCID, EntryVersionInfo, SYNCINFO_ID, SyncInfo, EntryDoc, EntryLeaf, AnyEntry, FilePathWithPrefix } from "./types";
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