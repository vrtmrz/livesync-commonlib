/** Host-neutral path identity, namespace, and storage resolution contracts. */
export type {
    FilePath,
    DocumentPath,
    StoragePath,
    PathComparisonKey,
    PathComparisonSettings,
    DocumentPathParts,
    DirectoryEntry,
    ReadDirectory,
    ResolvedRename,
    StorageEntry,
    StoragePathResolver,
    StoragePathResolverOptions,
} from "./platform/pathTypes.ts";
export {
    parseFilePath,
    parseDocumentPath,
    splitDocumentPath,
    joinDocumentPath,
    getStoragePathComparisonKey,
    getDocumentPathComparisonKey,
} from "./platform/pathComparison.ts";
export { createStoragePathResolver, AmbiguousNormalisedPathError } from "./platform/storagePathResolution.ts";
