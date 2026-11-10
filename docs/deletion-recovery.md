---
date: 2026-11-10
commonlib-version: "0.4.1"
self-hosted-livesync-version: "1.0.47"
status: accepted; unreleased
---

# Recovering unapplied logical deletions

An ordinary scan can recover a received deletion which reached the local database
but did not remove its unchanged Vault file. This is an opt-in host capability;
it does not change incoming reflection, explicit Fetch, or forced Inspector
operations. The implementation is unreleased.

## Host contract

Supply provenance with `listPaths` in addition to its existing operations.
`StoredFileReflectionProvenance(store, true)` enables keys-only enumeration from
the host's existing namespaced store. Default construction retains the existing
behaviour. Construction registers the optional function without store access;
the scanner invokes it only when absent deletion candidates need inspection.
The store must enumerate its whole namespace, preserve Unicode paths, and
propagate failures. No new index, journal, schema, or retry timer is used.

The file-handler facade supplies a synchronous capability check, enumeration,
and `recoverDatabaseDeletion(expected, cleanupOnly)`. The result distinguishes
`status` (applied, deferred, failed), observed file state (present, absent,
unknown), provenance state (unchanged, cleared, pending), and diagnostic reason.
A post-removal storage error can be retained as a warning without claiming that
the file remains present. The host owns aggregate presentation.

The result is a union of coherent observations:

| Result subtype | Status | Observed file | Provenance |
| --- | --- | --- | --- |
| `DeletionRecoveryUnchangedResult` | deferred or failed | present, absent, or unknown | unchanged |
| `DeletionRecoveryCleanupPendingResult` | deferred or failed | absent | pending |
| `DeletionRecoveryRemovalUnconfirmedResult` | failed | unknown | pending |
| `DeletionRecoveryClearedResult` | applied or failed | absent | cleared |

Only confirmed absence and cleared provenance permit `applied`. A subsequent
lock or permit release failure can report `failed` while retaining those confirmed
effects. Neither a failure nor a deferral rolls back an observed removal. Pending
cleanup and unconfirmed removal retain evidence for later observation; a deferred
unchanged file can remain protected indefinitely until its content is reconciled.

## Selection and protection

Only ordinary `NEWER_WINS` without extra policies adds recovery. Present-file
candidates require valid retained logical-deletion Metadata, no current conflict,
and newer database mtime under the existing comparison. Equal-time,
storage-newer, tombstoned, quarantined, and excluded paths keep their policy.
Freshness is a filter; recorded content evidence proves unchanged bytes.

Currentness uses the exact database document ID and revision, the host-resolved
path identity, and a fresh conflict query. Enumeration can retain a stored path
spelling which a lookup reconstructs differently, so raw path-string equality is
not an identity check. Metadata timestamps and sizes belong to the immutable
revision; re-comparing or rounding those fields adds no identity evidence.

Filesystem timestamp precision belongs to the host's freshness policy. Separate
snapshot checks retain raw path, type, mtime, ctime, and size across storage reads;
rounding those observations could hide an intervening change. Matching statistics
still do not establish content equality: recovery independently compares bytes.

Acquire one of three shared recovery permits before the document lock and all
body/Chunk work. The scanner retains its existing ten admission slots; permits
are not three additional workers. Completed slots admit later files immediately,
so one slow file does not form a three-file batch barrier. Same-document locks
and the shared hash semaphore retain their existing policy.

Read provenance strictly. Missing provenance and supported size mismatch defer
before reading bodies. A supported hash mismatch requires at most one body read
and causes no history lookup or preservation write. Legacy evidence reads only
the exact recorded revision through the normal Chunk pipeline: existing transport,
suppression, delivery waiting, throttling, and Fetcher retries remain authoritative.
An opaque false legacy-read result is failed verification, not remote absence.
Fetched Chunks can be persisted normally; recovery never appends Metadata or
creates a conflict branch merely to acknowledge a deletion.

The successful path captures one current body and compares one final fresh body,
revalidating raw stats, provenance, the exact current deletion, conflicts, target,
and freshness. Keep the final checks adjacent to removal. Locks do not exclude
external editors or replication, and these stores are not a cross-store
transaction. No guarantee extends to edits after the last observation.

## Removal and interrupted cleanup

Confirm storage absence after the removal call, including after an exception or
selection no-op. Clear provenance only for a still-absent target with the same
current deletion and unchanged provenance. Failed cleanup does not roll back
physical removal or trigger another physical deletion.

For retained deleted Metadata with an absent file, enumerate provenance keys once
per scan and intersect them with the collected pairs and loaded last-seen map.
Process that intersection as cleanup-only work before new candidate deletions.
Fresh checks under the document lock protect recreated files and restorations.
A remaining provenance key rediscovers interruption before cleanup; a persisted
last-seen entry rediscovers interruption before its removal was flushed. Retention
and reset which remove the logical Metadata remain outside this discovery scope.

Keep last-seen state and pending writes scoped to the host store, serialise
overlapping scans of that store, and coalesce recovery changes in memory. Confirmed
absence removes the entry, present/deferred files retain ordinary observed mtime,
and unknown effects do not certify absence. Await one final ordered map flush.
Failures are reflected in the scan's existing strict/continue-on-file-failure
result contract. A deferred result is not convergence.

## Cost and verification

When no present or absent deletion candidate exists, recovery adds no body reads,
key enumeration, or per-path writes. Absent deleted pairs add one keys-only
namespace query even when no cleanup remains. Its cost grows with key count.
Stable supported-hash deletion targets two current-body reads, one removal, and
one provenance deletion; legacy delivery and Chunk persistence have separate costs.
Recovery never requests a whole-map write per candidate. Three operations can
retain multiple bodies and comparison buffers; memory is not bounded to three
file sizes. Repeated deferred scans can reread bodies; there is no hidden retry
loop or eligibility cache.

Regression coverage starts with an unchanged newer-deleted file and no received
snapshot, failing on the original scanner. Verify exact contents and revision
history, same-stat edits, pruned/legacy/hash evidence, mid-attempt restoration and
conflicts, removal no-op, post-removal errors, cleanup/read/flush failures, and
restart discovery. Verify one blocked file permits later small files to complete,
three large files and overlapping calls respect the cap, and every error releases
its permit. Count body, Chunk, Metadata, provenance, namespace, and map operations
separately. Physical iPhone performance remains a separate measurement.
