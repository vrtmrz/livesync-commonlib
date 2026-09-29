import { LOG_LEVEL_INFO, LOG_LEVEL_NOTICE, Logger } from "@lib/common/logger";
import {
    LOG_LEVEL_VERBOSE,
    SYNCINFO_ID,
    VER,
    VERSIONING_DOCID,
    type EntryVersionInfo,
    type SyncInfo,
} from "@lib/common/types";
import { isErrorOfMissingDoc } from "./utils_couchdb";
import {
    assessRemoteFeatureDocument,
    describeRemoteFeatureRejection,
    supportedFeatures,
    REMOTE_FEATURE_GENERATION,
} from "./remoteFeatureCompatibility";

export const checkRemoteVersion = async (
    db: PouchDB.Database,
    migrate: (from: number, to: number) => Promise<boolean>,
    barrier: number = VER,
    requiredFeatures: readonly string[] = []
): Promise<boolean> => {
    try {
        const versionInfo = (await db.get(VERSIONING_DOCID)) as EntryVersionInfo;
        const assessment = assessRemoteFeatureDocument(versionInfo);
        if (assessment.status === "older-generation") {
            if (assessment.version >= barrier) return true;
            if (!(await migrate(assessment.version, barrier))) return false;
            if (!(await bumpRemoteVersion(db, barrier))) return false;
            return requiredFeatures.length === 0 || (await declareRemoteFeatures(db, requiredFeatures));
        }
        if (assessment.status !== "supported") {
            Logger(describeRemoteFeatureRejection(assessment), LOG_LEVEL_NOTICE);
            return false;
        }
        if (versionInfo.version < barrier) return false;
        return requiredFeatures.length === 0 || (await declareRemoteFeatures(db, requiredFeatures));
    } catch (ex) {
        if (isErrorOfMissingDoc(ex)) {
            const info = await db.info();
            if (info.doc_count > 0) return false;
            return await bumpRemoteVersion(
                db,
                requiredFeatures.length ? REMOTE_FEATURE_GENERATION : VER,
                requiredFeatures
            );
        }
        throw ex;
    }
};
export const bumpRemoteVersion = async (
    db: PouchDB.Database,
    barrier: number = VER,
    usedFeatures: readonly string[] = []
): Promise<boolean> => {
    for (let attempt = 0; attempt < 4; attempt++) {
        let current: EntryVersionInfo | undefined;
        try {
            current = (await db.get(VERSIONING_DOCID)) as EntryVersionInfo;
        } catch (error) {
            if (!isErrorOfMissingDoc(error)) throw error;
        }
        if (current) {
            const assessment = assessRemoteFeatureDocument(current);
            if (assessment.status !== "supported" && assessment.status !== "older-generation") {
                Logger(describeRemoteFeatureRejection(assessment), LOG_LEVEL_NOTICE);
                return false;
            }
            if (current.version >= barrier) {
                return usedFeatures.length === 0 || (await declareRemoteFeatures(db, usedFeatures));
            }
        }
        const next: EntryVersionInfo = {
            ...current,
            _id: VERSIONING_DOCID,
            version: barrier,
            type: "versioninfo",
            ...(barrier >= REMOTE_FEATURE_GENERATION ? { used_features: [...new Set(usedFeatures)] } : {}),
        };
        try {
            await db.put(next);
            return true;
        } catch (error) {
            if (typeof error !== "object" || error === null || !("status" in error) || error.status !== 409) {
                throw error;
            }
        }
    }
    return false;
};

export async function declareRemoteFeatures(
    db: PouchDB.Database,
    requiredFeatures: readonly string[]
): Promise<boolean> {
    const requested = [...new Set(requiredFeatures)];
    if (requested.some((name) => !supportedFeatures.has(name))) {
        throw new Error("A writer requested an unsupported remote feature.");
    }
    if (requested.length === 0) return true;
    for (let attempt = 0; attempt < 4; attempt++) {
        const current = (await db.get(VERSIONING_DOCID)) as EntryVersionInfo;
        const assessment = assessRemoteFeatureDocument(current);
        if (assessment.status !== "supported") {
            Logger(describeRemoteFeatureRejection(assessment), LOG_LEVEL_NOTICE);
            return false;
        }
        const usedFeatures = [...new Set([...assessment.usedFeatures, ...requested])];
        if (current.version === REMOTE_FEATURE_GENERATION && usedFeatures.length === assessment.usedFeatures.length) {
            return true;
        }
        try {
            await db.put({ ...current, version: REMOTE_FEATURE_GENERATION, used_features: usedFeatures });
            return true;
        } catch (ex) {
            if (typeof ex !== "object" || ex === null || !("status" in ex) || ex.status !== 409) throw ex;
        }
    }
    return false;
}

export const checkSyncInfo = async (db: PouchDB.Database): Promise<boolean> => {
    try {
        const syncinfo = (await db.get(SYNCINFO_ID)) as SyncInfo;
        console.log(syncinfo);
        // if we could decrypt the doc, it must be ok.
        return true;
    } catch (ex) {
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

// Selectors to already transferred compromised chunks (before h:, i.e., "0123456")
const SELECTOR_COMPROMISED_CHUNK_1 = {
    selector: {
        _id: {
            $lt: "h:",
        },
        type: "leaf",
    },
} as const;

// Selectors to already transferred compromised chunks (after h:, i.e., "ijklmnop")
const SELECTOR_COMPROMISED_CHUNK_2 = {
    selector: {
        _id: {
            $gt: "h;",
        },
        type: "leaf",
    },
} as const;

/**
 * Counts the number of remote (potentially) compromised chunks in the database.
 * @param db The PouchDB database instance.
 * @returns The number of compromised chunks or false if an error occurs.
 */
export async function countCompromisedChunks(db: PouchDB.Database): Promise<number | false> {
    try {
        Logger(`Counting compromised chunks...`, LOG_LEVEL_VERBOSE);
        const task1 = db.find(SELECTOR_COMPROMISED_CHUNK_1);
        const task2 = db.find(SELECTOR_COMPROMISED_CHUNK_2);
        const [result1, result2] = await Promise.all([task1, task2]);
        return result1.docs.length + result2.docs.length;
    } catch (ex) {
        Logger(`Error counting compromised chunks!`, LOG_LEVEL_INFO);
        Logger(ex, LOG_LEVEL_VERBOSE);
        return false;
    }
}
