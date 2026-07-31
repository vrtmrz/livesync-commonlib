# Updates

## Unreleased

### Improved

- `DirectFileManipulator` can receive a host fetch implementation for direct CouchDB access in runtimes such as Deno.
- Direct file manipulation now avoids application-owned replication and key-value database lifecycle work.

### Fixed

- `DirectFileManipulator` now yields metadata-only enumeration results, restores path obfuscation from its passphrase option, and contains decryption failures observed while watching changes (PR #22). Thank you to @es617 for the fixes!
- `DirectFileManipulator` now reports initialisation failures through its readiness promise, and headless logging and manager construction use the capabilities supplied by their composition. This also addresses the start-up failures independently identified in PR #50. Thank you to @adriy-be for the diagnosis and proposed fixes!

### Deprecated

- `SvelteDialogMixIn` remains available for compatibility, but maintained hosts should compose their dialogue lifecycle explicitly.
