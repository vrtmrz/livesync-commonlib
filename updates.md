# Updates

## Unreleased

## 0.1.22

### Fixed

- An ordinary host start-up may explicitly continue after individual offline-scan file failures without marking those pairs as completed or losing their retry state. Affected paths are logged at verbose level, while recovery and CLI scans retain strict completion by default ([Self-hosted LiveSync issue #1164](https://github.com/vrtmrz/obsidian-livesync/issues/1164)).
- Database-preparation failures now log their stage at verbose level and leave user-facing notices to the host, while replication reports incomplete application initialisation instead of the bare 'Not ready' diagnostic.

## 0.1.21

### Changed

- User-initiated OneShot requests now choose an explicit `quiet` or `notice` progress presentation independently of interaction authority. `UserInitiatedOneShotRequest.progressPresentation` is required, and `ReplicationFailureRequest.progressPresentation` replaces `showMessage` so failure handling retains the caller's presentation choice.

### Fixed

- OneShot admission is now reserved before the first asynchronous readiness check. Additional user-initiated or unattended requests while an attempt is active settle immediately with `replication-in-progress` instead of queuing another replication after it completes.

## 0.1.20

### Added

- New focused `@vrtmrz/livesync-commonlib/replication` and `@vrtmrz/livesync-commonlib/p2p` package entries expose provider definitions, explicit capability availability, opaque configuration identities, interaction authority, typed replication outcomes, owned finite remote resources, optional central-remote administration, and eight focused P2P service views through package-tested boundaries.
- A packaged developer guide now explains when to use Service handlers, service features, ServiceModules, private feature contexts, and focused resource owners.

### Changed

- Active Replicator publication is now bound to a provider-owned configuration identity. A changed effective configuration fences new admissions, requests supported transfer cancellation, drains admitted work, closes the previous instance, and only then publishes its replacement. An unchanged identity retains the current instance, and stale asynchronous candidates are discarded.
- User-initiated, unattended, continuous, and stop operations now have separate capability and interaction contracts. Finite work must report explicit completion, while continuous start retains the legacy permissive `void` settlement only when the provider declares support. `ActiveReplicatorContext.configurationIdentity` is now required, and Replicator termination and closure may settle asynchronously.
- Replication failure handling now retains the exact failed publication, detached settings, outcome, and interaction authority, preventing a later replacement Replicator from being used to interpret or recover an earlier attempt.
- P2P now uses one stable service and room-session owner for persistent demand, finite transfers, connection-probe admission, automatic start, replacement, cancellation, and lifecycle reopening. P2P-only participates as a first-class finite Replicator without claiming central-remote milestones or administration.
- Transitional RPC calls now support abort signals and cancellation-aware handlers. Cancellation is cooperative and does not roll back work which has already settled.

### Fixed

- Journal synchronisation-parameter and milestone reads now distinguish confirmed absence from an unavailable Object Storage backend. Unavailability is propagated and cannot initialise replacement control data or a new Security Seed; stale cached control reads and retired clients are also fenced ([Self-hosted LiveSync issue #1147](https://github.com/vrtmrz/obsidian-livesync/issues/1147)).
- Failed P2P replication results now preserve a JSON-safe error code, message, and details across RPC instead of losing native `Error` properties as an empty object.
- Cancelled or partially failed shim replication no longer advances checkpoints beyond an unsettled batch. Missing source revisions and failed bulk writes are reported explicitly.

## 0.1.19

### Fixed

- Reset and rebuild workflows now reset the local database selected by the resulting settings, rather than whichever database wrapper was already active. During a suffix transition, this prevents a database which was not reset from reopening with stale content. Failures stop before rebuilt events, remote resets, or uploads (Self-hosted LiveSync issue #1126).
- Rejected or incomplete database initialisation no longer leaves either the physical database or the application marked as ready. Vault scanning and completion hooks now form explicit readiness boundaries, and direct file manipulation rejects an unaccepted database initialisation.

### Improved

- Restored storage events are now revalidated against current exact storage paths before replay. Current file contents replace saved observations, stale deletions are suppressed, and rename halves are admitted only when their current path state supports them.

## 0.1.18

### Added

- P2P profiles can now select an outgoing RPC message bound through `P2P_maxWirePayloadBytes`. `P2PMessageSizePresets` provides Standard (15,360 bytes), Reduced (2,048 bytes), Conservative (1,024 bytes), and Maximum compatibility (800 bytes), while omitted or invalid values retain the established Standard behaviour. This gives constrained WebRTC paths a supported alternative to modifying installed package code. Thank you to @andrewschreiber for the detailed diagnosis and reproducible workaround in [issue #97](https://github.com/vrtmrz/livesync-commonlib/issues/97).
- P2P profiles can select automatic ICE routing or require a configured TURN relay through `P2P_connectionPath`. Relay-only routing is effective only when at least one syntactically valid `turn:` or `turns:` URL is present. P2P connection strings and QR-encoded settings retain both compatibility choices.

### Improved

- A serving P2P transport is now recreated when its effective message bound or connection path changes. Repeated opens with unchanged compatibility settings remain idempotent.

## 0.1.17

### Added

- `storeWithLiveBaseRevision()` conditionally stores content below an exact current revision-tree leaf using PouchDB's ordinary revision check. Maintained hosts can therefore create a successor without force-writing below a stale base, while the existing `storeWithBaseRevision()` operation retains its deliberate force-write behaviour.

## 0.1.16

### Improved

- CouchDB connection handling is now more robust through the flat `OwnedCouchDBConnection` contract. Its idempotent `close()` cancels abort-capable requests before closing PouchDB. If the complete one-shot preflight remains unsettled for 60 seconds on the web-compatible fetch path, an internal safety fuse ends the attempt, releases its shared operation, and closes the temporary connection before a later trigger can try again. This is not a limit on replication duration. The explicitly selected native Request API retains its existing behaviour because that adapter cannot currently honour transport cancellation.

## 0.1.15

### Fixed

- Start-up offline scans are now faster when Path Obfuscation is enabled.

## 0.1.14

### Fixed

- Commonlib now closes the temporary CouchDB connections it creates for finite remote operations, including one-shot replication, Security Seed refreshes, chunk transfer, maintenance operations, and status queries. Continuous replication closes its previous connection before a retry or restart, while caller-provided connections remain under caller ownership. Connection set-up failures also close the partially initialised handle without masking the original connection error (PR #112). Thank you to @apple-ouyang for the contribution!

## 0.1.13

### Fixed

- Generated packages now declare root and subpath TypeScript mappings derived from the same public export inventory. TypeScript's `Node10` module resolution therefore finds the intended declarations instead of treating valid Commonlib imports as unresolved `error` types in downstream tooling.
- `octagonal-wheels` 0.1.53 is now the minimum dependency, bringing equivalent declaration mappings to its public entries.

## 0.1.12

### Fixed

- Fast Fetch now writes deletion tombstones to the local database without attempting to decrypt them. A tombstone has no encrypted payload, and decryption previously aborted the whole fetch at the first deleted document. New devices could not complete their initial sync on vaults that contain old deletions ([Self-hosted LiveSync issue #1099](https://github.com/vrtmrz/obsidian-livesync/issues/1099); PR #108). Thank you to @KennethLloyd for the contribution!
- Offline scans now validate each Metadata document against its actual database ID before pairing it with storage. An inconsistent entry is left unchanged and cannot trigger reflection, deletion, or last-seen updates; a separate, consistent entry for the same logical path continues normally. Maintained hosts can inspect the mismatch by actual ID and explicitly repair one unambiguous entry at a time.

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
