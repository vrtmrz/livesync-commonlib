import type { TaggedType } from "octagonal-wheels/common/types";
import type { FilePath, FilePathWithPrefix, FilePathWithPrefixLC } from "../common/models/db.type.ts";
import type { PathNormalizationVersion } from "../common/models/setting.type.ts";
import type { PathNamespace } from "../common/pathNamespace.ts";

export type { FilePath };
export type DocumentPath = Exclude<FilePathWithPrefix, FilePathWithPrefixLC>;

declare const unicodeForm: unique symbol;
declare const storagePath: unique symbol;

/** NFC form alone does not establish a physical storage spelling. */
export type NfcFilePath = FilePath & { readonly [unicodeForm]: "NFC" };

/** A resolved storage target; missing components and subsequent changes remain possible. */
export type StoragePath = FilePath & { readonly [storagePath]: true };

export type PathComparisonKey<Domain extends "storage" | "document"> = TaggedType<
    string,
    `PathComparisonKey:${Domain}`
>;

export type PathComparisonSettings = Readonly<{
    pathNormalizationVersion: PathNormalizationVersion;
    handleFilenameCaseSensitive: boolean;
}>;

export type DocumentPathParts = Readonly<{ prefix: PathNamespace; path: FilePath }>;
export type DirectoryEntry = Readonly<{ name: string; kind: "file" | "directory" }>;
export type StorageEntry = Readonly<{ path: StoragePath; kind: DirectoryEntry["kind"] }>;
export type ReadDirectory = (physicalDirectory: StoragePath) => Promise<readonly DirectoryEntry[] | null>;
export type ResolvedRename = Readonly<{ source: StoragePath; target: StoragePath }>;

export interface StoragePathResolver {
    resolveExisting(path: FilePath): Promise<StoragePath | null>;
    resolveForWrite(path: FilePath): Promise<StoragePath>;
    resolveRename(source: FilePath, target: FilePath): Promise<ResolvedRename | null>;
    listResolvedDirectory(path: StoragePath): Promise<readonly StorageEntry[] | null>;
}

export type StoragePathResolverOptions = Readonly<{
    readDirectory: ReadDirectory;
    policy: Readonly<{
        pathNormalizationVersion: 1;
        handleFilenameCaseSensitive: boolean;
    }>;
}>;
