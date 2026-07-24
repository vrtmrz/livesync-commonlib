# Repository instructions

- Treat `readme.md` and the focused documents under `docs/` as package-consumer guidance. Keep maintenance and publication procedures in the developer and maintainer documents.
- When maintenance changes a public entry point, a host composition, a downstream integration, or a verification path, review the related consumer documentation and `docs/proven-in-use.md` from the perspective of current use. Update or remove stale examples, links, and evidence. Distinguish Commonlib-owned result contracts from downstream tests, real-runtime verification, and host surfaces which currently have build or type-check coverage only.
- Treat `compat/*` as an explicit migration boundary rather than an example API. Do not present a compatibility import as the recommended integration when a focused entry point exists.
