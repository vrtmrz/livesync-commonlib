import { VERSIONING_DOCID, type EntryDoc } from "@lib/common/types";
import { getPathNormalizationVersion } from "@lib/common/pathNormalization";
import {
    assessRemoteFeatureDocument,
    describeRemoteFeatureRejection,
    NFC_PATH_IDENTITY_FEATURE,
    REMOTE_FEATURE_GENERATION,
} from "./remoteFeatureCompatibility";
import { isErrorOfMissingDoc } from "./utils_couchdb";
import { bumpRemoteVersion } from "./negotiation";

type PathIdentitySettings = { pathNormalizationVersion?: number };

export type PathIdentityInspection =
    | { readonly status: "empty" }
    | { readonly status: "configured"; readonly pathNormalizationVersion: 0 | 1 };

/** Read the existing declaration without changing a remote or declaring a new identity. */
export async function inspectDatabasePathIdentity(
    database: PouchDB.Database<EntryDoc>
): Promise<PathIdentityInspection> {
    let document: EntryDoc;
    try {
        document = await database.get(VERSIONING_DOCID);
    } catch (error) {
        if (!isErrorOfMissingDoc(error)) throw error;
        return (await database.info()).doc_count === 0
            ? { status: "empty" }
            : { status: "configured", pathNormalizationVersion: 0 };
    }
    const assessment = assessRemoteFeatureDocument(document);
    if (assessment.status === "older-generation") return { status: "configured", pathNormalizationVersion: 0 };
    if (assessment.status !== "supported") throw new Error(describeRemoteFeatureRejection(assessment));
    return {
        status: "configured",
        pathNormalizationVersion: assessment.usedFeatures.includes(NFC_PATH_IDENTITY_FEATURE) ? 1 : 0,
    };
}

export function assertMatchingPathIdentityFeature(document: unknown, settings: PathIdentitySettings): void {
    const assessment = assessRemoteFeatureDocument(document);
    const declared = assessment.status === "supported" && assessment.usedFeatures.includes(NFC_PATH_IDENTITY_FEATURE);
    if (declared !== (getPathNormalizationVersion(settings) === 1)) {
        throw new Error(
            "The database and settings use different path identity versions. Rebuild from the authoritative Vault or Fetch with matching settings before synchronising."
        );
    }
}

/** Inspect Metadata only; Chunks and control documents do not establish a path identity. */
async function hasMetadata(database: PouchDB.Database<EntryDoc>): Promise<boolean> {
    let startkey: string | undefined;
    for (;;) {
        const result = await database.allDocs({
            include_docs: true,
            limit: 100,
            ...(startkey ? { startkey, skip: 1 } : {}),
        });
        for (const row of result.rows) {
            if (row.doc?.type === "plain" || row.doc?.type === "newnote") return true;
        }
        if (result.rows.length < 100) return false;
        startkey = result.rows[result.rows.length - 1].id;
    }
}

/** Refuse an implicit migration. A fresh database may declare its identity before its first Metadata write. */
export async function assertDatabasePathIdentity(
    database: PouchDB.Database<EntryDoc>,
    settings: PathIdentitySettings,
    declare = false
): Promise<void> {
    let document: EntryDoc | undefined;
    try {
        document = await database.get(VERSIONING_DOCID);
    } catch (error) {
        if (!isErrorOfMissingDoc(error)) throw error;
    }
    const assessment = assessRemoteFeatureDocument(document);
    const declared = assessment.status === "supported" && assessment.usedFeatures.includes(NFC_PATH_IDENTITY_FEATURE);
    if (getPathNormalizationVersion(settings) === 0) {
        if (declared) assertMatchingPathIdentityFeature(document, settings);
        return;
    }
    if (declared) return;
    if (await hasMetadata(database)) {
        // Another writer may have declared this fresh database while the listing was in progress.
        try {
            document = await database.get(VERSIONING_DOCID);
        } catch (error) {
            if (!isErrorOfMissingDoc(error)) throw error;
        }
        assertMatchingPathIdentityFeature(document, settings);
        return;
    }
    if (declare && !(await bumpRemoteVersion(database, REMOTE_FEATURE_GENERATION, [NFC_PATH_IDENTITY_FEATURE]))) {
        throw new Error("The database path identity could not be declared. Synchronisation has been stopped.");
    }
}
