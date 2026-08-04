# Updates

## Unreleased

## 0.1.3

### Fixed

- Remote-only connection and configuration checks no longer access the local database while constructing a replicator, preventing start-up failures before local database initialisation ([Self-hosted LiveSync issue #1064](https://github.com/vrtmrz/obsidian-livesync/issues/1064)).

## 0.1.2

### Fixed

- Unnecessary missing-content warnings are now suppressed when a local file already matches known synchronised history; the existence check stops at the first exact content match instead of reading older revisions which cannot change its result.
- Remote chunk fetching now keeps successfully returned chunks when another requested chunk is unavailable, preventing the latter from making the whole request appear to have failed ([Self-hosted LiveSync issue #771](https://github.com/vrtmrz/obsidian-livesync/issues/771)).

## 0.1.1

### Improved

- `DirectFileManipulator` can receive a host fetch implementation for direct CouchDB access in runtimes such as Deno.
- Direct file manipulation now avoids application-owned replication and key-value database lifecycle work.

### Fixed

- `DirectFileManipulator` now yields metadata-only enumeration results, restores its dedicated path-obfuscation passphrase, and contains document loading failures observed while watching changes (PR #22). Thank you to @es617 for the fixes!
- `DirectFileManipulator` now reports initialisation failures through its readiness promise, and headless logging and manager construction use the capabilities supplied by their composition. This also addresses the start-up failures independently identified in PR #50. Thank you to @adriy-be for the diagnosis and proposed fixes!

### Deprecated

- `SvelteDialogMixIn` remains available for compatibility, but maintained hosts should compose their dialogue lifecycle explicitly.
