# Commonlib development

This document is for Commonlib developers. Package consumers should begin with the root README and the focused platform guide.

## Repository and package boundary

The source tree is larger than the supported package surface. Consumers may import only paths in the generated package export map:

- `src/index.ts`, `src/context.ts`, `src/platform/browser/index.ts`, `src/platform/node/index.ts`, and `src/rpc/index.ts` define the focused entries;
- `_tools/build-package.mjs` compiles those entries and creates the publishable manifest under `.package`;
- `docs/migration/downstream-imports.json` is the reviewed inventory from which explicit `compat/*` exports are generated;
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

Self-hosted LiveSync remains the principal downstream consumer. A Commonlib change is not ready for publication until the exact packed artefact has also passed the applicable LiveSync type checks, unit and integration tests, application builds, CLI E2E, and focused real-Obsidian E2E.

Keep [the maintained-host evidence](proven-in-use.md) aligned with the downstream source and gates. If a host no longer consumes a focused entry, a test is retired, or a compatibility path receives a reviewed replacement, update the consumer-facing account as part of the same maintenance rather than leaving historical adoption as a current support claim.

## Integration tests

The integration suite owns Commonlib's direct CouchDB and S3-compatible storage checks. Run it with managed, disposable CouchDB and MinIO containers:

```bash
npm run test:integration:managed
```

This command requires Docker Compose, creates only test credentials and data, and removes the containers and their volumes after the run. It is the same entry point used by package CI.

To test services that are already running, use `npm run test:integration`. The runner accepts `hostname`, `username`, and `password` for CouchDB, and `minioEndpoint`, `accessKey`, `secretKey`, and `bucketName` for S3-compatible storage. Without overrides, it uses the endpoints and test credentials from the managed Compose environment. The selected MinIO bucket must already exist when services are not managed by the runner.

## Translation catalogue

Human-edited translations live under `src/common/messagesYAML`. Regenerate derived JSON and TypeScript resources with:

```bash
npm run i18n:bake
```

The generated catalogue remains an optional dependency surface. Core and context imports must not load it.

## Public API documentation

New reviewed public entry points require TSDoc describing ownership, lifecycle, platform constraints, errors, and disposal. Hand-written guides explain cross-entry composition and operational constraints.

Generated API reference is deferred until the compatibility export surface has been narrowed. Generating documentation for every current `compat/*` path would make migration-only implementation paths look like stable public API.

TODO: introduce generated API reference for a reviewed allow-list of public entry points once the high-level client façade and its lifecycle contract have been accepted.

## Open 1.0 documentation decisions

Resolve these questions before describing the corresponding behaviour as stable:

- define the high-level client façade and the readiness, enumeration, watch, failure, conflict, concurrency, and disposal semantics currently left open by `DirectFileManipulator`;
- classify the selected Node built-in convenience exports as either supported platform contracts or migration-only compatibility exports;
- decide whether the RPC entry and its draft wire protocol belong to the Commonlib 1.0 contract, remain experimental, or move to a separately versioned package;
- classify compatibility paths whose owner or migration destination is still unclear, and remove obsolete paths rather than preserving the source layout; and
- introduce generated API reference only for the reviewed public allow-list, with TSDoc coverage for ownership, lifecycle, errors, platform constraints, and disposal.

## Compatibility exports

The package build records each compatibility path explicitly. Do not add a wildcard export. A new compatibility path requires a real downstream import, a packed-consumer or downstream test, and a migration plan towards a focused public entry or the owning package.

TODO: classify and document compatibility paths whose purpose is still unclear before stabilising the first public release. Remove obsolete paths rather than documenting accidental layout as API.

Release preparation and staged-publication checks are documented in [the maintainer runbook](releasing.md).
