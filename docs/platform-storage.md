# Platform storage

Commonlib supplies paired rooted-storage implementations for Node and the browser File System Access API. Both implement the same LiveSync storage contract, but the platform entry points remain deliberately separate.

## Ownership boundary

The host owns root acquisition and lifecycle:

- a Node or CLI host decides which directory becomes `rootPath`;
- a browser host presents any directory picker, obtains permission, and supplies an authorised `FileSystemDirectoryHandle` as `rootHandle`;
- the host decides whether and how a browser handle is persisted and re-authorised; and
- the host disposes any surrounding application resources.

The storage factories only bind operations to the supplied root. They do not inspect the current process, call `showDirectoryPicker()`, request permission, or store credentials or handles.

## Browser File System Access API

```ts
import { createFileSystemAccessStorage } from '@vrtmrz/livesync-commonlib/browser';

const rootHandle = await window.showDirectoryPicker();
const storage = createFileSystemAccessStorage({ rootHandle });

await storage.mkdir('notes');
await storage.write('notes/example.md', '# Example');
const content = await storage.read('notes/example.md');
```

Calling `showDirectoryPicker()` is only an example of host composition. Availability, secure-context requirements, user activation, permission prompts, handle persistence, and re-authorisation are browser concerns and are outside the adapter contract.

## Node

```ts
import { createNodeStorage } from '@vrtmrz/livesync-commonlib/node';

const storage = createNodeStorage({ rootPath: '/srv/livesync' });
await storage.write('notes/example.md', '# Example');
```

`rootPath` may be absolute or process-relative. The host should normally resolve and validate configuration before constructing the adapter.

Node storage reports creation time from a positive `birthtimeMs`, falling back to `ctimeMs` when birth time is unavailable. Timestamps are rounded down to integer milliseconds. Hosts converting native Node stats can use `getNodeFileCreationTime` from the `/node` entry for the same conversion. Some platforms already return change time as birth time, so this fallback cannot guarantee a stable creation time there. Replacing a file can also change its birth time. Write options preserve modification time; the Node adapter does not restore creation time from `ctime`.

The Node adapter rejects symbolic-link components which it observes in an adapter path before an operation. File opens also use `O_NOFOLLOW` for the final component where the platform exposes that flag. These checks protect against invalid paths and symbolic links which already exist when an operation begins. Its concrete `rename(sourcePath, targetPath)` operation validates both paths before providing the atomic rename expected by Node hosts.

The host-selected `rootPath` is a trust boundary, not an operating-system filesystem sandbox. The adapter assumes that an untrusted local process cannot replace that root or its descendants concurrently with an operation. A host which grants another local actor write access to the tree must not rely on the adapter as a privilege boundary.

## Shared path contract

Adapter paths are relative to the injected root and use forward slashes. The empty path refers to the root for root-safe operations such as `exists`, `stat`, `list`, and `mkdir`.

The adapters reject:

- absolute paths;
- Windows drive-qualified paths;
- backslash-separated paths;
- `.` and `..` traversal segments; and
- the empty path for entry operations such as `read`, `write`, `append`, and `remove`.

Writes create missing parent directories. Listing returns direct child paths relative to the configured root. Text, binary, append, metadata, listing, removal, and containment behaviour are exercised by the same contract suite against both implementations.

The File System Access API does not expose portable creation times or permit setting file times. Consumers must not rely on identical timestamp fidelity across the two adapters.

## Unicode path resolution

These APIs are published in [Commonlib 0.3.1](https://www.npmjs.com/package/@vrtmrz/livesync-commonlib/v/0.3.1).
Node and File System Access hosts can use the same NFC comparison and component
resolution while retaining the names listed by their filesystem. Hosts still
own the selected identity mode and its database migration.

```ts
import { UnicodeResolvingNodeStorageAdapter } from '@vrtmrz/livesync-commonlib/node';
import { parseFilePath } from '@vrtmrz/livesync-commonlib/storage';

const storage = new UnicodeResolvingNodeStorageAdapter(
    '/srv/livesync',
    () => settings.pathNormalizationVersion,
    () => !settings.handleFilenameCaseSensitive,
);
const existing = await storage.resolveLogicalPath(parseFilePath('Café.md'), undefined, false);
if (existing !== null) {
    const content = await storage.readResolved(existing);
}
```

The browser equivalent is `UnicodeResolvingFileSystemAccessStorageAdapter`
from `/browser`, constructed with an authorised root handle and the same
settings callbacks. Version `0` delegates to the existing storage behaviour;
version `1` resolves every component against complete sibling listings. Normal
writes preserve existing spelling. Node's explicit `rename` can change a leaf's
Unicode or letter-case spelling; the browser adapter retains its existing
operation set and does not add a rename primitive.

`AmbiguousNormalisedPathError` from `/storage` reports multiple equivalent
names, even when one is a literal match. Preserve that error and directory or
permission failures. Only absence produces `null`; a failure must not be used
as permission to create a file or as a successful partial scan.

For another host, compose `createStoragePathResolver({ readDirectory, policy })`
from `/storage`. `readDirectory` accepts a `StoragePath` and returns immediate
child names and kinds, or `null` for absence. Propagate other failures. The
resolver copies one NFC policy and retains no directory cache. For a full scan,
start at `resolveForWrite(parseFilePath(''))`, then recurse through
`listResolvedDirectory` entries using the same resolver. Each directory is read
once. Re-resolve later operations so external changes are visible.

`FilePath` retains original, unprefixed spelling. `StoragePath` records that
existing components have been resolved; it does not guarantee existence or
reserve a target. `parseDocumentPath` marks an original document-path input,
and `splitDocumentPath` separates one recognised namespace before host routing.
Use `joinDocumentPath` to restore it. `getStoragePathComparisonKey` and
`getDocumentPathComparisonKey` return distinct comparison-only types; the latter
preserves the namespace. Keep the original path beside each key. The old
`FilePathWithPrefix` and `FilePathWithPrefixLC` remain available for compatibility.

The [design](design_docs/storage_path_resolution.md) defines the detailed
contract. These primitives do not enable NFC automatically in a host
application. WebApp remains Legacy-only and rejects explicit version `1` at
startup. The Bridge Deno integration is an unreleased candidate; version `1`
is an explicit peer opt-in, and every peer in a group must use the same path
version. Its ordinary case-mismatch check remains separate from path-version
admission. See [Unicode path identity](unicode-path-identity.md#supported-hosts)
for the current publication and host-adoption boundaries.

## File-name candidate lookup

These file-name APIs are an unreleased Commonlib change. `FilePathIndex`,
exported from `/storage`, keeps original file names and groups
all candidates under an explicit Unicode and case policy. It performs no I/O
and owns no watcher or readiness state. The host owns the index lifetime,
initial listing, supported-path rules, and membership updates; use
`replaceAll()` for an initial snapshot and `apply({ removed, added })` for a
membership change. Content-only events do not require an index update.

Hosts can expose an asynchronous `FileNameLookup` through the optional
`fileNameLookup` property of `IFileSystemAdapter`. When `{ fresh: true }` is
supplied, `getFileNames()` must ask the host's supported listing authority
again. `findPathIdentityCandidates(path, policy)` returns every matching original
path whose comparison key matches the requested identity. Multiple results are
candidates for the caller's collision decision. Keep fresh listing guarantees
host-specific. A host without this
capability continues to list through `getFiles()` and uses the storage-access
fallback.
Direct `StorageAccess` implementations must also implement the required
`findPathIdentityCandidates()` method when adopting this pre-1.0 interface.

## Bundling boundary

Browser consumers import only `@vrtmrz/livesync-commonlib/browser`. Packed-package tests build that entry with browser conditions and verify that the Node implementation is absent. Node consumers import `@vrtmrz/livesync-commonlib/node`; the root and context entries do not load Node built-ins.
