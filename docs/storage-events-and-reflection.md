---
date: 2026-09-05
commonlib-version: "0.1.22"
self-hosted-livesync-version: "1.0.25"
status: unreleased
---

# Storage events and database-to-storage reflection

This note separates storage-to-database event handling from
database-to-storage reflection. It describes the unreleased guard against a
stale `DELETE` notification logically deleting Metadata while the same file is
still present in storage. The version fields identify the reviewed release
baselines, not releases which contain this change.

## Processing directions

`StorageEventManager.appendQueue` receives watcher events, applies target and
ignore policies, and queues `CREATE`, `CHANGED`, `DELETE`, or `RENAME` work. A
rename from a selected path to a rejected path becomes a `DELETE` with an
old-path deleted stub and the destination in `FileEventArgs.renameTarget`.
A rename from an excluded path to a selected path becomes a `CREATE`.

`ServiceFileHandlerBase` serialises this work by the canonical document ID
derived from each path. Before a watcher `DELETE` reaches `deleteFileFromDB`,
the handler rechecks current storage under that lock. Rename-derived deletions
lock both source and destination document IDs. This direction updates database
Metadata; it does not remove the physical file from storage.

An event marked `restoredFromPreviousRuntime` is separately revalidated against
current storage and selection before the full offline scan. An ordinary
restored deletion requires current absence; one retaining `renameTarget` uses
the rename-exclusion checks below as well as current source selection. Older
snapshots without that field keep their conservative absence-only rule.

Database-to-storage work follows the opposite direction. Replicated Metadata
reaches `_anyProcessReplicatedDoc`, which applies target and size checks,
obtains a storage stub, and calls `dbToStorage`. Logical deletion, conflicts,
and unsynchronised storage content retain their existing reflection rules.
The watcher guard does not intercept this path or general explicit database
deletion operations.

## Event intent and current storage state

| Event intent | Current storage observation | Admitted operation |
| --- | --- | --- |
| Watcher `CREATE` or `CHANGED` | A selected regular file is present | Keep the existing storage-to-database write. |
| Watcher `DELETE` | A current file resolves to the same canonical document ID, or a folder occupies the path | Suppress the database deletion. |
| Watcher `DELETE` | The host lookup reports no current item, or a file belonging to a distinct document ID | Use the existing deletion operation. |
| Watcher `DELETE` | Lookup fails | Leave the database unchanged; failure is unknown, not absence. |
| `RENAME` converted to `DELETE` | The destination is still selected when case-collision rejection is omitted | Suppress the database deletion. |
| `RENAME` converted to `DELETE` | The destination is deliberately excluded, and the source is absent | Apply the old document's deletion. |
| Case-only `RENAME` converted to `DELETE` | Source lookup resolves to the exact deliberately excluded destination, not the original path | Apply the old document's deletion despite the shared ID. |
| Restored `DELETE` without `renameTarget` | A current item occupies the saved path | Keep the existing restored-event suppression. |
| Replicated logical deletion | Storage contains a file | Keep the existing database-to-storage conflict and preservation rules. |

## Rename exclusion and preservation

The retained destination distinguishes deliberate exclusion from temporary
rejection by the filename collision check, which counts the host's indexed
paths. The handler queries `isTargetFile` with `skipCaseCollisionCheck` only
for that classification; other target policies, built-in exclusions, and the
current file-size limit still apply. This option does not authorise storing a
duplicate file.

A target lookup which resolves to another spelling or a folder is ambiguous
and preserves the database entry. A file recreated at the exact original path
also prevents deletion. The same-ID exception in the table applies only when
source lookup resolves to the exact excluded destination instead.

Suppression leaves storage and Metadata unchanged and records a notice. It
does not automatically write content, schedule a retry, or converge path
spelling. A later scan or event may reconcile the state, subject to its own
policy. The storage lookup may be a host index rather than an operating-system
existence check: the observation is made under the application lock, not in
an atomic filesystem transaction.

## Verification and scope

Focused unit tests cover a current canonical file, absence, lookup failure,
distinct document IDs, retained rename destinations, transient collision
rejection, deliberate exclusion, and source recreation. Live and restored
deletions are exercised separately. A database-to-storage test also verifies
that an incoming logical deletion can still remove unchanged storage content.

These tests do not establish the native watcher event sequence reported in
Issue 1168. Real-runtime verification belongs to the host and must distinguish
observed events from inferred causes. This change does not promise path-case
convergence or full folder-rename support. It does not rewrite the queue,
introduce a retry subsystem, or change the database schema.

The maintained host's real-runtime comparison is recorded in
[Proven in maintained hosts](proven-in-use.md#obsidian-plug-in), separately
from these unit-test guarantees.

## Related documents

- [Full offline scan](offline-scanner.md), especially [Stored event interpretation](offline-scanner.md#stored-event-interpretation).
- [Conflict resolution and file provenance](conflict-resolution.md).
- [Commonlib development](development.md).
