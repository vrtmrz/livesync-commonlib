# Self-hosted LiveSync Commonlib

Commonlib is the ESM package which provides shared data, storage, replication, host-context, and RPC primitives for Self-hosted LiveSync, its CLI, Webapp, and WebPeer.

This package is primarily for maintainers of those clients and for integrations which deliberately reuse a reviewed Commonlib contract. It is not yet a general-purpose LiveSync SDK: the package does not provide a stable end-to-end client factory or own host UI, permissions, credentials, process lifecycle, or application persistence.

## Status and versioning

The package is pre-1.0. Pin an exact reviewed version, and review changes before upgrading. An entry in the package export map means that the import is deliberate and package-tested; it does not make every semantic detail of that entry a final 1.0 guarantee.

Treat every `compat/*` subpath as a migration-only interface. A source-directory import, Git submodule, or consumer-defined TypeScript alias is not a supported package boundary.

The package is ESM-only and declares Node 20 or later. Browser entry points are built with browser conditions, but the host remains responsible for checking the availability of browser capabilities such as the File System Access API.

## Package entry points

| Entry point                                        | Intended use                                                                      | Current contract status                                                                     |
| -------------------------------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `@vrtmrz/livesync-commonlib`                       | `DirectFileManipulator` for integrations which access CouchDB directly            | Deliberately small, but its high-level lifecycle and file-operation semantics are not final |
| `@vrtmrz/livesync-commonlib/context`               | Instance-owned events, translation injection, and host-neutral standard-I/O types | Focused, package-tested pre-1.0 contract                                                    |
| `@vrtmrz/livesync-commonlib/browser`               | Rooted File System Access API storage                                             | Focused, package-tested pre-1.0 contract                                                    |
| `@vrtmrz/livesync-commonlib/node`                  | Rooted Node storage, Node standard I/O, and selected Node capabilities            | Focused platform entry; some convenience exports still require 1.0 classification           |
| `@vrtmrz/livesync-commonlib/rpc`                   | Transport-neutral RPC rooms, sessions, errors, and the PouchDB RPC bridge         | Deliberate export, but its 1.0 stability status is not yet accepted                         |
| `@vrtmrz/livesync-commonlib/remote-configurations` | Multiple-remote profile creation, naming, and selection                           | Focused, package-tested pre-1.0 contract                                                    |
| `@vrtmrz/livesync-commonlib/settings`              | New-Vault defaults, stored-setting fallbacks, and settings migration results      | Focused, package-tested pre-1.0 contract                                                    |
| `@vrtmrz/livesync-commonlib/compat/*`              | Exact legacy imports still required by existing clients                           | Migration-only; paths may be removed as consumers migrate                                   |
| `@vrtmrz/livesync-commonlib/package.json`          | Package metadata for tooling                                                      | Metadata export, not a runtime API                                                          |

Import only the entry point required by the current runtime. Browser code must not import the Node entry.

TODO: decide whether the Node entry's `fs`, `fsPromises`, `path`, `os`, `readline`, URL, and built-in-module convenience exports belong in the 1.0 public contract or should move behind compatibility paths.

TODO: decide whether the draft RPC protocol and PouchDB bridge are stable 1.0 contracts, remain explicitly experimental, or move to a separately versioned package. Until that decision, pin the exact package version when consuming the RPC entry.

## Host context and initialisation

One service context belongs to one independently composed Commonlib client. It owns that client's event hub and translator. Creating a context without options creates a fresh event hub and uses a translator which returns message keys unchanged:

```ts
import {
    createLiveSyncEventHub,
    createServiceContext,
    type MessageTranslator,
} from "@vrtmrz/livesync-commonlib/context";

const events = createLiveSyncEventHub();
declare const hostTranslations: { translate: MessageTranslator };
const translate: MessageTranslator = (key, parameters) => {
    return hostTranslations.translate(key, parameters);
};

const context = createServiceContext({ events, translate });
```

The host may instead extend `ServiceContext` with platform-specific capabilities. Pass the same context instance to every service in one composition so that they share the intended event channel and translator. Create a separate context for a client which must be isolated.

Context construction does not select storage, connect to a database, start replication, acquire browser permission, or install process-wide state. The host separately owns platform-resource acquisition, adapter construction, and the lifecycle order of its particular service composition.

TODO: define a reviewed high-level composition factory and its initialisation, readiness, error, and disposal contract. Until that exists, service implementations exposed under `compat/*` retain their owning client's lifecycle rather than becoming a general public composition API.

## Rooted storage

Both platform storage factories receive an existing root from the host. They never select a directory, request browser permission, infer a process directory, or persist a handle.

```ts
import { createFileSystemAccessStorage } from "@vrtmrz/livesync-commonlib/browser";

declare const authorisedRoot: FileSystemDirectoryHandle;
const storage = createFileSystemAccessStorage({ rootHandle: authorisedRoot });
await storage.write("notes/example.md", "# Example");
```

```ts
import { createNodeStorage } from "@vrtmrz/livesync-commonlib/node";

const storage = createNodeStorage({ rootPath: "/srv/livesync" });
await storage.write("notes/example.md", "# Example");
```

See [the platform storage contract](docs/platform-storage.md) for path, ownership, and permission details.

## Standard input and output

CLI hosts can inject the platform-neutral `StandardIo` contract from the context entry. The Node entry supplies the concrete stream adapter. This keeps command input and protocol output testable without treating logging or process lifecycle as standard I/O.

```ts
import type { StandardIo } from "@vrtmrz/livesync-commonlib/context";
import { createNodeStandardIo } from "@vrtmrz/livesync-commonlib/node";

const standardIo: StandardIo = createNodeStandardIo();
standardIo.writeStdout("ready\n");
```

See [the standard-I/O contract](docs/platform-standard-io.md) for host composition and test-double examples.

## Settings lifecycle

New-Vault recommendations are deliberately separate from the conservative values used to complete older stored settings. The focused settings entry also reports migrations and safety-review requirements without changing a user's synchronisation choices or persisting a device-local acknowledgement.

See [the settings lifecycle guide](docs/settings-lifecycle.md) before initialising, importing, resetting, or migrating settings.

## Remote connection profiles

New profile-management code can create or update a CouchDB, Object Storage, or P2P connection through the focused remote-configurations entry. Profile IDs provide identity, display names remain editable presentation, and the active selection is explicit. Older flat connection fields remain a runtime projection and an import-compatibility boundary rather than the preferred persistence model.

See [the remote configuration profile guide](docs/remote-configurations.md) for creation, activation, P2P selection, legacy import, persistence, and verification responsibilities.

## Contract scope

The package is currently an infrastructure and compatibility boundary. The context, rooted-storage, and standard-I/O result contracts have focused cross-platform or instance-isolation tests. Platform details which cannot be shared, such as file timestamp fidelity and browser permission handling, remain host concerns and are documented separately.

`DirectFileManipulator` is useful for existing integrations, but its enumeration, watch ownership, failure, conflict, concurrency, readiness, and disposal semantics are not yet a stable high-level SDK contract.

TODO: define and document the first high-level client façade before declaring list, get, put, delete, watch, and close behaviour stable.

Package developers should read [the developer guide](docs/development.md). The focused contracts are described in [the storage guide](docs/platform-storage.md), [the standard-I/O guide](docs/platform-standard-io.md), [the settings lifecycle guide](docs/settings-lifecycle.md), and [the remote configuration profile guide](docs/remote-configurations.md).

## Proven in maintained hosts

The package boundary is exercised by Self-hosted LiveSync's Obsidian plug-in, CLI, Webapp, and WebPeer compositions. Their validation is not uniform: the Obsidian plug-in and CLI have the strongest real-runtime and cross-host evidence, while the Webapp and WebPeer currently provide focused adapter, type-check, and build evidence.

See [Proven in maintained hosts](docs/proven-in-use.md) for the actual composition points, downstream tests, and remaining limits. The examples deliberately separate focused public entries which a new consumer may copy from `compat/*` imports which exist to migrate the current application.

## Licence

MIT
