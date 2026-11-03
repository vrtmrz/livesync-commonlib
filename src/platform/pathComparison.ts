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

/** Validate a root-relative path at an original-input boundary without changing its spelling. */
export function parseFilePath(path: string): FilePath {
    return validateStoragePath(path) as FilePath;
}

/** Mark an original document path; storage validation follows namespace routing. */
export function parseDocumentPath(path: string): DocumentPath {
    if (typeof path !== "string") throw new TypeError("A document path must be a string");
    return path as DocumentPath;
}

export function splitDocumentPath(path: DocumentPath): DocumentPathParts {
    const [prefix, body] = splitPathNamespace(path);
    return { prefix, path: body as FilePath };
}

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

export function getStoragePathComparisonKey(
    path: FilePath,
    settings: PathComparisonSettings
): PathComparisonKey<"storage"> {
    return comparisonPath(path, settings) as PathComparisonKey<"storage">;
}

export function getDocumentPathComparisonKey(
    path: DocumentPath,
    settings: PathComparisonSettings
): PathComparisonKey<"document"> {
    const { prefix, path: body } = splitDocumentPath(path);
    return (prefix + comparisonPath(body, settings)) as PathComparisonKey<"document">;
}
