import { SYNCINFO_ID, VER, VERSIONING_DOCID, type EntryVersionInfo, type SyncInfo } from "../common/types";
import { resolveWithIgnoreKnownError } from "../common/utils";
import { isErrorOfMissingDoc } from "./utils_couchdb";

export const checkRemoteVersion = async (
    db: PouchDB.Database,
    migrate: (from: number, to: number) => Promise<boolean>,
    barrier: number = VER
): Promise<boolean> => {
    try {
        const versionInfo = (await db.get(VERSIONING_DOCID)) as EntryVersionInfo;
        if (versionInfo.type != "versioninfo") {
            return false;
        }
        // const salt = versionInfo?.pbkdf2salt;
        const version = versionInfo.version;
        if (version < barrier) {
            const versionUpResult = await migrate(version, barrier);
            if (versionUpResult) {
                await bumpRemoteVersion(db);
                return true;
            }
        }
        // setPBKDF2Salt(salt);
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
        _id: VERSIONING_DOCID,
        version: barrier,
        type: "versioninfo",
        // pbkdf2salt: "", // this will be set later.
    };
    const versionInfo = await resolveWithIgnoreKnownError<EntryVersionInfo>(db.get(VERSIONING_DOCID), vi);
    if (versionInfo.type != "versioninfo") {
        return false;
    }
    // if (!versionInfo?.pbkdf2salt) {
    //     // PBKDF2 salt for replication e2ee
    //     const salt = createPBKDF2Salt();
    //     const saltBase64 = await arrayBufferToBase64Single(salt);
    //     versionInfo.pbkdf2salt = saltBase64;
    // }
    vi._rev = versionInfo._rev;
    // vi.pbkdf2salt = versionInfo.pbkdf2salt;
    // setPBKDF2Salt(vi.pbkdf2salt);

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
                .map((_e) => Math.floor(Math.random() * randomStrSrc.length))
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
