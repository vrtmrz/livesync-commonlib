import { normalisePathForIdentity } from "../common/pathNormalization.ts";
import { splitPathNamespace } from "../common/pathNamespace.ts";
import { validateStoragePath } from "./storagePath.ts";
import type {
    DocumentPath,
    DocumentPathParts,
    FilePath,
    NfcFilePath,
    PathComparisonKey,
    PathComparisonSettings,
} from "./pathTypes.ts";

/**
 * Validate raw storage input without changing its spelling.
 *
 * @param path - A slash-separated path relative to the host-selected root.
 * @returns The original path branded as `FilePath`; the empty path denotes the root.
 * @throws Rejects absolute, drive-qualified, backslash, and traversal-segment input.
 * @remarks Does not normalise Unicode, resolve physical names, or check existence.
 */
export function parseFilePath(path: string): FilePath {
    return validateStoragePath(path) as FilePath;
}

/**
 * Mark an original document path before routing its Metadata namespace.
 *
 * @param path - Original document-path text, optionally including one namespace.
 * @returns The same text branded as `DocumentPath`.
 * @throws Rejects a non-string value.
 * @remarks Storage validation follows namespace routing. This function does not
 * recover original spelling from a comparison key or validate a physical path.
 */
export function parseDocumentPath(path: string): DocumentPath {
    if (typeof path !== "string") throw new TypeError("A document path must be a string");
    return path as DocumentPath;
}

/**
 * Split one recognised Metadata namespace from an original document path.
 *
 * @param path - Original document path; a further colon remains in the file path.
 * @returns The namespace, or an empty prefix, and the original remaining spelling.
 * @remarks Does not validate the resulting file path for storage access.
 */
export function splitDocumentPath(path: DocumentPath): DocumentPathParts {
    const [prefix, body] = splitPathNamespace(path);
    return { prefix, path: body as FilePath };
}

/**
 * Join a routed namespace and its original file path without normalising either.
 *
 * @param parts - One recognised namespace and an original file path.
 * @returns Their concatenation as an original document path.
 */
export function joinDocumentPath({ prefix, path }: DocumentPathParts): DocumentPath {
    return (prefix + path) as DocumentPath;
}

function normaliseFilePath(path: FilePath): NfcFilePath {
    return normalisePathForIdentity(path, 1) as NfcFilePath;
}

function comparisonPath(path: FilePath, settings: PathComparisonSettings): string {
    const normalised =
        settings.pathNormalizationVersion === 1
            ? normaliseFilePath(path)
            : normalisePathForIdentity(path, settings.pathNormalizationVersion);
    return settings.handleFilenameCaseSensitive ? normalised : normalised.toLowerCase();
}

/**
 * Derive an identity key for a file path within one storage root.
 *
 * @param path - Original file path without a Metadata namespace.
 * @param settings - Explicit Unicode and case comparison settings.
 * @returns A storage-domain comparison key; retain the original path for I/O.
 * @throws Rejects an unsupported path normalisation version.
 */
export function getStoragePathComparisonKey(
    path: FilePath,
    settings: PathComparisonSettings
): PathComparisonKey<"storage"> {
    return comparisonPath(path, settings) as PathComparisonKey<"storage">;
}

/**
 * Derive a document identity key while preserving its Metadata namespace.
 *
 * @param path - Original document path, optionally including one namespace.
 * @param settings - Explicit Unicode and case comparison settings for the body.
 * @returns A document-domain key which distinguishes namespaces with equal bodies.
 * @throws Rejects an unsupported path normalisation version.
 */
export function getDocumentPathComparisonKey(
    path: DocumentPath,
    settings: PathComparisonSettings
): PathComparisonKey<"document"> {
    const { prefix, path: body } = splitDocumentPath(path);
    return (prefix + comparisonPath(body, settings)) as PathComparisonKey<"document">;
}
