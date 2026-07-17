# Self-hosted LiveSync Commonlib

Commonlib provides the shared data, storage, and replication primitives used by Self-hosted LiveSync, its CLI, Webapp, and WebPeer.

The package is pre-1.0. Pin an exact reviewed version, and treat `compat/*` subpaths as migration-only interfaces. A source-directory import, Git submodule, or consumer-defined TypeScript alias is not a supported package boundary.

## Package entry points

- `@vrtmrz/livesync-commonlib` contains the deliberately small root API.
- `@vrtmrz/livesync-commonlib/context` contains host-context and translation injection contracts.
- `@vrtmrz/livesync-commonlib/browser` contains browser-only adapters, including rooted File System Access API storage.
- `@vrtmrz/livesync-commonlib/node` contains Node-only capabilities and rooted storage.
- `@vrtmrz/livesync-commonlib/rpc` contains the focused RPC API.
- `@vrtmrz/livesync-commonlib/compat/*` contains temporary explicit exports required by existing Self-hosted LiveSync consumers.

Import only the entry point required by the current runtime. Browser code must not import the Node entry.

## Rooted storage

Both platform storage factories receive an existing root from the host. They never select a directory, request browser permission, infer a process directory, or persist a handle.

```ts
import { createFileSystemAccessStorage } from '@vrtmrz/livesync-commonlib/browser';

declare const authorisedRoot: FileSystemDirectoryHandle;
const storage = createFileSystemAccessStorage({ rootHandle: authorisedRoot });
await storage.write('notes/example.md', '# Example');
```

```ts
import { createNodeStorage } from '@vrtmrz/livesync-commonlib/node';

const storage = createNodeStorage({ rootPath: '/srv/livesync' });
await storage.write('notes/example.md', '# Example');
```

See [the platform storage contract](docs/platform-storage.md) for path, ownership, and permission details.

## Standard input and output

CLI hosts can inject the platform-neutral `StandardIo` contract from the context entry. The Node entry supplies the concrete stream adapter. This keeps command input and protocol output testable without treating logging or process lifecycle as standard I/O.

```ts
import type { StandardIo } from '@vrtmrz/livesync-commonlib/context';
import { createNodeStandardIo } from '@vrtmrz/livesync-commonlib/node';

const standardIo: StandardIo = createNodeStandardIo();
standardIo.writeStdout('ready\n');
```

See [the standard-I/O contract](docs/platform-standard-io.md) for host composition and test-double examples.

## API status

The package is currently an infrastructure and compatibility boundary. `DirectFileManipulator` is useful for existing integrations, but its enumeration, watch ownership, failure, conflict, concurrency, and disposal semantics are not yet a stable high-level SDK contract.

TODO: define and document the first high-level client façade before declaring list, get, put, delete, watch, and close behaviour stable.

Development and package validation are documented in [the developer guide](docs/development.md).

## Licence

MIT
