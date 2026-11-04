import type { TaggedType } from "octagonal-wheels/common/types";
import type { FilePath, FilePathWithPrefix, FilePathWithPrefixLC } from "../common/models/db.type.ts";
import type { PathNormalizationVersion } from "../common/models/setting.type.ts";
import type { PathNamespace } from "../common/pathNamespace.ts";

/**
 * An original file path without a Metadata namespace.
 *
 * @remarks
 * This compatibility type does not establish NFC form, physical spelling, or
 * existence. Validate raw storage input with `parseFilePath`.
 */
export type { FilePath };

/**
 * An original document path with an optional recognised Metadata namespace.
 *
 * @remarks
 * Excludes the legacy comparison-key variant. Route the namespace before
 * validating the remaining file path for storage access.
 */
export type DocumentPath = Exclude<FilePathWithPrefix, FilePathWithPrefixLC>;

declare const unicodeForm: unique symbol;
declare const storagePath: unique symbol;

/**
 * A file path in Unicode NFC form, without case conversion.
 *
 * @remarks
 * NFC form alone does not establish physical storage spelling or existence.
 * This refinement is used within normalisation helpers and is not re-exported
 * by the focused storage entry point.
 */
export type NfcFilePath = FilePath & { readonly [unicodeForm]: "NFC" };

/**
 * A root-relative storage target whose existing components use resolved spelling.
 *
 * @remarks
 * Produced by resolution or supported physical enumeration. A write target may
 * contain missing components; this type does not guarantee existence, entry
 * kind, or protection against concurrent changes. The empty path denotes the
 * root, subject to each operation's root rules.
 */
export type StoragePath = FilePath & { readonly [storagePath]: true };

/**
 * A path identity key produced by the configured Unicode and case comparison.
 *
 * @typeParam Domain - `storage` compares within one storage root; `document`
 * retains the Metadata namespace so different document kinds remain distinct.
 *
 * @remarks
 * Retain the original path separately. A comparison key cannot establish an
 * original filename and must not be passed to storage or namespace operations.
 */
export type PathComparisonKey<Domain extends "storage" | "document"> = TaggedType<
    string,
    `PathComparisonKey:${Domain}`
>;

/** Unicode and case settings used to derive path comparison keys. */
export type PathComparisonSettings = Readonly<{
    /** `0` retains Legacy Unicode handling; `1` compares Unicode NFC forms. */
    pathNormalizationVersion: PathNormalizationVersion;
    /** Preserve letter case when true; otherwise apply the existing `toLowerCase()` rule. */
    handleFilenameCaseSensitive: boolean;
}>;

/** The namespace and original file path obtained by splitting one document path. */
export type DocumentPathParts = Readonly<{
    /** One recognised Metadata namespace, or the empty string for an ordinary file. */
    prefix: PathNamespace;
    /** Original spelling after removing that one namespace. */
    path: FilePath;
}>;

/** One immediate physical child returned by a strict directory reader. */
export type DirectoryEntry = Readonly<{
    /** Unmodified child name, rather than a relative path containing multiple components. */
    name: string;
    /** Entry kind reported by the storage host. */
    kind: "file" | "directory";
}>;

/** A physical child path and its kind, ready for a storage scan to consume. */
export type StorageEntry = Readonly<{
    /** Root-relative path retaining the directory listing's actual spelling. */
    path: StoragePath;
    /** Entry kind from the same directory listing. */
    kind: DirectoryEntry["kind"];
}>;

/**
 * Read a directory's complete immediate children using actual names and kinds.
 *
 * @param physicalDirectory - Resolved directory path relative to the host's root.
 * @returns The children, including an empty array for an empty directory, or
 * `null` only when the directory is absent.
 * @throws Propagates permission, non-directory, and other I/O failures instead
 * of reporting absence or a successful partial listing.
 */
export type ReadDirectory = (physicalDirectory: StoragePath) => Promise<readonly DirectoryEntry[] | null>;

/** Resolved paths for a rename which the storage host has yet to perform. */
export type ResolvedRename = Readonly<{
    /** Existing source spelling. */
    source: StoragePath;
    /** Resolved target, retaining a requested leaf spelling change where applicable. */
    target: StoragePath;
}>;

/**
 * Resolve NFC-equivalent names through strict directory reads under one policy.
 *
 * @remarks
 * Operations reject ambiguous candidates even when an exact spelling exists,
 * propagate reader failures, and perform no filesystem mutation. Resolution
 * does not reserve a path against concurrent changes; hosts own that lifecycle.
 */
export interface StoragePathResolver {
    /**
     * Resolve an existing file or directory using its physical spelling.
     *
     * @param path - Original path relative to the selected storage root.
     * @returns The resolved path, or `null` when a component is absent.
     */
    resolveExisting(path: FilePath): Promise<StoragePath | null>;

    /**
     * Resolve a write target while preserving any missing suffix as requested.
     *
     * @param path - Original target path relative to the selected storage root.
     * @returns The resolved target; this operation creates no missing entries.
     */
    resolveForWrite(path: FilePath): Promise<StoragePath>;

    /**
     * Resolve both sides of an explicit rename, including a leaf spelling change.
     *
     * @param source - Original source entry path; the root is not an entry.
     * @param target - Requested target entry path; the root is not an entry.
     * @returns Both paths, or `null` when the source is absent. The host retains
     * responsibility for performing the rename and handling replacement.
     */
    resolveRename(source: FilePath, target: FilePath): Promise<ResolvedRename | null>;

    /**
     * Enumerate an already resolved directory without resolving each child again.
     *
     * @param path - Physical directory path relative to the selected root.
     * @returns Child paths and kinds, or `null` when the directory is absent.
     * @throws Rejects equivalent child names as ambiguous before returning a listing.
     */
    listResolvedDirectory(path: StoragePath): Promise<readonly StorageEntry[] | null>;
}

/** Dependencies and comparison policy for constructing an NFC path resolver. */
export type StoragePathResolverOptions = Readonly<{
    /** Strict host enumeration; it must distinguish absence from I/O failure. */
    readDirectory: ReadDirectory;
    /** Policy copied at construction; construct a new resolver when settings change. */
    policy: Readonly<{
        /** The shared resolver accepts NFC mode only; Legacy hosts retain their existing paths. */
        pathNormalizationVersion: 1;
        /** Preserve letter case when true; otherwise compare using `toLowerCase()`. */
        handleFilenameCaseSensitive: boolean;
    }>;
}>;
