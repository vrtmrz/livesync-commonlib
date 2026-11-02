import { VERSIONING_DOCID } from "@lib/common/models/db.const.ts";
import type { PathNormalizationVersion } from "@lib/common/models/setting.type.ts";
import {
    assessRemoteFeatureDocument,
    describeRemoteFeatureRejection,
    NFC_PATH_IDENTITY_FEATURE,
} from "@lib/pouchdb/remoteFeatureCompatibility.ts";
import { isErrorOfMissingDoc } from "@lib/pouchdb/utils_couchdb.ts";

type PathIdentityDocumentRead = { kind: "found"; document: unknown } | { kind: "missing" };
type VersionInfoResponse = {
    results: [{ id: string; docs: [Record<string, unknown>] }];
};

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwnField(value: Record<string, unknown>, key: string): boolean {
    return Object.hasOwn(value, key);
}

function isVersionInfoResponse(value: unknown): value is VersionInfoResponse {
    if (!isRecord(value) || !Array.isArray(value.results) || value.results.length !== 1) return false;
    const [result] = value.results;
    return (
        isRecord(result) &&
        result.id === VERSIONING_DOCID &&
        Array.isArray(result.docs) &&
        result.docs.length === 1 &&
        isRecord(result.docs[0])
    );
}

function isMissingDocumentResult(result: Record<string, unknown>): boolean {
    if (!hasOwnField(result, "error")) return false;
    const error = result.error;
    const errorDetails = isRecord(error) ? error : undefined;
    const status = errorDetails?.status ?? result.status;
    const errorName = errorDetails?.name ?? result.name;
    const errorCode = typeof error === "string" ? error : errorDetails?.error;
    return status === 404 || (status === undefined && (errorName === "not_found" || errorCode === "not_found"));
}

function parseRemotePathIdentityDocument(response: unknown): PathIdentityDocumentRead {
    if (!isVersionInfoResponse(response)) {
        throw new Error("P2P remote versioninfo response is malformed.");
    }
    const [documentResult] = response.results[0].docs;
    if (hasOwnField(documentResult, "ok")) {
        const document = documentResult.ok;
        if (!isRecord(document) || document._id !== VERSIONING_DOCID) {
            throw new Error("P2P remote versioninfo response is malformed.");
        }
        return { kind: "found", document };
    }
    if (isMissingDocumentResult(documentResult)) return { kind: "missing" };
    throw new Error("P2P remote versioninfo could not be read.");
}

function resolvePathIdentity(
    result: PathIdentityDocumentRead,
    configuredVersion: PathNormalizationVersion
): PathNormalizationVersion {
    if (result.kind === "missing") {
        if (configuredVersion === 0) return 0;
        throw new Error("P2P NFC database is missing path identity version information.");
    }
    const assessment = assessRemoteFeatureDocument(result.document);
    if (assessment.status === "older-generation" && configuredVersion === 0) return 0;
    if (assessment.status !== "supported") {
        throw new Error(describeRemoteFeatureRejection(assessment));
    }
    return assessment.usedFeatures.includes(NFC_PATH_IDENTITY_FEATURE) ? 1 : 0;
}

export async function readLocalP2PPathIdentity(
    database: { get(id: string): Promise<unknown> },
    configuredVersion: PathNormalizationVersion
): Promise<PathNormalizationVersion> {
    let result: PathIdentityDocumentRead;
    try {
        result = { kind: "found", document: await database.get(VERSIONING_DOCID) };
    } catch (error) {
        if (!isErrorOfMissingDoc(error)) throw error;
        result = { kind: "missing" };
    }
    return resolvePathIdentity(result, configuredVersion);
}

export async function readRemoteP2PPathIdentity(
    database: { bulkGet(options: { docs: { id: string }[] }): Promise<unknown> },
    configuredVersion: PathNormalizationVersion
): Promise<PathNormalizationVersion> {
    const response: unknown = await database.bulkGet({ docs: [{ id: VERSIONING_DOCID }] });
    return resolvePathIdentity(parseRemotePathIdentityDocument(response), configuredVersion);
}
