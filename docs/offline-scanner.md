---
date: 2026-09-04
commonlib-version: "0.1.21"
self-hosted-livesync-version: "1.0.24"
status: unreleased
---

# Full offline scan

This document defines the developer contract for `synchroniseAllFilesBetweenDBandStorage`. It describes how the scanner classifies each selected path, chooses an action, and records a database-to-storage reflection. Host-specific setup dialogue and recovery choices remain outside this contract.

Before applying the host's target-file policy, the scanner validates each decoded Metadata document against its actual local document ID. Consistent internal, customisation, and plug-in storage namespaces remain owned by their dedicated features. A namespace disagreement, or a normal-file ID which does not match the ID derived from its recorded path, is quarantined.

The malformed Metadata entry never enters pair processing. If consistent, selected Metadata represents the same case-normalised path, that entry and its storage file continue through the established path-based flow. Otherwise, the storage path is also quarantined. The scanner performs no storage write, database deletion, or last-seen update for an unresolved path, and it retains expired logical deletion history whose identity is inconsistent. This does not add a fourth pair result: quarantined entries do not enter pair processing, and the established Boolean scan result retains its meaning.

`inspectMetadataDocumentIdentities` provides the separate read-only, actual-ID-first report used by a host repair interface. `repairMetadataDocumentIdentity` revalidates one exact source revision, clears its last-seen state, writes and verifies the expected target, and only then tombstones the obsolete ID. It does not provide batch repair. An exact target left by an interrupted attempt permits the same one-entry repair to finish safely.

The tables below cover only paths which remain after identity validation, the host's target-file policy, and Commonlib's built-in exclusions.

## Full-scan lifecycle

`performFullScan` owns the lifecycle around the pair processor:

1. confirm that settings permit the scan;
2. read the scanner's `initialized` marker;
3. when the marker is present, load and complete the stored storage-event operations from the previous runtime;
4. process expired logical deletion history;
5. collect and process the selected storage and database entries;
6. after the first permitted invocation reaches its aggregate-result boundary, record `initialized = true`; and
7. return the aggregate pair result under the caller's selected handling of file failures.

The `initialized` marker records that a full-scan invocation has reached its aggregate-result boundary and that later invocations may restore stored storage-event operations. It is not a successful-scan marker: the first invocation records it after an aggregate `false` result as well as after `true`. An exception before the aggregate result is produced does not reach that write.

Storage-event restoration is a bounded start-up recovery step. Restored events bypass their former batch delay, but `restoreState()` waits for their actual file operations to finish and preserves snapshot sentinel ordering before the file collections are compared. Saved events run first because a deletion or rename can carry operation intent which is no longer visible in the current storage listing. An individual restored operation failure is logged and does not prevent the scan from examining the resulting current state. The following full scan then makes the final reconciliation decision.

This ordering does not mean that storage unconditionally overwrites the replay result. The action matrix remains authoritative: when a replayed operation leaves an ambiguous pair, such as a storage file alongside a deleted database entry, the selected policy may deliberately return `skipped` rather than guess which side is intended. This boundary does not include events which are buffered or received later, and it must not be confused with a host's separate replication-result queue.

### Stored event interpretation

The storage-event snapshot contains operations which the previous runtime observed but had not begun or which were still waiting for their batch boundary. It is not a file-content journal and does not discover changes made while the application was stopped. An operation which had already been removed from the queue and entered file processing is also outside the persisted boundary. The following full scan remains responsible for observing the current storage state across all of these gaps.

A restored event is an operation intent which must be revalidated against the current exact storage path before it can cause a database side effect. Its saved file stub, timestamps, and optional editor cache describe the earlier observation; they are not authoritative file content after a restart. Whenever an inclusion is still applicable, the handler reads a fresh stub and content from current storage. Whenever an absence is contradicted by a current storage item, the corresponding deletion is suppressed and the full scan evaluates that current item instead.

For this check, an exact path means that the canonical path returned by storage has the saved spelling after ordinary separator normalisation. A file returned only through a case-insensitive lookup does not prove the saved inclusion path. A same-ID rename remains the explicit case-change path described below.

The standard-file revalidation contract is:

| Saved operation                         | Current exact storage state                                         | Operation admitted before the full scan                                              |
| --------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `CREATE` or `CHANGED`                   | The path is still a selected regular file                           | Store the current stub and content; do not use saved content as a historical version |
| `CREATE` or `CHANGED`                   | The path is absent, no longer selected, or no longer a regular file | Do not replay the inclusion                                                          |
| `DELETE`                                | The selected path remains absent                                    | Apply the saved path's deletion intent                                               |
| `DELETE`                                | Any current storage item occupies the path                          | Suppress the stale deletion                                                          |
| `RENAME` between distinct document IDs  | The new selected path exists                                        | Admit the inclusion half using the new path's current stub and content               |
| `RENAME` between distinct document IDs  | The old selected path is absent                                     | Admit the deletion half for the old path                                             |
| `RENAME` between distinct document IDs  | Either half is contradicted by current storage                      | Suppress only that half; the other independently validated half may proceed          |
| Case-only or otherwise same-ID `RENAME` | A current selected file resolves to the renamed canonical path      | Update that single document's path and current content without a separate deletion   |
| Case-only or otherwise same-ID `RENAME` | The current identity does not support the saved rename              | Do not replay the rename; let the full scan evaluate the current path                |

An inability to inspect the current path is not proof of absence. Revalidation therefore suppresses a destructive half when storage inspection fails, records the failure, and leaves the following scan to report whether reconciliation can proceed. Target-file policy and file-size limits are evaluated from current settings rather than inherited from the saved event.

Independent validation of rename halves does not remove target-first execution. When the new path currently exists, its inclusion must finish successfully before the old-path deletion may run. A failed inclusion preserves the old database entry. When the new path is currently absent, there is no inclusion to publish, and a separately validated absence at the old path may be applied as deletion intent.

`INTERNAL` operations remain owned by the host feature which registered the optional-file handler. That owner must read its current internal storage state; the ordinary file-pair scan does not make a recovery guarantee for an internal path. `SENTINEL_FLUSH` carries ordering only and never represents file state.

The full scan is not a transaction. Expired deletion history may be updated before a later pair fails, and the device-local last-seen map is saved asynchronously after pair processing. The aggregate result does not promise rollback of those earlier side effects or durable completion of that deferred map save.

## Pair states

| State             | Storage             | Local database                   |
| ----------------- | ------------------- | -------------------------------- |
| `both`            | File exists         | Live metadata entry exists       |
| `storage-only`    | File exists         | No metadata entry exists         |
| `db-only`         | File does not exist | Live metadata entry exists       |
| `both-db-deleted` | File exists         | Entry records a logical deletion |
| `db-only-deleted` | File does not exist | Entry records a logical deletion |

A metadata entry with live conflicts is skipped before the ordinary action is selected. It must not be applied to storage by a full scan.

## Option predicates

The action matrix uses these predicates:

- `delete-when-remote-missing` is enabled by `ExtraOnRemote.DELETE_LOCAL_MISSING` or `ExtraOnLocal.DELETE_DB_MISSING`;
- `delete-when-remote-deleted` is enabled by `ExtraOnRemote.DELETE_LOCAL_MISSING`, `ExtraOnLocal.DELETE_DB_DELETED`, or `ExtraOnLocal.DELETE_DB_MISSING`; and
- `append-storage-only` is enabled by `ExtraOnLocal.APPEND_STORAGE_ONLY`.

These names explain the table only. The source constants remain the API.

## Action matrix

| Pair state        | `DB_APPLY`                                                         | `NEWER_WINS`                                                                                                  |
| ----------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| `both`            | `update-storage`                                                   | `sync-newer`                                                                                                  |
| `storage-only`    | `delete-local` when `delete-when-remote-missing`; otherwise `skip` | `delete-local` when `delete-when-remote-missing`; otherwise `update-db`                                       |
| `db-only`         | `update-storage`                                                   | `update-storage`, subject to the device-local offline-deletion override described below                       |
| `both-db-deleted` | `delete-local` when `delete-when-remote-deleted`; otherwise `skip` | `delete-local` when `delete-when-remote-deleted`; otherwise `update-db` when `append-storage-only`, or `skip` |
| `db-only-deleted` | `skip`                                                             | `skip`                                                                                                        |

`NEWER_WINS` changes a `db-only` action to `delete-db` only when the device-local last-seen map proves that the file existed on an earlier scan and that observed storage mtime is not older than the database mtime under `compareMTime`. This represents a file deleted while the scanner was offline. A database mtime copied from a failed reflection is not such evidence.

The Cartesian `resolveFilePairAction` unit test is the executable counterpart of this matrix. Change the implementation, table, and test together.

## Pair processing result

Each selected pair finishes in one of three states:

| Result      | Meaning                                                                               | Complete-scan result |
| ----------- | ------------------------------------------------------------------------------------- | -------------------- |
| `completed` | The selected action completed, or storage and the database were already equal         | Success              |
| `skipped`   | Scanner policy deliberately left the pair unchanged                                   | Success              |
| `failed`    | The selected action could not complete, returned a failure result, or raised an error | Failure              |

Conflict guards, size limits, and the explicit `skip` action produce `skipped`. They allow the scan to finish successfully, but do not establish that database content was reflected to storage. In particular, skipping a `db-only` entry must not copy its database mtime into the device-local last-seen map.

An actual storage file remains valid evidence of its own observed mtime even when another action for that pair is skipped. This is distinct from recording the database mtime after a successful database-to-storage reflection.

## Database-to-storage reflection result

When `update-storage` invokes `dbToStorage`, its result controls every success side effect:

| `dbToStorage` outcome | Pair result | Success event and log | Last-seen entry for the database mtime | Later `NEWER_WINS` scan                           |
| --------------------- | ----------- | --------------------- | -------------------------------------- | ------------------------------------------------- |
| `true`                | `completed` | Emitted               | Recorded                               | May recognise a later absence as a local deletion |
| `false`               | `failed`    | Not emitted           | Not recorded                           | Retries `update-storage` while the file is absent |
| Throws                | `failed`    | Not emitted           | Not recorded                           | Retries after the failed scan can be run again    |

The same result applies when `sync-newer` finds an existing storage file and attempts to reflect a newer database entry. A `false` result must not be converted into `completed`, emit a success event, or replace the observed storage mtime with the database mtime.

By default, the complete scan returns `false` when any pair is `failed`, and returns `true` when every pair is either `completed` or `skipped`. Quarantined entries do not enter this aggregate, so a strict `true` means that no selected pair failed rather than that every discovered entry was resolved or that storage and the database fully converge.

`continueOnFileFailure` is an explicit host completion policy. When it is `true`, the scanner still processes every selected pair, records each failed path in its unresolved warning, preserves every failed pair and its retry state, and then returns `true` from the aggregate boundary. A later scan which processes every selected pair successfully clears that warning. The option does not turn a failed pair into `completed`, create success events or last-seen evidence, bypass a rejected scan precondition, or accept an exception raised before the aggregate boundary.

Self-hosted LiveSync enables this policy only for ordinary Obsidian start-up, where one unavailable path must not prevent unaffected files from synchronising. Fast Setup, Fetch, Rebuild, direct scans, and CLI mirror or daemon paths retain the strict default.

## Result-state verification

Focused two-pass coverage starts with a `DB_APPLY` reflection whose file handler returns `false`, persists the resulting scanner state, and then runs `NEWER_WINS`. It verifies that:

- both scans report failure;
- the failed path is retried through `dbToStorage`;
- no success event or success log is emitted;
- the database mtime does not enter the last-seen map; and
- `deleteFileFromDB` is not called.

Full-scan coverage also verifies that the strict default returns `false`, an ordinary-start-up scan which explicitly continues returns `true` without losing the warning which lists the affected path, and a later clean scan clears that warning.

A second two-pass case starts with a `db-only` entry skipped by the size limit. It then removes that limit and verifies that the entry is reflected to storage rather than misclassified as an offline local deletion. Coverage for an existing storage file verifies that a failed `sync-newer` reflection retains the observed storage mtime, and full-scan coverage verifies that the aggregate failure reaches its caller after scanner initialisation completes.

Identity coverage verifies early quarantine when no consistent target exists, continued processing when consistent Metadata represents the same logical path, expired-deletion retention, special-namespace routing, actual-ID-first inspection, stale and ambiguous repair rejection, target-first ordering, exact-target retry, source preservation after failure, and last-seen clearing.

Stored-event coverage verifies that current storage content replaces saved observations, a recreated path suppresses a stale deletion, distinct-ID rename halves are admitted independently from current path state, and a same-ID rename never performs a separate deletion. It also verifies that a storage-inspection failure does not become evidence for a destructive operation and that an individual replay failure does not prevent the full scan from running.

Maintain that interaction boundary when changing file-handler results, last-seen persistence, Fast Setup reflection, or offline deletion detection.
