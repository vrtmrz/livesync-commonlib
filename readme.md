# Self-hosted LiveSync Commonlib

Commonlib is the ESM package which provides shared data, storage, replication, and host-context primitives for Self-hosted LiveSync, its CLI, WebApp, WebPeer, and LiveSync Bridge.

This package is primarily for maintainers of those clients and for integrations which deliberately reuse a reviewed Commonlib contract. It is not yet a general-purpose LiveSync SDK: the package does not provide a stable end-to-end client factory or own host UI, permissions, credentials, process lifecycle, or application persistence.

> [!IMPORTANT]
> **Package migration in progress.** Commonlib is moving from a source-directory and Git-submodule dependency to a compiled npm package as part of Self-hosted LiveSync's Community directory review, reusable package boundary, and 1.0 preparation work.
>
> Existing contributions remain welcome and the normal contribution process has not changed. Pull requests which touch packaging, host lifecycle, or compatibility boundaries may need coordination or a rebase while this boundary settles; maintainers will identify affected work rather than asking contributors to adopt a new process pre-emptively.

> [!NOTE]
> The multilingual translation resources and application dialogues are now maintained in the main application repository, [Self-hosted LiveSync](https://github.com/vrtmrz/obsidian-livesync). New pull requests for them are welcome there. Thank you to everyone who has contributed translations and dialogue improvements here.

## Status and versioning

Commonlib is pre-1.0. The compatibility policy described here begins with 0.2.0 and does not retroactively apply to published 0.1.x versions. Within 0.2.x, Commonlib preserves published APIs, types, behaviour, supported persisted data, and exported `compat/*` paths; intentional breaking changes use 0.3.0. Consumers may declare ranges such as `^0.2.0`; retain a lockfile and use `npm ci` for reproducible installs. An entry in the package export map means that the import is deliberate and package-tested; it does not make every semantic detail of that entry a final 1.0 guarantee.

Treat every `compat/*` subpath as a migration-only interface. A source-directory import, Git submodule, or consumer-defined TypeScript alias is not a supported package boundary.

The package is ESM-only and declares Node 20 or later. Browser entry points are built with browser conditions, but the host remains responsible for checking the availability of browser capabilities such as the File System Access API.

Fast Fetch imports all current leaf revisions listed by CouchDB, including
deleted conflict leaves. A host may supply the optional
`initial-fetch-fast-forward` resource to hand a fresh, complete import to
ordinary replication before resuming local writers. Existing hosts can omit
this optimisation. Resume cursors retain their existing meaning; this resource
does not provide an arbitrary-time checkpoint jump or On Demand repair.

## Package entry points

| Entry point                                        | Intended use                                                                      | Current contract status                                                                     |
| -------------------------------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `@vrtmrz/livesync-commonlib`                       | `DirectFileManipulator` for integrations which access CouchDB directly            | Deliberately small, but its high-level lifecycle and file-operation semantics are not final |
| `@vrtmrz/livesync-commonlib/context`               | Instance-owned events, translation injection, and host-neutral standard-I/O types | Focused, package-tested pre-1.0 contract                                                    |
| `@vrtmrz/livesync-commonlib/diagnostics` | Read-only Usage and integrity inspection, name projection, and reports | Focused pre-1.0 diagnostic contract |
| `@vrtmrz/livesync-commonlib/hashing`               | Chunk ID calculation and exact file-content hashing                            | Focused, package-tested pre-1.0 contract                                                    |
| `@vrtmrz/livesync-commonlib/browser`               | Rooted File System Access API storage                                             | Focused, package-tested pre-1.0 contract                                                    |
| `@vrtmrz/livesync-commonlib/node`                  | Rooted Node storage, Node standard I/O, and selected Node capabilities            | Supported platform façade; keeps Node-only dependencies behind an explicit boundary         |
| `@vrtmrz/livesync-commonlib/p2p`                   | Host-composed P2P service views and composition helpers                           | Focused, package-tested pre-1.0 contract with a temporary compatibility façade              |
| `@vrtmrz/livesync-commonlib/replication`           | Provider capabilities, interaction authority, and typed replication outcomes      | Focused, package-tested pre-1.0 host-composition contract                                   |
| `@vrtmrz/livesync-commonlib/rpc`                   | Existing LiveSync RPC and PouchDB bridge migration                                | Transitional only; not part of the stable Commonlib 1.0 contract                            |
| `@vrtmrz/livesync-commonlib/remote-configurations` | Multiple-remote profile creation, naming, and selection                           | Focused, package-tested pre-1.0 contract                                                    |
| `@vrtmrz/livesync-commonlib/settings`              | New-Vault defaults, stored-setting fallbacks, and settings migration results      | Focused, package-tested pre-1.0 contract                                                    |
| `@vrtmrz/livesync-commonlib/setup-uri`             | Encrypted Setup URI generation, availability, and import                          | Focused, package-tested pre-1.0 contract                                                    |
| `@vrtmrz/livesync-commonlib/ui-commands` | Instance-owned typed UI command declarations and handlers | Focused, package-tested contract |
| `@vrtmrz/livesync-commonlib/compat/*`              | Exact legacy imports still required by existing clients                           | Migration-only; retained within 0.2.x, with removals treated as 0.3.0 breaking changes       |
| `@vrtmrz/livesync-commonlib/package.json`          | Package metadata for tooling                                                      | Metadata export, not a runtime API                                                          |

Import only the entry point required by the current runtime. Browser code must not import the Node entry.

The Node and browser entries are platform façades. They keep platform-specific adapters and capabilities behind package-owned boundaries, so a consumer does not have to reproduce those imports or their build and review exceptions. The Node entry's selected built-in-module exports are deliberate parts of that façade. Package checks ensure that the root, context, and browser entries do not load the Node implementation.

The RPC entry exists only while the maintained LiveSync P2P composition depends on the current implementation. Its draft wire protocol and PouchDB bridge are not stable Commonlib 1.0 contracts. RPC is planned to move to Fancy Kit as an independently owned rewrite; new Commonlib consumers should not adopt the transitional entry.

The P2P entry exposes eight focused views over one service owner, together with the maintained host-composition helpers. New consumers select only the lifecycle, peer-directory, peer-admission, targeted-transfer, change-relay, configuration-exchange, diagnostic, or connection-probe-admission view which they need. The composition result still carries a deprecated concrete Replicator façade while existing panes migrate; new consumers must not depend on that property or reach through it to a raw room or host.

## Host context and initialisation

One service context belongs to one independently composed Commonlib client. It owns that client's event hub and translator. Creating a context without options creates a fresh event hub and renders Commonlib's typed canonical English messages. A host may inject a translator to provide another language:

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

After the Self-hosted LiveSync 1.0 work, the planned high-level composition is a narrow `createLiveSyncFileClient` factory for direct database integrations, not a general factory which exposes Commonlib's internal Service Hub. It will resolve only after its private context, services, database, and protocol settings are ready, and its returned file client will own its watches, reconnect work, and orderly disposal. Obsidian, CLI, Webapp, and other full hosts retain their host-specific compositions.

The factory is not implemented yet. Until it is available, service implementations exposed under `compat/*` retain their owning client's lifecycle rather than becoming a general public composition API.

## UI commands

Import `declareUICommand` and `UICommandRegistry` from `@vrtmrz/livesync-commonlib/ui-commands`. A declaration binds a stable command ID to its request and result types. Each `UIService` owns its own `commands` registry; declarations do not register global handlers.

```ts
import { declareUICommand } from "@vrtmrz/livesync-commonlib/ui-commands";

const showDevices = declareUICommand<void, 'closed'>('example:show-devices');
const unregister = services.UI.commands.register(showDevices, async () => {
    await openHostDeviceDialogue();
    return 'closed';
});
const result = await services.UI.commands.invoke(showDevices, undefined);
// result is { status: 'handled', value: 'closed' } or { status: 'unavailable' }.
unregister();
```

A feature releases its handler when it unloads. The host dialogue owner remains responsible for active UI work. Duplicate handlers and conflicting declarations with the same ID are rejected; handler failures propagate. Calling an unavailable or disposed registry settles immediately. `UIService` disposes its registry on the context's plug-in-unloaded event.

## Joined device records

The `/replication` entry includes the `joined-devices` finite resource contract. A provider binds each resource to one settings snapshot; its owner calls `dispose()` in `finally`. `read()` returns recorded device IDs, acceptance, versions, platform, and connection times where available. An absent milestone is explicit. Joined-device operations never initialise a missing CouchDB database. These records do not establish online presence.

`forget(id)` removes one other device from all participation maps and the accepted list, while retaining the lock state, preferred tweaks, and unknown fields. The CouchDB implementation rereads the existing milestone before editing and verifies removal after saving. CouchDB local documents do not reject stale revisions, so concurrent changes to other device records can be overwritten. A failed verification is reported to the caller for manual refresh and retry. Object Storage checks ETags with conditional writes and retries conflicts a bounded number of times. Missing records, unsupported conditional writes, and exhausted conflicts have distinct results. Forgetting is not credential revocation: an unlocked remote permits a returning device to register again.

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

## Setup URI sharing

The focused Setup URI entry offers an Ephemeral mode bound to the current fixed seven-day window and a Persistent mode compatible with existing readers. Both use the same URI structure. See [the Setup URI sharing guide](docs/setup-uri.md) for the availability boundary, import behaviour, and compatibility limits.

## Database diagnostics

The focused `/diagnostics` entry provides read-only Usage and integrity reports, with original names or temporary pseudonyms selected by the host for each run. Integrity inspection covers normal-file Metadata, current conflict branches, and content comparisons for suspect groups in the local database and, by default, CouchDB; the host can exclude the remote source for one run. See [Database diagnostics](docs/database-diagnostics.md) for coverage, progress, cancellation, pseudonym lookup, and privacy boundaries.

Integrity Markdown places a compact state summary and review index before all findings, while retaining each observation and its follow-up references. This formatting does not change the projected JSON data or schema; see [the Markdown field guide](docs/database-diagnostics.md#compact-integrity-markdown-report) for the meaning and limits of its review index.

```typescript
import {
    analyseDatabaseUsage,
    createDiagnosticNameMapper,
    createLocalDiagnosticSource,
    formatUsageTSV,
    parseDiagnosticPathToken,
    projectUsageReport,
} from '@vrtmrz/livesync-commonlib/diagnostics';

const result = await analyseDatabaseUsage({ source: createLocalDiagnosticSource(localPouchDB) });
const mapper = createDiagnosticNameMapper('pseudonym');
const report = projectUsageReport(result, mapper);
if (report.status === 'complete') {
    const tsv = formatUsageTSV(report);
    // Present the report through the host's own UI or output stream.
}
```

Path pseudonyms include the report salt. A consumer can parse that token and supply its salt to a new mapper for a targeted follow-up against exact local Metadata paths:

```typescript
const pathToken = report.rows[0]?.path;
const parsed = pathToken === undefined ? undefined : parseDiagnosticPathToken(pathToken);
if (parsed) {
    const followUpMapper = createDiagnosticNameMapper('pseudonym', parsed.salt);
    const candidateToken = followUpMapper.path(storedVaultRelativePath);
    // Compare this token with the path pseudonym on this device.
}
```

The parser accepts only complete path tokens; it does not reverse them to recover a path. The salt is public, so a guessed path can be checked. Older ordinal pseudonyms have no corresponding lookup.

## Chunk ID calculation

The `/hashing` entry exports `HashManager` and its `HashManagerCoreOptions` type. It uses the same implementation as database writes, including legacy algorithms and independent ID keys. Hosts supply their settings service and await `initialise()` before calling `computeHash(piece)`.

`computeHash` returns the Chunk hash, including the `+` prefix when encryption is enabled; the database adds its `h:` namespace separately. Reuse a manager for repeated calculations with the same configuration, create a new manager when changing the legacy algorithm or passphrase, and call `clearCaches()` when retiring it. This releases retained key preparation; it does not erase existing settings or in-flight operations. The entry performs ID calculation and does not write Chunks to a database.

## File content hashing

`computeFileContentHash(content: Blob)` returns a `sha256:<lowercase hexadecimal>` digest of the exact bytes. It includes Blob reading and serialises concurrent hashes to limit whole-file buffer overlap. File-reflection provenance uses this helper to recognise unchanged content independently of retained revision history; it does not replace Chunk ID calculation.

## Remote connection profiles

New profile-management code can create or update a CouchDB, Object Storage, or P2P connection through the focused remote-configurations entry. Profile IDs provide identity, display names remain editable presentation, and the active selection is explicit. Older flat connection fields remain a runtime projection and an import-compatibility boundary rather than the preferred persistence model.

See [the remote configuration profile guide](docs/remote-configurations.md) for creation, activation, P2P selection, legacy import, persistence, and verification responsibilities.

## Remote database feature compatibility

CouchDB stores the representations already in use as feature identifiers in its version document. Assess that document before synchronisation or direct file operations, and retain unknown identifiers for host diagnostics. See [the remote feature compatibility contract](docs/remote-feature-compatibility.md) for the wire format, update rules, and recovery boundaries.

The maintained CLI and Obsidian hosts can opt into [Unicode NFC path identity](docs/unicode-path-identity.md) with CouchDB. Existing databases require an explicit Rebuild or Fetch migration before using it.

## Contract scope

The package is currently an infrastructure and compatibility boundary. The context, rooted-storage, standard-I/O, and revision-tree safety contracts have focused cross-platform, instance-isolation, or real-PouchDB tests. Platform details which cannot be shared, such as file timestamp fidelity and browser permission handling, remain host concerns and are documented separately.

`DirectFileManipulator` is useful for existing integrations, but its enumeration, watch ownership, failure, conflict, concurrency, readiness, and disposal semantics are not a stable high-level SDK contract. It is the migration source for the planned file client, not the shape to preserve as the new API.

The accepted replacement direction is an asynchronously created file client with stable `list`, `get`, `put`, `delete`, `watch`, and `close` operations. The operation result, conflict, concurrency, watch checkpoint, retry, and error contracts still require focused decisions and tests before that client can be published.

Package developers should read [the developer guide](docs/development.md). The focused contracts are described in [the storage guide](docs/platform-storage.md), [the standard-I/O guide](docs/platform-standard-io.md), [the settings lifecycle guide](docs/settings-lifecycle.md), [the remote configuration profile guide](docs/remote-configurations.md), [the remote feature compatibility contract](docs/remote-feature-compatibility.md), [the conflict-resolution guide](docs/conflict-resolution.md), and [the P2P transport lifecycle guide](docs/p2p-transport-lifecycle.md).

## Maintained-host examples and evidence

The package boundary is exercised by Self-hosted LiveSync's Obsidian plug-in, CLI, WebApp, and WebPeer compositions. Their validation is not uniform: the Obsidian plug-in and CLI have the strongest device and long-running synchronisation evidence, while WebApp and WebPeer have focused adapter and runtime tests, browser smoke tests, a cross-application P2P scenario ending at the production CLI, and public Pages smoke validation.

See [Maintained-host examples and evidence](docs/proven-in-use.md) for composition points, downstream tests, and remaining limits. This optional page records examples and evidence; it does not define package support or create a release or adoption requirement. The examples deliberately separate focused public entries which a new consumer may copy from `compat/*` imports which exist to migrate the current application.

## Licence

MIT
