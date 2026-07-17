# Commonlib development

This document is for Commonlib developers. Package consumers should begin with the root README and the focused platform guide.

## Local validation

```bash
npm ci
npm run check:types
npm test
npm run test:contracts
npm run test:boundary
npm run test:package
```

`test:package` builds the compiled package, packs it, installs the tarball into a clean consumer fixture, exercises Node imports, type-checks public entry points, and creates representative browser bundles. It also verifies that browser and context entry points do not pull in Node-only code, Svelte, or the complete language catalogue unintentionally.

`test:contracts` runs the host-neutral result contracts which are intended to be reusable while implementations move:

- `test:contract:context` verifies event delivery, default instance isolation, translation results, and host extension of `ServiceContextContract`; and
- `test:contract:platform-storage` runs one result table against Node storage and browser File System Access storage, including missing paths, text and binary round trips, append, listing, removal, root handling, and traversal rejection.

These scripts are deliberately available independently of CI. Add a focused result contract before moving another platform API; do not infer compatibility from matching TypeScript shapes alone. Platform-specific behaviour, such as timestamp fidelity, must remain documented outside the shared result set.

Self-hosted LiveSync remains the principal downstream consumer. A Commonlib change is not ready for publication until the exact packed artefact has also passed the applicable LiveSync type checks, unit and integration tests, application builds, CLI E2E, and focused real-Obsidian E2E.

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

## Compatibility exports

The package build records each compatibility path explicitly. Do not add a wildcard export. A new compatibility path requires a real downstream import, a packed-consumer or downstream test, and a migration plan towards a focused public entry or the owning package.

TODO: classify and document compatibility paths whose purpose is still unclear before stabilising the first public release. Remove obsolete paths rather than documenting accidental layout as API.

Release preparation and staged-publication checks are documented in [the maintainer runbook](releasing.md).
