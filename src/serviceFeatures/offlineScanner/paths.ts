import type { FilePathWithPrefix, FilePathWithPrefixLC, MetaEntry, ObsidianLiveSyncSettings } from "@lib/common/types";
import type { IPathService } from "@lib/services/base/IService";
import { getPathNormalizationVersion, normalisePathForIdentity } from "@lib/common/pathNormalization";

/**
 * Resolve Metadata through the host's path policy.
 * @param host - Borrowed path-resolution capability.
 * @param doc - Metadata whose logical path is required.
 * @returns The host-resolved path, without comparison-key case folding.
 */
export function getPathFromEntry(
    host: { services: { path: Pick<IPathService, "getPath"> } },
    doc: MetaEntry
): FilePathWithPrefix {
    const path = host.services.path.getPath(doc);
    return path;
}

/**
 * Form a comparison key without changing the actual storage path.
 * @param settings - Active path-normalisation and filename-case settings.
 * @param path - Logical path to compare.
 * @returns The normalised, optionally case-folded comparison identity.
 */
export function convertCase<T extends FilePathWithPrefix>(
    settings: ObsidianLiveSyncSettings,
    path: T
): FilePathWithPrefixLC {
    const normalisedPath = normalisePathForIdentity(path, getPathNormalizationVersion(settings));
    if (settings.handleFilenameCaseSensitive) {
        return normalisedPath as FilePathWithPrefixLC;
    }
    return normalisedPath.toLowerCase() as FilePathWithPrefixLC;
}
