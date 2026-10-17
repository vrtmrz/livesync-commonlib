import type { PathNormalizationVersion } from "./models/setting.type.ts";

/** Resolve the stored path identity version, treating an absent legacy value as version zero. */
export function getPathNormalizationVersion(settings: { pathNormalizationVersion?: number }): PathNormalizationVersion {
    const version = settings.pathNormalizationVersion === undefined ? 0 : settings.pathNormalizationVersion;
    if (version === 0 || version === 1) return version;
    throw new Error(`Unsupported path normalisation version: ${version}`);
}

/** Normalise a logical path for document ID derivation without changing its stored path. */
export function normalisePathForIdentity(path: string, version?: number): string {
    const resolvedVersion = getPathNormalizationVersion({ pathNormalizationVersion: version });
    return resolvedVersion === 1 ? path.normalize("NFC") : path;
}
