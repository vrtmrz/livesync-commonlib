import { E2EEAlgorithms, VERSIONING_DOCID } from "@lib/common/types";
import { configuredIdKey } from "@lib/common/idDerivation.ts";

export const REMOTE_FEATURE_GENERATION = 13;
export const ENCRYPTED_INTERNAL_METADATA_FEATURE = "encrypted-internal-metadata-v1";
export const INDEPENDENT_ID_DERIVATION_FEATURE = "independent-id-derivation-v1";

export const supportedFeatures = new Set([ENCRYPTED_INTERNAL_METADATA_FEATURE, INDEPENDENT_ID_DERIVATION_FEATURE]);

export function requiredRemoteFeatures(setting: {
    encrypt?: boolean;
    usePathObfuscation?: boolean;
    E2EEAlgorithm?: string;
    encryptInternalMetadata?: boolean;
    idDerivationVersion: 0 | 1;
    idDerivationKey: string;
}): string[] {
    const features: string[] = [];
    if (usesEncryptedInternalMetadata(setting)) features.push(ENCRYPTED_INTERNAL_METADATA_FEATURE);
    if (setting.encrypt && configuredIdKey(setting)) features.push(INDEPENDENT_ID_DERIVATION_FEATURE);
    return features;
}

export function usesEncryptedInternalMetadata(setting: {
    encrypt?: boolean;
    usePathObfuscation?: boolean;
    E2EEAlgorithm?: string;
    encryptInternalMetadata?: boolean;
}): boolean {
    return (
        setting.encryptInternalMetadata === true &&
        setting.encrypt === true &&
        setting.usePathObfuscation === true &&
        setting.E2EEAlgorithm === E2EEAlgorithms.V2
    );
}

export type RemoteFeatureAssessment =
    | { status: "supported"; usedFeatures: readonly string[] }
    | { status: "older-generation"; version: number }
    | { status: "unsupported-generation"; version: number }
    | { status: "unknown-features"; identifiers: readonly string[] }
    | { status: "invalid-control" };

export function assessRemoteFeatureDocument(document: unknown): RemoteFeatureAssessment {
    if (typeof document !== "object" || document === null) return { status: "invalid-control" };
    const value = document as Record<string, unknown>;
    if (value._id !== VERSIONING_DOCID || value.type !== "versioninfo" || value._deleted === true) {
        return { status: "invalid-control" };
    }
    if (typeof value.version !== "number" || !Number.isSafeInteger(value.version) || value.version < 0) {
        return { status: "invalid-control" };
    }
    const version = value.version;
    if (version < 12) {
        return "used_features" in value ? { status: "invalid-control" } : { status: "older-generation", version };
    }
    if (version > REMOTE_FEATURE_GENERATION) return { status: "unsupported-generation", version };
    if (version === 12) {
        return "used_features" in value ? { status: "invalid-control" } : { status: "supported", usedFeatures: [] };
    }
    if (
        !Array.isArray(value.used_features) ||
        !value.used_features.every((name: unknown) => typeof name === "string" && name.length > 0)
    ) {
        return { status: "invalid-control" };
    }
    const usedFeatures = [...new Set(value.used_features as string[])];
    const identifiers = usedFeatures.filter((name) => !supportedFeatures.has(name));
    return identifiers.length > 0 ? { status: "unknown-features", identifiers } : { status: "supported", usedFeatures };
}

export function describeRemoteFeatureRejection(assessment: RemoteFeatureAssessment): string {
    switch (assessment.status) {
        case "unknown-features":
            return `Unknown features are in use: ${assessment.identifiers.join(", ")}`;
        case "unsupported-generation":
            return `Unsupported remote database generation: ${assessment.version}`;
        case "invalid-control":
            return "The remote database version document is invalid.";
        case "older-generation":
            return `The remote database requires migration from generation ${assessment.version}.`;
        case "supported":
            return "";
    }
}
