---
date: 2026-11-03
commonlib-version: "0.3.0"
self-hosted-livesync-version: "1.0.44"
status: accepted-unreleased
---

# Shared storage path resolution

This design moves the CLI's existing Unicode-aware path resolution into
Commonlib so Node, File System Access, and Bridge can apply the same naming
rules. The shared resolver, path types, and Node and File System Access
integrations are implemented as unreleased additions. Installing the package
does not enable NFC in an existing host or migrate its database.

Accepted on 2026-11-03. The [decision record](../adr/2026_11_shared_storage_path_resolution.md)
records the ownership and compatibility choices. The [platform guide](../platform-storage.md#unicode-path-resolution)
provides consumer examples.

The baseline is Commonlib 0.3.0 and the CLI implementation reviewed in
[Self-hosted LiveSync #1309](https://github.com/vrtmrz/obsidian-livesync/pull/1309)
at `2716d68b3d21d493cdfdefa0857fad4c6a3c522a`. The existing
[Unicode identity contract](../unicode-path-identity.md) continues to govern
Metadata IDs, remote admission, defaults, and database migration.

## Ownership

Commonlib owns path comparison, component-by-component resolution, ambiguity
checks, and thin platform-storage integrations. Hosts own root selection,
permissions, filesystem handles, file objects, watchers, caches, and operation
lifecycle. A resolver performs directory reads but no filesystem mutation.

Keep the existing Node and File System Access storage APIs and their Legacy
behaviour. Compose the resolver only for NFC mode. Its comparison policy is
an immutable snapshot for one operation or scan, copied at construction;
a settings change requires a new composition. Explicit case-sensitive and
case-insensitive lookups use
the corresponding snapshot, without mutating a shared resolver.

## Path types

Separate namespace, Unicode form, comparison use, and storage resolution.
An actual filename can already be NFC, so these are not mutually exclusive
string categories.

| Type | Meaning | Producer |
| --- | --- | --- |
| `FilePath` | Original spelling without a Metadata namespace; no NFC or resolution guarantee. | Existing input and host boundaries. |
| `DocumentPath` | Original spelling with an optional recognised Metadata namespace; excludes comparison keys. | Document input and namespace helpers. |
| `NfcFilePath` | A `FilePath` normalised to NFC, without lower-casing. | The shared NFC normalisation function. |
| `StoragePath` | A root-relative storage target whose existing components use their resolved spelling. | Resolver or supported physical enumeration. |
| `PathComparisonKey<"storage">` | A comparison key for a path within one storage root. | The shared comparison helper. |
| `PathComparisonKey<"document">` | A comparison key which retains the document namespace. | The shared comparison helper. |

`StoragePath` is not proof that an entry exists, still exists, is a file,
or cannot change concurrently. A write target may contain missing components.
The root is the empty path; each operation retains its existing root rules.

Reuse the existing `FilePath` and OW `TaggedType` definitions. Add independent
symbols for refinements: nesting `TaggedType<FilePath, "StoragePath">` would
intersect incompatible values of OW's existing tag property.

```ts
declare const unicodeForm: unique symbol;
declare const storagePath: unique symbol;

type DocumentPath = Exclude<FilePathWithPrefix, FilePathWithPrefixLC>;

type NfcFilePath = FilePath & {
    readonly [unicodeForm]: "NFC";
};

type StoragePath = FilePath & {
    readonly [storagePath]: true;
};

type PathComparisonKey<Domain extends "storage" | "document"> =
    TaggedType<string, `PathComparisonKey:${Domain}`>;
```

Use `NfcFilePath` within the normalisation boundary initially. Publish the
path and key types needed by consumers of the new focused API. Preserve the
existing definitions of `FilePathWithPrefix` and `FilePathWithPrefixLC` at
compatibility entry points. Do not alias either old type to a new key type:
that would change existing assignability.

The old `FilePathWithPrefix` union includes both `FilePath` and
`FilePathWithPrefixLC`. The new `DocumentPath` intentionally removes the latter.
The old scanner's `convertCase()` returns its `LC` type even when case-sensitive
handling retains letter case. New code therefore names its output by its
comparison purpose, not an assumed lower-case form.

Brand values at the boundary which establishes their meaning. `parseFilePath`
validates raw storage input using the existing path vocabulary without changing
its spelling. `parseDocumentPath` accepts original document-path strings;
namespace routing precedes storage validation. Neither input helper recovers
original spelling from a comparison key. NFC conversion and resolution establish their own refinements.
Keep casts inside those owning implementations; consumer code receives the
typed result. The existing string-taking APIs remain compatibility escape
routes, so this migration does not claim to make all old call sites type-safe.
Within the new integrations, physical-I/O ports accept `StoragePath`; NFC
normalisation or key generation alone cannot supply that argument.

## Namespaces and comparison

Namespace helpers accept `DocumentPath`, return a separate namespace and
`FilePath`, and recognise the existing `i:`, `ix:`, and `ps:` rules. Split one
namespace only; further colons belong to the body. The caller handles the
namespace's meaning before submitting a filesystem path to the resolver.
Chunk prefixes and obfuscated IDs remain `DocumentID` concerns.

Document comparison preserves the namespace; storage comparison does not
receive one. A normal document and an internal document with the same body
remain distinct document identities. Neither comparison-key domain is accepted
by the resolver or by the new namespace helpers.

The comparison policy uses the existing `normalisePathForIdentity` operation,
then the existing `toLowerCase()` rule only when configured. NFC conversion
alone produces `NfcFilePath`; the complete comparison pipeline produces a key.
It does not infer the host filesystem's case rules or introduce a new Unicode
case-folding rule. Preserve original paths alongside keys; a key is never
converted back into an original path.

```ts
type PathComparisonSettings = Readonly<{
    pathNormalizationVersion: 0 | 1;
    handleFilenameCaseSensitive: boolean;
}>;

type DocumentPathParts = Readonly<{
    prefix: "" | "i:" | "ix:" | "ps:";
    path: FilePath;
}>;

declare function splitDocumentPath(path: DocumentPath): DocumentPathParts;
declare function joinDocumentPath(parts: DocumentPathParts): DocumentPath;

declare function getStoragePathComparisonKey(
    path: FilePath, settings: PathComparisonSettings
): PathComparisonKey<"storage">;

declare function getDocumentPathComparisonKey(
    path: DocumentPath, settings: PathComparisonSettings
): PathComparisonKey<"document">;
```

Namespace routing and cryptographic document-ID derivation remain outside the
resolver. The new comparison helpers must retain the existing key bytes for
each supported policy; extracting them does not rewrite IDs or stored paths.

## Directory and resolver contract

The only injected I/O operation enumerates immediate children using their
actual names and kinds. Paths are relative to the selected root and use `/`.
`null` means the directory is absent. Permission failures, a non-directory
parent, and other I/O failures reject; they are not empty listings.

The existing storage `list()` methods can hide some failures as empty results.
Provide a strict enumeration path for the resolver while preserving the old
methods' published behaviour. Reuse each platform's containment and symbolic-link
checks. Keep native handles and platform stat types behind this boundary.

```ts
type DirectoryEntry = Readonly<{
    name: string;
    kind: "file" | "directory";
}>;

type ReadDirectory = (
    physicalDirectory: StoragePath
) => Promise<readonly DirectoryEntry[] | null>;

type StorageEntry = Readonly<{
    path: StoragePath;
    kind: "file" | "directory";
}>;

type ResolvedRename = Readonly<{
    source: StoragePath;
    target: StoragePath;
}>;

interface StoragePathResolver {
    resolveExisting(path: FilePath): Promise<StoragePath | null>;
    resolveForWrite(path: FilePath): Promise<StoragePath>;
    resolveRename(source: FilePath, target: FilePath): Promise<ResolvedRename | null>;
    listResolvedDirectory(path: StoragePath): Promise<readonly StorageEntry[] | null>;
}

declare function createStoragePathResolver(options: Readonly<{
    readDirectory: ReadDirectory;
    policy: Readonly<{
        pathNormalizationVersion: 1;
        handleFilenameCaseSensitive: boolean;
    }>;
}>): StoragePathResolver;
```

`DirectoryEntry.name` is an immediate child name, never a path. Reject malformed
entries at the enumeration boundary. Add a separate filename brand only when a
consumer boundary needs it; do not publish a family of filename variants now.

The resolver uses complete sibling enumeration before deciding uniqueness;
a literal match does not override a second equivalent name. File/directory
collisions count as ambiguity. A unique file cannot be traversed as a parent.
An individual lookup checks candidates for each requested component; a full
scan checks every sibling group before returning that directory's entries.

| Operation | Result |
| --- | --- |
| `resolveExisting` | Resolve each existing component to its listed spelling; return `null` on absence. |
| `resolveForWrite` | Preserve listed names for existing components and the requested spelling for the missing suffix. |
| `resolveRename` | Resolve both ends. If the target resolves to the source, retain the resolved parent and the explicitly requested leaf spelling. Return `null` when the source is absent. |
| `listResolvedDirectory` | Read an already resolved directory, check all sibling identities, and return actual child paths for scanning and direct access. |

All operations reject ambiguity using the shared `AmbiguousNormalisedPathError`.
Include the requested path and conflicting actual names for diagnosis. Preserve
I/O failures separately from absence. Host catch blocks must propagate these
failures instead of converting them to a missing file or a successful partial
scan.

Normal writes preserve existing Unicode spelling. Explicit renames may change
it. Existing-destination replacement policy and the actual rename, write,
rollback, or deletion remain the storage owner's responsibility. Resolution is
not an atomic reservation; existing host operation ordering and platform
protections remain necessary. The guarantee is limited to names exposed by the
host's supported listing.

## Composition and adoption

The `/storage` entry contains the host-neutral types, comparison and
namespace helpers, and resolver. It imports no Node, DOM, database, or Service
Hub runtime. `/node` and `/browser` expose their platform integrations through
the existing bundling boundaries.

Commonlib owns `UnicodeResolvingNodeStorageAdapter` and delegates
its resolution to the common implementation. Retain its Legacy delegation and
thin compatibility methods while the CLI adopts the focused API. File System
Access uses the same resolver, including the host paths which operate directly
on handles. Bridge supplies a Deno directory reader and uses the same contract
at its storage boundary.

Keep the resolver free of persistent mappings, cross-operation caches, watchers,
retry owners, and disposal requirements. A full scan descends through the
resolved entries and reads each directory once. A later lookup re-reads the
relevant directories, including after a file-object cache hit. OW Scope or
context can own host operation resources where needed; the resolver itself
requires no resource scope.

Hosts retain original physical paths alongside any comparison keys. Detect
aliases before collapsing them into a keyed collection. Cache invalidation,
queue ownership, and watch-event reconciliation must follow the same comparison
policy without losing distinct names. A deletion event may name an entry which
is already absent; preserve that event path rather than trying to recover its
spelling from a live directory lookup. Check rename events as an ordered change
of state, including hosts which report them as deletion and creation.

Adoption proceeds through the Node extraction and shared contract, then WebApp
and Bridge integration. Bridge also needs explicit NFC settings and direct-API
admission support. Preserve current remote mismatch rejection and the Legacy
operating guidance until each host's integration is verified. This design
does not add automatic migration or translation between identity modes.

## Verification

Check the public declarations against the actual published path types and OW
tag implementation. Positive cases cover source paths, namespace round trips,
and independent NFC/storage refinements. Negative cases cover raw strings,
prefix-bearing paths at the resolver, comparison keys at resolution and namespace
boundaries, and mixing the two key domains. Retain an assertion that the legacy
`LC` type is still assignable to the legacy union, but not to `DocumentPath`.

Implementation must preserve the existing CLI behavioural cases and apply one
resolver contract to Node and File System Access, with Bridge-specific checks:

- NFD files and mixed-spelling parents remain addressable without implicit renames.
- New components retain the requested spelling under the actual parent.
- File, directory, and case collisions reject before mutation, including exact-match requests.
- Permission and listing failures do not become absence, creation, deletion, or partial-scan success.
- Explicit spelling renames preserve contents and the host's replacement and recovery semantics.
- External additions, deletions, renames, and collisions are observed after earlier cache hits.
- Full scans inspect each directory once; Legacy behaviour and namespace separation remain unchanged.
- Watcher deletion/creation sequences, restart state, and cache keys preserve the intended identity.

Packed-package checks must verify the focused entry and platform bundling
boundaries. Real browser and Deno checks establish their host behaviour;
Commonlib's memory and Node tests alone do not establish those guarantees.
