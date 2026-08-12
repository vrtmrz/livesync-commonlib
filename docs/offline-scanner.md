# Full offline scan

This document defines the developer contract for `synchroniseAllFilesBetweenDBandStorage`. It describes how the scanner classifies each selected path, chooses an action, and records a database-to-storage reflection. Host-specific setup dialogue and recovery choices remain outside this contract.

Before applying the host's target-file policy, the scanner validates each decoded Metadata document against its actual local document ID. Consistent internal, customisation, and plug-in storage namespaces remain owned by their dedicated features. A namespace disagreement, or a normal-file ID which does not match the ID derived from its recorded path, is quarantined.

The malformed Metadata entry never enters pair processing. If consistent, selected Metadata represents the same case-normalised path, that entry and its storage file continue through the established path-based flow. Otherwise, the storage path is also quarantined. The scanner performs no storage write, database deletion, or last-seen update for an unresolved path, and it retains expired logical deletion history whose identity is inconsistent. This does not add a fourth pair result: quarantined entries do not enter pair processing, and the established Boolean scan result retains its meaning.

`inspectMetadataDocumentIdentities` provides the separate read-only, actual-ID-first report used by a host repair interface. `repairMetadataDocumentIdentity` revalidates one exact source revision, clears its last-seen state, writes and verifies the expected target, and only then tombstones the obsolete ID. It does not provide batch repair. An exact target left by an interrupted attempt permits the same one-entry repair to finish safely.

The tables below cover only paths which remain after identity validation, the host's target-file policy, and Commonlib's built-in exclusions.

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

| Result      | Meaning                                                                                 | Complete-scan result |
| ----------- | --------------------------------------------------------------------------------------- | -------------------- |
| `completed` | The selected action completed, or storage and the database were already equal          | Success              |
| `skipped`   | Scanner policy deliberately left the pair unchanged                                    | Success              |
| `failed`    | The selected action could not complete, returned a failure result, or raised an error   | Failure              |

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

The complete scan processes every selected pair and returns `false` when any pair is `failed`. It returns `true` when every pair is either `completed` or `skipped`. `performFullScan` preserves that aggregate result after completing scanner initialisation. Self-hosted LiveSync uses the direct aggregate result for its Fast Setup recovery choice, while its CLI mirror and daemon paths use the full-scan result. A host which deliberately finalises after a failed scan still owns that policy; Commonlib must not convert the failed reflection into evidence that a local file once existed.

## Result-state verification

Focused two-pass coverage starts with a `DB_APPLY` reflection whose file handler returns `false`, persists the resulting scanner state, and then runs `NEWER_WINS`. It verifies that:

- both scans report failure;
- the failed path is retried through `dbToStorage`;
- no success event or success log is emitted;
- the database mtime does not enter the last-seen map; and
- `deleteFileFromDB` is not called.

A second two-pass case starts with a `db-only` entry skipped by the size limit. It then removes that limit and verifies that the entry is reflected to storage rather than misclassified as an offline local deletion. Coverage for an existing storage file verifies that a failed `sync-newer` reflection retains the observed storage mtime, and full-scan coverage verifies that the aggregate failure reaches its caller after scanner initialisation completes.

Identity coverage verifies early quarantine when no consistent target exists, continued processing when consistent Metadata represents the same logical path, expired-deletion retention, special-namespace routing, actual-ID-first inspection, stale and ambiguous repair rejection, target-first ordering, exact-target retry, source preservation after failure, and last-seen clearing.

Maintain that interaction boundary when changing file-handler results, last-seen persistence, Fast Setup reflection, or offline deletion detection.
