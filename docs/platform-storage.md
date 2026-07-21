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

The Node adapter does not follow symbolic links in adapter paths. A path containing a symbolic link is rejected, including when the link points to another location below `rootPath`, so every operation retains one unambiguous rooted-storage boundary. Its concrete `rename(sourcePath, targetPath)` operation preserves this boundary while providing the atomic rename expected by Node hosts.

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

## Bundling boundary

Browser consumers import only `@vrtmrz/livesync-commonlib/browser`. Packed-package tests build that entry with browser conditions and verify that the Node implementation is absent. Node consumers import `@vrtmrz/livesync-commonlib/node`; the root and context entries do not load Node built-ins.
