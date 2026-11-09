import {
    createStoragePathResolver,
    parseFilePath,
    parseDocumentPath,
    splitDocumentPath,
    joinDocumentPath,
    getStoragePathComparisonKey,
    getDocumentPathComparisonKey,
    type FilePath,
    type DocumentPath,
    type StoragePath,
    type PathComparisonKey,
} from "@vrtmrz/livesync-commonlib/storage";
import { NodeStorageAdapter, UnicodeResolvingNodeStorageAdapter } from "@vrtmrz/livesync-commonlib/node";
import {
    FileSystemAccessStorageAdapter,
    UnicodeResolvingFileSystemAccessStorageAdapter,
} from "@vrtmrz/livesync-commonlib/browser";
import type { FilePathWithPrefix, FilePathWithPrefixLC } from "@vrtmrz/livesync-commonlib/compat/common/types";

const policy = { pathNormalizationVersion: 1, handleFilenameCaseSensitive: false } as const;
const logical = parseFilePath("Café/note.md");
const documentPath = parseDocumentPath("i:Café/note.md");
const parts = splitDocumentPath(documentPath);
const roundTrip: DocumentPath = joinDocumentPath(parts);
const key = getStoragePathComparisonKey(logical, policy);
const documentKey = getDocumentPathComparisonKey(documentPath, policy);
const resolver = createStoragePathResolver({ policy, readDirectory: async () => [] });
const target: StoragePath = await resolver.resolveForWrite(logical);
const original: FilePath = target;
const nodes = new NodeStorageAdapter(".");
await nodes.writeResolved(target, "content");
const resolvedNode: StoragePath | null = await new UnicodeResolvingNodeStorageAdapter(".", () => 1).resolveLogicalPath(
    logical
);
declare const rootHandle: FileSystemDirectoryHandle;
const browser = new FileSystemAccessStorageAdapter(rootHandle);
await browser.writeResolved(target, "content");
const resolvedBrowser: StoragePath | null = await new UnicodeResolvingFileSystemAccessStorageAdapter(
    rootHandle,
    () => 1
).resolveLogicalPath(logical);
declare const legacyKey: FilePathWithPrefixLC;
const legacyUnion: FilePathWithPrefix = legacyKey;
void [roundTrip, original, documentKey, resolvedNode, resolvedBrowser, legacyUnion];

// @ts-expect-error Raw strings have not crossed the path input boundary.
await resolver.resolveExisting("note.md");
// @ts-expect-error A document namespace must be routed before storage resolution.
await resolver.resolveExisting(documentPath);
// @ts-expect-error Comparison keys cannot recover original spelling.
await resolver.resolveForWrite(key);
// @ts-expect-error Document keys cannot become filesystem paths.
await resolver.resolveExisting(documentKey);
// @ts-expect-error Legacy comparison keys are not original document paths.
const sourceDocument: DocumentPath = legacyKey;
// @ts-expect-error Namespace splitting cannot erase a comparison-key tag.
splitDocumentPath(legacyKey);
// @ts-expect-error New comparison keys cannot enter namespace helpers.
splitDocumentPath(documentKey);
// @ts-expect-error Storage and document comparison domains remain separate.
const wrongDomain: PathComparisonKey<"storage"> = documentKey;
// @ts-expect-error Resolution must precede physical Node I/O.
await nodes.writeResolved(logical, "content");
// @ts-expect-error Resolution must precede physical browser I/O.
await browser.readResolved(logical);
// @ts-expect-error Physical enumeration requires a resolved parent.
await resolver.listResolvedDirectory(logical);
void [sourceDocument, wrongDomain];

import type { DirectFileManipulator } from "@vrtmrz/livesync-commonlib";
type DirectPathVersion = ConstructorParameters<typeof DirectFileManipulator>[0]["pathNormalizationVersion"];
const legacyDirectPathVersion: DirectPathVersion = undefined;
const nfcDirectPathVersion: DirectPathVersion = 1;
// @ts-expect-error Only supported identity versions are accepted by direct database integrations.
const unsupportedDirectPathVersion: DirectPathVersion = 2;
void [legacyDirectPathVersion, nfcDirectPathVersion, unsupportedDirectPathVersion];

import type { UXInternalFileInfoStub } from "@vrtmrz/livesync-commonlib/compat/common/types";
import {
    getPathFromUXFileInfo,
    getStoragePathFromUXFileInfo,
    getDatabasePathFromUXFileInfo,
} from "@vrtmrz/livesync-commonlib/compat/common/typeUtils";

// Internal file identities have no storage statistics, including under strict null checks.
declare const internalFile: UXInternalFileInfoStub;
const internalSource: FilePathWithPrefix = getPathFromUXFileInfo(internalFile);
const internalStorage: FilePathWithPrefix = getStoragePathFromUXFileInfo(internalFile);
const internalDatabase: FilePathWithPrefix = getDatabasePathFromUXFileInfo(internalFile);
void [internalSource, internalStorage, internalDatabase];
