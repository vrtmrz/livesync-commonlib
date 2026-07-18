# Proven in maintained hosts

Commonlib is extracted from the implementation shared by [Self-hosted LiveSync](https://github.com/vrtmrz/obsidian-livesync) and its host applications. The package is therefore exercised by a substantial maintained consumer, but it does not yet claim a separate ecosystem of independent applications or a stable end-to-end SDK.

The useful evidence is host- and contract-specific. Focused Commonlib tests establish reusable result semantics; Self-hosted LiveSync tests establish how those contracts compose into the Obsidian plug-in and CLI. The Webapp has focused adapter tests, and both the Webapp and WebPeer are type-checked and built, but they do not have an equally current end-to-end gate.

The source links below identify the exact reviewed Self-hosted LiveSync revision used to establish this package boundary. The integration descriptions must still be reviewed when the maintained downstream changes.

## Obsidian plug-in

The plug-in extends the neutral `ServiceContext` with Obsidian-owned capabilities in [`ObsidianServiceContext.ts`](https://github.com/vrtmrz/obsidian-livesync/blob/6cc06bf20fc044c70408ef3d92fe0bbc0874479d/src/modules/services/ObsidianServiceContext.ts). One context instance carries the host translator and event hub through the Service Hub rather than placing those dependencies in Commonlib globals.

The consumer's [service-context contract](https://github.com/vrtmrz/obsidian-livesync/blob/6cc06bf20fc044c70408ef3d92fe0bbc0874479d/test/contracts/serviceContext.ts) checks shared result semantics and exact context identity across the composed services. The [real-Obsidian suite](https://github.com/vrtmrz/obsidian-livesync/blob/6cc06bf20fc044c70408ef3d92fe0bbc0874479d/test/e2e-obsidian/README.md) then covers plug-in loading, representative Svelte dialogue mounts, Vault reflection, CouchDB and Object Storage synchronisation, two-Vault behaviour, and other Obsidian-owned boundaries.

Most replication and storage services used by the plug-in still enter through explicit `compat/*` paths. Those imports prove that the published compatibility boundary supports the current migration; they are not examples of a finished high-level client API.

## CLI

The CLI extends the same neutral context with its database path and injected `StandardIo` in [`NodeServiceContext.ts`](https://github.com/vrtmrz/obsidian-livesync/blob/6cc06bf20fc044c70408ef3d92fe0bbc0874479d/src/apps/cli/services/NodeServiceContext.ts). Its entry point creates the Node standard-I/O adapter once and passes it to command composition, while unit tests provide stream-independent fakes for parsing, prompts, standard output, and standard error.

The CLI filesystem composition receives a configured base directory and constructs the rooted Node storage adapter in [`NodeFileSystemAdapter.ts`](https://github.com/vrtmrz/obsidian-livesync/blob/6cc06bf20fc044c70408ef3d92fe0bbc0874479d/src/apps/cli/adapters/NodeFileSystemAdapter.ts). Commonlib's shared storage result table checks the focused root contract; the consumer adds its file cache, Vault-shaped operations, case handling, and command policy.

The maintained CLI checks include unit tests, Deno-driven CLI E2E, Compose-based compatibility runs, and the [CLI-to-real-Obsidian synchronisation scenario](https://github.com/vrtmrz/obsidian-livesync/blob/6cc06bf20fc044c70408ef3d92fe0bbc0874479d/test/e2e-obsidian/scripts/cli-to-obsidian-sync.ts). The latter is the strongest current evidence that the CLI and plug-in compose compatible Commonlib behaviour across two hosts.

## Webapp

The Webapp receives an already authorised `FileSystemDirectoryHandle` from its host and constructs `FileSystemAccessStorageAdapter` inside [`FSAPIFileSystemAdapter.ts`](https://github.com/vrtmrz/obsidian-livesync/blob/6cc06bf20fc044c70408ef3d92fe0bbc0874479d/src/apps/webapp/adapters/FSAPIFileSystemAdapter.ts). The adapter does not call `showDirectoryPicker()`, choose a directory, or persist the handle. This is the maintained application example for the browser entry's root-ownership rule.

The browser and Node storage implementations run through the same Commonlib result contract, and the Webapp adapter has focused unit coverage. The Webapp is also type-checked and built by downstream verification. Its browser E2E has not been kept at the same level as the Obsidian and CLI suites, so the documentation does not treat Webapp integration as equivalent real-runtime evidence.

## WebPeer and browser service composition

The browser service composition in [`createLiveSyncBrowserServiceHub.ts`](https://github.com/vrtmrz/obsidian-livesync/blob/6cc06bf20fc044c70408ef3d92fe0bbc0874479d/src/apps/browser/createLiveSyncBrowserServiceHub.ts) supplies browser-owned API and UI services around a caller-supplied context. WebPeer and the browser applications exercise this compatibility surface through type checks and builds.

The Obsidian plug-in, CLI, and Webapp compose P2P ownership through `useP2PReplicatorFeature`. Commands and Obsidian views retain its live result object and resolve the current replicator when an action occurs. WebPeer still enters through the deprecated combined compatibility function, which now delegates the same ownership and lifecycle to the focused feature instead of maintaining a second implementation. Downstream Deno and Compose P2P E2E cover peer discovery and synchronisation; the Webapp and WebPeer UI surfaces themselves remain build- and type-check evidence rather than equivalent real-runtime gates.

This is evidence that the current package boundary can be consumed without the Obsidian host, but it is not yet a recommended standalone Commonlib client factory. The high-level lifecycle, readiness, error, and disposal contract remains a documented 1.0 decision.

## What a new consumer should copy

A new integration should start with the focused entries, not by reproducing Self-hosted LiveSync's compatibility imports:

- create one `ServiceContext` per independently composed client, inject its translator and events, and extend it only with capabilities owned by that host;
- let the host select and authorise a storage root, then pass the root once to the Node or browser storage factory;
- inject `StandardIo` into CLI policy so that protocol output and prompts remain testable; and
- run the relevant Commonlib result contract against another implementation before describing matching TypeScript shapes as compatible behaviour.

Use the linked consumer code as an integration example, while retaining the ownership and limitations stated in the [root README](https://github.com/vrtmrz/livesync-commonlib/blob/main/readme.md), [storage guide](platform-storage.md), and [standard-I/O guide](platform-standard-io.md).

## Maintenance rule

This page records current evidence rather than historical adoption. When a host stops using an entry point, a verification path is retired, or a compatibility import moves to a focused contract, update the description and links instead of retaining a stronger claim than the maintained consumer establishes.
