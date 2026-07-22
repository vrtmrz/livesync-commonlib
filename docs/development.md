# Commonlib development

This document is for Commonlib developers. Package consumers should begin with the root README and the focused platform guide.

## Repository and package boundary

The source tree is larger than the supported package surface. Consumers may import only paths in the generated package export map:

- `src/index.ts`, `src/context.ts`, `src/settings.ts`, `src/remoteConfigurations.ts`, `src/platform/browser/index.ts`, and `src/platform/node/index.ts` define the focused entries;
- `src/rpc/index.ts` defines a transitional entry for the existing LiveSync P2P composition, not a stable Commonlib 1.0 contract;
- `_tools/build-package.mjs` compiles those entries and creates the publishable manifest under `.package`;
- `docs/migration/downstream-imports.json` is the reviewed inventory from which explicit `compat/*` exports are generated;
- `docs/migration/compatibility-classification.json` assigns every inventoried compatibility path to one reviewed owner and migration policy, with a boundary test preventing omissions and duplicate classifications;
- colocated `*.unit.spec.ts` and `*.unit.test.ts` files exercise implementation and result contracts; and
- colocated `*.integration.spec.ts` files, `test/integration`, and the integration runner own checks against disposable CouchDB and S3-compatible services.

Files elsewhere under `src` are implementation details unless a focused entry re-exports them or the compatibility inventory names them. Do not use the source layout, TypeScript path aliases, or the presence of generated declarations as evidence of a supported consumer import.

## Local validation

For a complete local package gate, run:

```bash
npm ci
npm run verify:package
```

`verify:package` type-checks the source, runs the unit suite and package-boundary tests, validates release selection, builds the compiled package, and checks the exact packed consumer boundary.

Run the managed integration suite as a separate gate when CouchDB streaming fetches, S3-compatible storage, or their dependencies could be affected:

```bash
npm run test:integration:managed
```

During focused work, the component scripts remain available independently:

```bash
npm run check:types
npm test
npm run test:contracts
npm run test:boundary
npm run test:package
```

`test:package` builds the compiled package, packs it, installs the tarball into a clean consumer fixture, exercises Node imports, type-checks public entry points, and creates representative browser bundles. It also verifies that browser and context entry points do not pull in Node-only code, Svelte, or the complete language catalogue unintentionally.

`test:contracts` runs the host-neutral result contracts which are intended to be reusable while implementations move:

- `test:contract:context` verifies event delivery, default instance isolation, translation results, and host extension of `ServiceContextContract`;
- `test:contract:platform-storage` runs one result table against Node storage and browser File System Access storage, including missing paths, text and binary round trips, append, listing, removal, root handling, and traversal rejection; and
- `test:contract:standard-io` verifies the injectable contract, UTF-8 decoding across chunks, text and binary output, and line-oriented prompting through injected Node streams.

These scripts are deliberately available independently of CI. Add a focused result contract before moving another platform API; do not infer compatibility from matching TypeScript shapes alone. Platform-specific behaviour, such as timestamp fidelity, must remain documented outside the shared result set.

The settings lifecycle has an additional focused unit table in `src/common/models/setting.lifecycle.unit.spec.ts`. Extend it whenever a schema migration, a new-Vault recommendation, or downgrade handling changes. A stored setting must keep its explicit value unless the migration itself documents a deliberate transformation.

The multiple-remote profile contract has focused unit coverage in `src/serviceFeatures/remoteConfig.unit.spec.ts`. Extend it whenever profile identity, generated display names, activation, P2P selection, URI serialisation, or legacy migration changes. New hosts should import the reviewed primitives through `/remote-configurations`; `compat/serviceFeatures/remoteConfig` remains the wider migration surface used by existing clients.

The revision-tree safety rules are documented in [Conflict resolution and file provenance](conflict-resolution.md). `ConflictManager.unit.spec.ts` owns common-ancestor and conservative merge behaviour. `ServiceDatabaseFileAccessBase.unit.spec.ts` owns all-branch content discovery and exact-revision logical deletion. `ServiceFileHandlerBase.unit.spec.ts` owns the injected provenance policy for edit, deletion, and rename operations. Extend the relevant sides when changing conflict resolution, compaction handling, provenance, or database-to-storage overwrite protection.

`openSimpleStore()` may create an inert namespace handle during composition, before the backing key-value database has opened. Maintained hosts must complete their sequential settings lifecycle before scans, watchers, or replication invoke the handle. Operations fail on a lifecycle violation rather than waiting for readiness; do not introduce an implicit wait which can hang after failed initialisation or become self-referential from an initialisation handler. Treat database reset as a transient unavailable boundary and reconstruct derived local state after reopening.

### P2P composition ownership

`useP2PReplicatorFeature` is the sole owner of the active `LiveSyncTrysteroReplicator` and its lifecycle bindings. It creates or replaces the outer replicator when `ReplicatorService` requests one, closes the previous instance before replacement, shares an in-flight replacement between concurrent callers, and returns a stable result object whose `replicator` property resolves the current instance.

Consumers must preserve that result object and read `result.replicator` at the point of use. Do not destructure the property into a command, event handler, view, or other long-lived closure: a database reinitialisation or remote-type transition can close and replace the captured instance, and calling `open()` on that obsolete outer object can create a second connection outside the active service state.

The similarly named compositions have narrower roles:

- `useP2PReplicatorCommands` adds host commands and resolves the current instance when a command is checked or invoked;
- host UI features add views, status presentation, and injected peer-selection callbacks without owning the replicator lifecycle; and
- the deprecated `useP2PReplicator` entry is a compatibility composition which delegates ownership to `useP2PReplicatorFeature`.

When registering P2P event handlers for a replaceable instance, pass a provider to `addP2PEventHandlers`. Passing a fixed instance remains supported only for compositions whose instance cannot change. Extend the focused feature, command, event-hub, and compatibility-wrapper tests whenever this ownership boundary changes.

The physical room, WebRTC peer, and relay-socket boundaries are documented in [P2P transport lifecycle](p2p-transport-lifecycle.md). In particular, normal shutdown leaves the Trystero room without closing raw peer connections directly.

Self-hosted LiveSync remains the principal downstream consumer. A Commonlib change is not ready for publication until the exact packed artefact has also passed the applicable LiveSync type checks, unit and integration tests, application builds, CLI E2E, and focused real-Obsidian E2E.

Commonlib owner tests exercise the real implementation behind each focused result and lifecycle contract. A consumer-owned unit test may inject the smallest structural capability it uses and provide its own fake or spy when that current test needs isolation. Do not publish Vitest-specific mocks, expose private service constructors, or refactor a production boundary merely to create possible future test infrastructure. Mock and spy helpers are not a prerequisite for the LiveSync 1.0 package-boundary work; add them only with the consumer test which requires them, or after that release work.

Prefer an object or callback injected at the host composition boundary over replacing an ESM module namespace. If a proposed focused API would require global mutation, import-order coupling, hidden construction, or private nominal types to substitute later, stop and review the production design before stabilising it. Exact-package downstream checks and focused real-runtime E2E remain responsible for proving the real package and host composition together.

Commonlib publishes the typed English messages which it owns and uses them when a host does not provide a translator. A host may inject a translator through `ServiceContext`; the full multilingual catalogue and language-selection state belong to that host and are not part of the Commonlib package.

Keep [the maintained-host evidence](proven-in-use.md) aligned with the downstream source and gates. If a host no longer consumes a focused entry, a test is retired, or a compatibility path receives a reviewed replacement, update the consumer-facing account as part of the same maintenance rather than leaving historical adoption as a current support claim.

## Integration tests

The integration suite owns Commonlib's direct CouchDB and S3-compatible storage checks. Run it with managed, disposable CouchDB and MinIO containers:

```bash
npm run test:integration:managed
```

This command requires Docker Compose, creates only test credentials and data, and removes the containers and their volumes after the run. It is the same entry point used by package CI.

To test services that are already running, use `npm run test:integration`. The runner accepts `hostname`, `username`, and `password` for CouchDB, and `minioEndpoint`, `accessKey`, `secretKey`, and `bucketName` for S3-compatible storage. Without overrides, it uses the endpoints and test credentials from the managed Compose environment. The selected MinIO bucket must already exist when services are not managed by the runner.

## Messages and translation

`src/services/base/CommonlibMessages.ts` is the canonical English definition and key type for messages requested by Commonlib. Keep a meaningful English value for every symbolic key. Hosts may translate that typed key set, but translation is optional and omission must remain safe for users.

Application language catalogues and their generation tools belong to the application repository. Do not add a process-global language selection or a complete application catalogue to Commonlib.

## Public API documentation

New reviewed public entry points require TSDoc describing ownership, lifecycle, platform constraints, errors, and disposal. Hand-written guides explain cross-entry composition and operational constraints.

Generated API reference is deferred until the compatibility export surface has been narrowed. Generating documentation for every current `compat/*` path would make migration-only implementation paths look like stable public API.

The proposed generated-reference allow-list is deliberately entry-based:

- include `/context`, `/browser`, `/node`, `/remote-configurations`, and `/settings`;
- exclude the root entry until `createLiveSyncFileClient` replaces `DirectFileManipulator` after the LiveSync 1.0 work;
- leave possible `/setup-uri` and `/database-version` entries for later review rather than creating them to clean up imports before LiveSync 1.0; and
- exclude `/rpc`, every `compat/*` path, and the metadata-only `package.json` export.

Generate reference only for this reviewed current allow-list. Future entries require their own accepted result and lifecycle contracts before joining it.

## Open 1.0 documentation decisions

Resolve these questions before describing the corresponding behaviour as stable:

- classify compatibility paths whose owner or migration destination is still unclear, and remove obsolete paths rather than preserving the source layout; and
- introduce generated API reference only for the reviewed public allow-list, with TSDoc coverage for ownership, lifecycle, errors, platform constraints, and disposal.

The platform and RPC ownership decisions are accepted:

- `/node` and `/browser` are supported platform façades. They deliberately hide platform-specific imports, adapters, and review exceptions behind package-owned boundaries. The selected Node built-in re-exports are part of that boundary; package tests must continue to prove that browser-capable entries do not reach Node-only code.
- `/rpc` is transitional and is not part of the stable Commonlib 1.0 contract. Keep it only while the maintained LiveSync P2P composition requires the existing implementation. The RPC core, transport integration, wire protocol, and PouchDB bridge are planned for an independently owned rewrite in Fancy Kit; do not encourage new Commonlib consumers to adopt the current entry.
- The high-level composition target is a narrow asynchronous `createLiveSyncFileClient` factory, not a general Service Hub factory. It must keep the context, service graph, database implementation, protocol setup, watches, reconnect work, and shutdown order private. It resolves only after readiness and returns a small file façade with `list`, `get`, `put`, `delete`, `watch`, and `close`. Full Obsidian, CLI, and browser applications retain host-specific composition because they own UI, persistence, permissions, storage events, and process policy.
- `DirectFileManipulator` is a migration source for that file client rather than the stable target contract. Do not carry its fire-and-forget constructor initialisation, exposed service graph and database documents, incomplete enumeration, implicit watch retry, or deprecated settings options into the new public API. Define the exact result, conflict, concurrency, watch checkpoint, retry, and error semantics only after the LiveSync 1.0 work rather than making that future client a release gate.

## Compatibility exports

The package build records each compatibility path explicitly. Do not add a wildcard export. A new compatibility path requires a real downstream import, a packed-consumer or downstream test, and a migration plan towards a focused public entry or the owning package.

After the reviewed Self-hosted LiveSync revision changes, inspect its current compatibility imports with:

```bash
npm run update:downstream-import-inventory -- --downstream /path/to/obsidian-livesync
```

The command recognises both the former `@lib/*` source aliases and current `@vrtmrz/livesync-commonlib/compat/*` package imports. It ignores focused package entries. Review the resulting paths and recorded downstream commit before accepting them. Regenerate the export map only for a new package version: do not change the contents represented by an immutable published version.

The classification in `docs/migration/compatibility-classification.json` is accepted for LiveSync 1.0 planning. A destination still requires its own result and lifecycle contract before it becomes a stable public entry. Remove obsolete paths rather than documenting accidental layout as API.

Release preparation and staged-publication checks are documented in [the maintainer runbook](releasing.md).
