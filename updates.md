# Updates

## Unreleased

### Improved

- `DirectFileManipulator` can receive a host fetch implementation for direct CouchDB access in runtimes such as Deno.
- Direct file manipulation now reports initialisation failures through its readiness promise and avoids application-owned replication and key-value database lifecycle work.
- Headless logging and manager construction use the capabilities supplied by their composition.

### Deprecated

- `SvelteDialogMixIn` remains available for compatibility, but maintained hosts should compose their dialogue lifecycle explicitly.
