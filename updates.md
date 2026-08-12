# Updates

## Unreleased

### Fixed

- Fast Fetch now writes deletion tombstones to the local database without attempting to decrypt them. A tombstone has no encrypted payload, and decryption previously aborted the whole fetch at the first deleted document. New devices could not complete their initial sync on vaults that contain old deletions ([Self-hosted LiveSync issue #1099](https://github.com/vrtmrz/obsidian-livesync/issues/1099)).

## 0.1.11

### Fixed

- Full offline scans now distinguish completed, deliberately skipped, and failed storage/database pairs. Failed database-to-storage reflections no longer record the database mtime as local last-seen evidence, preventing a later `NEWER_WINS` scan from misclassifying a still-missing file as an offline deletion. Actual failures propagate to maintained hosts, while conflict and size-policy skips remain non-fatal ([Self-hosted LiveSync issue #1065](https://github.com/vrtmrz/obsidian-livesync/issues/1065)).

## 0.1.10

### Fixed

- Fast Fetch now falls back to Standard Fetch when the internal Request API is enabled, avoiding a buffered transport which cannot provide the progressive response reading or request cancellation Fast Fetch requires. Standard Fetch also discards obsolete Fast Fetch checkpoints after resetting the local database ([Self-hosted LiveSync issue #1020](https://github.com/vrtmrz/obsidian-livesync/issues/1020)).

## 0.1.9

### Fixed

- Fast Fetch now forwards configured CouchDB custom headers to every changes-feed request, allowing reverse proxies such as Cloudflare Access to authenticate initial setup consistently with ordinary replication (PR #82). Thank you to @nimula for the contribution!

## 0.1.8

### Fixed

- Fast Fetch now uses a one-second idle timeout for each finite CouchDB changes page instead of a heartbeat, allowing CouchDB 3.2 to return its terminator after the currently available rows have been persisted.

## 0.1.7

### Fixed

- Fast Fetch now sizes each finite CouchDB changes page from a one-row status probe, counts the returned result together with `pending`, and resumes from the page's opaque `last_seq` without comparing token representations. Heartbeat-enabled feeds no longer wait for future writes after the currently available rows have been persisted.

## 0.1.6

### Fixed

- Fast Fetch now completes only after the captured CouchDB changes target has been persisted, and resumes transient interruptions from the last durable checkpoint. Decryption, protocol, and local write failures stop without finalising an incomplete local database ([Self-hosted LiveSync issue #1065](https://github.com/vrtmrz/obsidian-livesync/issues/1065)).

## 0.1.5

### Changed

- Remote-preferred synchronisation setting reads now report explicit available, not-configured, unavailable, or unsupported outcomes, so clients can distinguish a remote without saved synchronisation settings from one whose settings could not be read.

## 0.1.4

### Added

- The settings schema now includes controls for allowing operating-system sleep during finite synchronisation operations on every platform or on desktop only. Setup URIs preserve both preferences.

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
