---
date: 2026-10-26
commonlib-version: "0.2.1"
self-hosted-livesync-version: "1.0.40"
status: published
---

# Storage events and database-to-storage reflection

This note separates storage-to-database event handling from
database-to-storage reflection. It documents the current guard against a stale
`DELETE` notification logically deleting Metadata while the same file is still
present in storage, and the accepted local completion contract for queued file
operations. The version fields identify the original reviewed source versions.

> Publication note (9th November, 2026): This implementation, including the
> [ordinary-file retry extension](#retrying-ordinary-file-operations), is included
> in published [Commonlib 0.4.1](https://github.com/vrtmrz/livesync-commonlib/releases/tag/0.4.1).
> The original review date and version baseline are retained above. Host
> applications adopt this package through their own dependency updates.

> Update note (23rd November, 2026): The persistence, dispatch, and unload
> contracts described below include unreleased Commonlib Step 1 work for
> [Issue 1380](https://github.com/vrtmrz/obsidian-livesync/issues/1380).
> The original review baseline and the publication note above record their
> respective releases.

## Event-manager terminology

Hosts normally supply an adapter and, where necessary, override protected
`StorageEventManagerBase` hooks. The responsibility modules implement the shared
pipeline; hosts do not need to call every helper directly. Their TSDoc describes
inputs, completion boundaries, state changes, and persistence preconditions for
maintainers who extend or reuse them.

| Term                | Meaning in this implementation                                                                                                       |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Facade              | The host-facing class which connects adapters and overridable hooks to the shared functions.                                         |
| Watcher             | The host integration which receives file or editor change notifications.                                                             |
| Admission           | Filtering a received event and registering its operation. Its completion does not await the file handler.                            |
| Operation           | The accepted event intent whose identity survives failed attempts until completion is durably acknowledged.                          |
| Attempt             | One execution of an operation, with its own result and completion promise.                                                           |
| Ownership           | The identity relationships which determine which operation and attempt may acknowledge retained work.                                |
| Batching            | Delaying eligible content events so related updates can be processed together.                                                       |
| Gate                | A promise deciding whether a waiting operation may proceed or has been covered by a successor. Opening it is not handler completion. |
| Coalescing          | Combining pending intents by making an earlier operation depend on the result of a successor which covers it.                        |
| Prerequisite        | A related operation whose captured attempt must succeed before the dependent handler can run.                                        |
| Ordered predecessor | An earlier operation which must settle before an ordered event proceeds, even if the earlier result is a failure.                    |
| Boundary            | The finite selection of operations, admissions, or observed failures relevant to one request.                                        |
| Sentinel            | A queue marker before deletion or rename which waits only for earlier operations.                                                    |
| Dispatch            | Taking buffered events and starting their processing; it does not itself establish durable completion.                               |
| Flush               | Releasing delays and waiting for the captured local completion boundary. It does not establish remote replication.                   |
| Snapshot            | The saved pending event intents. It is not a backup of every intermediate file body.                                                 |
| Reconciliation      | Re-evaluating intent against current storage, database state, and provenance before choosing an effect.                              |
| Retry               | Starting a new eligible attempt while preserving the result already observed by an earlier caller.                                   |
| Effects             | Explicit callbacks for stateful work or I/O, separated from functions which only construct a plan.                                   |
| Type guard          | A runtime predicate which also narrows the value's TypeScript type before it is used.                                                |

## File-event structure and ownership

The pipeline uses several related types. Their declarations are the source of
truth; the following map explains which layer owns each value.

```text
Host FileEvent
  -> admission and selection -> FileEventItem
  -> PendingFileEvent -> FileEventAttempt (one result per attempt)
  -> handler(original event or transient ReconcileFileEvent)

Snapshot: original FileEventItem | FileEventItemSentinel
```

### Host notification: `FileEvent`

[`FileEvent`](../src/interfaces/StorageEventManager.ts) is the input to
`appendQueue()`. It contains `type`, `file`, and optional `oldPath`,
`cachedData`, `skipBatchWait`, and `cancelled` fields. Admission filters the
notification before creating a queue item; completion of `appendQueue()` means
admission has finished, not that its file effect has completed.

The event types are `CREATE`, `CHANGED`, `DELETE`, `RENAME`, and `INTERNAL`.
The ordinary file stub has `path`, `name`, and `stat` (`ctime`, `mtime`, `size`,
and `type`). An internal-file stub instead has `isInternal: true` and
`stat: undefined`; a path does not imply that storage statistics are available.
Neither stub contains the file body. A `UXFileInfo` additionally carries a
`Blob` body when content has actually been read.

### Retained intent: `FileEventItem`

[`FileEventItem` and `FileEventArgs`](../src/common/models/fileaccess.type.ts)
are the queue and snapshot shapes:

| Field                          | Meaning                                                                                                                                                                |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `type`                         | The selected operation type, which can differ from the host notification after rename filtering.                                                                       |
| `args.file`                    | The ordinary or internal-file observation. A rename uses the destination observation; a source-only selected rename becomes a deletion with a source-path observation. |
| `args.oldPath?`                | The source path for a retained `RENAME`.                                                                                                                               |
| `args.renameTarget?`           | The destination of a rename converted into source-only `DELETE`, retained for exclusion and preservation checks.                                                       |
| `args.cache?`                  | Optional in-memory cached text or `ArrayBuffer`. Admission maps host `cachedData` here.                                                                  |
| `args.ctx?`                    | Opaque host context passed to `appendQueue()` and forwarded verbatim to the handler and persistence adapter. Hosts own `args.ctx` serialisability and immutability. |
| `key`                          | A generated event label. Operation ownership and acknowledgement use event/attempt identity, not equality of this string or path.                                      |
| `restoredFromPreviousRuntime?` | `true` on a replayed event; selects current-state revalidation. Restoration adds this marker and `skipBatchWait` to loaded file events.                                |
| `skipBatchWait?`               | Bypass the intentional batch delay; processing and snapshot acknowledgement must still complete.                                                                       |
| `cancelled?`                   | A queue-item cancellation marker. The handler rejects it rather than confirming an unperformed effect. It is not a successful completion result.                       |
| `batched?`                     | An optional field retained in the shared type for compatibility. The current manager owns batching through gates and attempt dependencies.                             |

Admission copies the selected type, file arguments, host context, cache, and
batch-wait policy. It does not copy the host `cancelled` field into the new
item. The declared host and queue shapes therefore must not be treated as
interchangeable objects.

For example, an ordinary rename retains these path relationships:

```ts
{
    type: 'RENAME',
    key: 'generated-event-label',
    args: {
        file: { path: 'new.md', name: 'new.md', stat: currentStat },
        oldPath: 'old.md',
    },
}
```

If only `old.md` is selected, admission emits `DELETE` with
`args.file.path: 'old.md'` and `args.renameTarget: 'new.md'` instead. This
preserves the relationship without treating the excluded destination as an
ordinary synchronisation target.

### In-memory operation and attempts

[`PendingFileEvent` and `FileEventAttempt`](../src/managers/StorageEventManager/operations.ts)
are manager-local state. The operation retains its original `event`, insertion
`sequence`, admission time and failure boundary, path predecessors, related
prerequisites, ordering barrier, and current `attempt`. It survives a failed
attempt. The attempt owns its completion promise, result, start state, captured
dependency attempts, retry cutoff, and any admission failure. A retry replaces
the current attempt, leaving earlier callers attached to their original
result. These maps, promises, and counters are not the persisted event schema.

[`PendingSnapshotEntry`](../src/managers/StorageEventManager/state.ts) links an
event to its operation and durable acknowledgement state. Its exact entry and
attempt identities must still match before acknowledgement. A
`FileEventItemSentinel` contains only `{ type: 'SENTINEL_FLUSH' }` and orders
preceding work. Snapshots contain sanitised file intents and sentinels. A new
manager reconstructs insertion and attempt state during restoration.

### Transient reconciliation request

[`ReconcileFileEvent`](../src/common/models/fileaccess.definition.ts) is a
shallow copy of a valid `FileEventItem` branded by a private symbol. Construct
it with `createReconcileEvent()` and inspect it with `isReconcileEvent()`.
Its arguments are shared with the original event. It selects current-state
reconciliation for a running-session retry, while the manager continues to
persist the original event. The symbol is not a persisted format or a new
operation. Restart replay uses `restoredFromPreviousRuntime` separately.

An event records intent. Current storage, database effects, and revision
provenance determine what is still necessary when its handler executes; the
saved stub, cache, and event label cannot establish completion by themselves.

## Processing directions

`StorageEventManager.appendQueue` receives watcher events, applies target and
ignore policies, and queues `CREATE`, `CHANGED`, `DELETE`, or `RENAME` work.
Starting with [Commonlib 0.7.0](../updates.md#070), a host can provide
`isTargetInternalFile` in `StorageEventManagerBaseDependencies` to admit
`INTERNAL` events separately from the ordinary `syncOnlyRegEx` allow-list
and `syncInternalFiles` gate. The host callback determines internal-file
eligibility within the manager's protected-path checks. For example, it can use
`vaultService.isTargetFile(path, { internalFileEvent: true })`. Hosts without the
callback use the ordinary admission path. A rename from a selected path to a
rejected path becomes a `DELETE` with an old-path deleted stub and the destination
in `FileEventArgs.renameTarget`.
A rename from an excluded path to a selected path becomes a `CREATE`.

`renameTarget` is recorded only when one incoming `RENAME` is converted in
this way. It is not inferred by pairing independent `CREATE` and `DELETE`
notifications. A `DELETE` without it cannot establish that a current same-ID
file is the deliberately excluded destination of a rename. The ordinary
current-storage check therefore suppresses that deletion, even when the
current file's path would itself be excluded from synchronisation.

`ServiceFileHandlerBase` serialises this work by the canonical document ID
derived from each path. Before a watcher `DELETE` reaches the database deletion core,
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
obtains a storage stub, and enters the reflection core under the same lock. Logical deletion, conflicts,
and unsynchronised storage content retain their existing reflection rules.
The watcher guard does not intercept this path or general explicit database
deletion operations.

The public `ServiceFileHandlerBase` import and operation signatures remain the
host integration boundary. Its responsibility functions live in the sibling
`ServiceFileHandlerBase/` implementation directory. Internal event processing
reuses already-held locks, so it does not call the public wrappers which acquire
those locks. The [developer guide](development.md#ordinary-file-handler-implementation)
records the module responsibilities and existing override boundaries.

## Startup scans and pending operations

The full scanner's optional `strictContentCheck: false` path is gated by the host's file-operation state. Any related queued, running, or failed operation blocks the `canSkipUnchangedFile` hint. The host must provide an available query before the scanner can establish that no related work exists; without that query or other required evidence, strict content comparison remains active. The hint is considered only after normal freshness comparison reaches `EVEN`, and requires the raw mtime to exactly match the recorded provenance value; a match within the platform comparison bucket is insufficient. `BASE_IS_NEW` and `TARGET_IS_NEW` retain their timestamp-directed reflection and last-seen bookkeeping. A pair returned as `SKIPPED` by this hint does not acknowledge or remove a saved event. Event work continues to follow the snapshot and handler-completion contract below. This option affects only the full-scan same-stat check; ordinary watcher `CREATE` and `CHANGED` handling, replicated writes, and logical-deletion protection retain their existing rules. See [Full offline scan](offline-scanner.md#startup-content-checking) for the full option and eligibility conditions.

## Pending operations and local completion

Once admitted, a file operation remains pending while buffered, waiting for its
batch boundary, or running in a handler. The manager includes all three states
in its pending-intent store. The handler starts only after the admission
write commits. Its effect must be durable locally, already represented,
covered by a successful successor, or skipped under an explicit handler
policy before the manager can acknowledge it.

The serial writer coalesces eligible requests into a detached commit batch.
Changes arriving during a write enter a later batch. The writer plans
provisional acknowledgements privately, so `hasPendingFileEvent()` and the
pending count continue to include the operation until the write commits. A
failed write leaves the pending intent available for retry and rejects the
callers that relied on that commit. Stale completions and admission failures
settle individually. An older attempt can acknowledge only the intent it
still owns.

The manager saves a copy of the operation intent with `args.ctx`. It omits
`args.cache`, `restoredFromPreviousRuntime`, and `skipBatchWait` while
preserving the live event object. When a `CREATE` or `CHANGED` operation
becomes eligible, the handler rechecks the path and obtains its current
content. Replay adds the transient restore flags and revalidates the intent
against current storage and selection. The current-storage deletion checks
and rename-exclusion rules below continue to apply.

A restored deletion whose database entry is already absent or deleted completes
without another revision. A restored rename whose source deletion is already
represented reconciles the current target through the ordinary non-forced
handler. The same applies to a case-only rename when Metadata already records
the target spelling. Replaying either completed operation preserves later local
edits. If the source is still live and a target already exists, the existing
collision refusal remains in force: the snapshot does not prove that this
rename created that target, so the unresolved operation remains pending.

`commitPendingFileEvents()` requests immediate processing of the finite set of
operations accepted before the call, including work which is buffered,
waiting, or already in a handler. It waits for each actual handler result and
for the ordered snapshot update which records that result; releasing a timer is
not completion. Later events do not extend that captured boundary. A newer
coalesced operation satisfies an earlier one only when its successful result
covers the earlier intent. A failed handler or snapshot update is reported to
the caller and leaves unresolved work in the snapshot. This boundary covers
local completion under the selected handler contract only; it does not prove replication or receipt by another
Vault.

A `DELETE` or `RENAME` is admitted atomically with an ordering sentinel.
The sentinel waits for earlier operations to settle. Its removal commits once
it has been dispatched and all earlier operations have durably acknowledged
completion.

Ready attempts use a bounded dispatch window so large restores do not launch all
operations at once. Waiting batch timers and coalesced predecessors do not hold
window capacity, and the host concurrency semaphore bounds active handlers for
initial dispatches, retries, and resumed attempts alike.

The quiet period starts at the latest accepted update and includes time spent
filtering. The maximum intentional delay starts at the first uncommitted
update. Waiting for dispatch capacity leaves both deadlines unchanged.

An editor-change hint can extend the quiet period of the latest eligible
waiting operation for its path. The manager uses the live batch settings and
the operation's existing maximum deadline. Hints change timing only. They
leave queue membership and persistence untouched. An explicit flush can
release a captured wait immediately.

## Persistence adapters

Import `IStorageEventIncrementalPersistenceAdapter`,
`StorageEventSnapshotRecord`, `StorageEventSnapshotDelta`, and
`isIncrementalPersistenceAdapter` from `@vrtmrz/livesync-commonlib/storage`.
A host opts into incremental persistence by supplying both
`loadSnapshotEntries()` and `applySnapshotDelta()`. Existing adapters, and
adapters with only one of the two methods, use `loadSnapshot()` and
`saveSnapshot()`. The selected adapter mode remains authoritative after
read or write failures.

Return entries in durable order with unique, opaque, store-scoped IDs. Preserve
each entry's ID across retries, and apply the disjoint `upsert` and `remove` sets
in one atomic commit. Sentinels have their own IDs. Hosts own persistent
sequence allocation across store lifetimes, store migration, and exclusion
between managers sharing the same store.

Every adapter must reject failed reads and writes. Reserve `null` for an
absent snapshot. Resolve writes when their transaction commits. An IndexedDB
adapter must also abort its transaction if request construction throws.

## Restoration and shutdown

Call `restoreState()` for the selected store before registering watchers.
Concurrent calls share the initial restoration, and subsequent scans reuse
the live queue for that store. Loaded intents are already durable. Admissions
staged during the read keep their own admission write and are ordered after
the loaded entries. A failed restore leaves the store protected from writes
until a successful retry. The offline scanner restores the event store even
when the first Vault scan has never finished. A direct admission also loads
the selected store before its first write. Call `resetPersistenceState()`
when replacing the underlying store, then call `restoreState()` for the
replacement. In-flight
writes from the previous generation cannot acknowledge pending intent in the
replacement store.

`beginStopWatching()` installs a synchronous terminal fence. `isStopping()`
reports that fence throughout retirement. `stopWatching()` disposes batch
timers, preserves durable and flushable unstarted intent, and signals active
optional providers to flush. If uncommitted intent was staged before the store
was acquired, `stopWatching()` rejects without writing so the unread store
remains intact. It drains active handlers through their acknowledgement commits
and joins the snapshot writer. Once it settles, the retired manager issues no
further writes. Hosts coordinate same-store handoff and database closure around
that boundary.

Watcher startup checks the fence before and after restoration. The offline
scanner can abort after the initialisation read or replay, including on an
uninitialised store. An aborted scan propagates through database preparation
so application readiness stays false. A pending explicit flush can settle
during retirement without starting another retry.

## Retrying ordinary file operations

The following extension is available in Commonlib 0.4.1. A failed ordinary
`CREATE`, `CHANGED`, `DELETE`, or `RENAME` remains pending, while its attempt has
a completed failure result. A later finite `commitPendingFileEvents()` request
can start a new attempt. A subsequent event for the same path or related rename
paths can also re-evaluate failed predecessors before proceeding. These paths
share the event manager's ownership and use the existing current-state
reconciliation rules.

Each request captures a finite set of operations and attempts. It may retry an
existing failure once, shares an attempt already running, and reports failures
from its captured attempts without looping until success. Later edits do not
extend that boundary indefinitely. Independent paths can continue, and a new
file event only recovers its related dependency chain.

An earlier caller retains its failed result. Completion removes only the
operation which owns that result, after its ordered snapshot update succeeds;
it cannot remove a newer event. Reconciliation checks current file content,
database effects, and provenance instead of resending a saved body. An absent
temporary file can make its old content save unnecessary, but following
rename, deletion, and final-path save operations retain their own effects.

Already represented deletions and completed renames retain their replay rules.
Recreated files and later edits remain protected. A target's existence alone
does not prove ownership of a partially completed rename. If the displayed
source branch cannot be established, the existing conservative deletion and
rename fallback preserves the branches and requests conflict checking; the
requested deletion may remain unmet.

The database and provenance writes remain separate. Their known interruption
window may produce additional revisions or a preserved conflict under the
[provenance contract](conflict-resolution.md). An empty pending set is not proof
of preserved content or ancestry.

Runtime retries reuse the start-up file-reconciliation rules with the
manager's current in-memory ownership. Existing flush calls select retries,
and optional providers continue to own their retry policy. See the [reviewed retry decision](https://github.com/vrtmrz/obsidian-livesync/blob/09c17e90dde3b1a2000c8a2e13301245107b915b/docs/adr/2026_11_local_file_operation_retry.md)
for the operation matrix and considered alternatives.

## Optional file handlers

`INTERNAL` events and files marked `isInternal` use their owning feature's
contract. Hosts can register `processOptionalFileEventWithResult` handlers with
`firstHandled`. `HandlerOutcome<TValue = void, TVetoReason = void>` carries a
success value and a veto reason independently; a non-void payload is required
in its branch. Dispatch follows priority and registration order:

| Outcome                | Dispatch and completion                                                         |
| ---------------------- | ------------------------------------------------------------------------------- |
| `not-applicable`       | Try the next provider. If none applies, complete the policy-approved skip.      |
| `completed`            | Stop and complete the event after the provider's actual save or verified no-op. |
| `veto`                 | Stop and retain the event with a reported refusal reason.                       |
| Exception or rejection | Propagate the original error and retain the event.                              |

A completed result stops dispatch immediately; a later provider cannot veto
it. Empty registration returns `not-applicable`. False or zero payloads remain
valid values. Providers must resolve their promise only after the operation
finishes. Snapshot acknowledgement still follows the handler result, and a
snapshot failure keeps the event recoverable.

The optional `whenFlushRequested` promise resolves when a finite completion
boundary includes this event. A provider which debounces saves uses it to
release that event's captured delay. It must wait for the corresponding save,
settle all notifications coalesced into that save, and keep later groups outside
the captured boundary. This signal is runtime state; it does not change the
persisted snapshot format.

Migrate all optional providers in a host together. Once the first typed provider
is registered, the manager uses the typed chain exclusively, even when every
provider returns `not-applicable`. A host without a registered typed provider
retains `processOptionalFileEvent` as a legacy notification contract. Its
boolean does not confirm persistence: a resolved notification completes only
that dispatch, while a rejection which reaches the manager is still retained.
The existing boolean aggregators and ordinary file contract are unchanged.

During start-up replay and settings or unload flushes, providers use actual
database readiness and initialise their required local state before saving.
They must not wait for an application-ready or resume event which occurs only
after that same flush. An unavailable prerequisite returns a veto; the manager
does not introduce an automatic retry loop for a failed operation.

## Event intent and current storage state

| Event intent                             | Current storage observation                                                                                             | Admitted operation                                                     |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Watcher `CREATE` or `CHANGED`            | A selected regular file is present                                                                                      | Keep the existing storage-to-database write.                           |
| Watcher `DELETE` without `renameTarget`  | A current file resolves to the same canonical document ID, including at an excluded path, or a folder occupies the path | Suppress the database deletion; no rename destination is known.        |
| Watcher `DELETE` without `renameTarget`  | The host lookup reports no current item, or a file belonging to a distinct document ID                                  | Use the existing deletion operation.                                   |
| Watcher `DELETE` without `renameTarget`  | Lookup fails                                                                                                            | Leave the database unchanged; failure is unknown, not absence.         |
| `RENAME` converted to `DELETE`           | The destination is still selected when case-collision rejection is omitted                                              | Suppress the database deletion.                                        |
| `RENAME` converted to `DELETE`           | The destination is deliberately excluded, and the source is absent                                                      | Apply the old document's deletion.                                     |
| Case-only `RENAME` converted to `DELETE` | Source lookup resolves to the exact deliberately excluded destination, not the original path                            | Apply the old document's deletion despite the shared ID.               |
| Restored `DELETE` without `renameTarget` | A current item occupies the saved path                                                                                  | Keep the existing restored-event suppression.                          |
| Replicated logical deletion              | Storage contains a file                                                                                                 | Keep the existing database-to-storage conflict and preservation rules. |

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
distinct document IDs, an excluded same-ID file without inferred rename
intent, retained rename destinations, transient collision rejection,
deliberate exclusion, and source recreation. Live and restored deletions are
exercised separately. A database-to-storage test also verifies that an
incoming logical deletion can still remove unchanged storage content.

These tests do not establish the native watcher event sequence reported in
Issue 1168. Real-runtime verification belongs to the host and must distinguish
observed events from inferred causes. The watcher guard does not promise
path-case convergence or full folder-rename support. Focused manager tests cover
finite completion boundaries, detached persistence batches, retained failures,
batch timing, and unload during restore or processing. The synthetic
7,453-entry restore measures Commonlib queue and writer costs with in-memory
adapters. IndexedDB transaction, migration, and renderer measurements belong
to the adopting host.

The maintained host's real-runtime comparison is recorded in
[Proven in maintained hosts](proven-in-use.md#obsidian-plug-in), separately
from these unit-test guarantees.

## Related documents

- [Full offline scan](offline-scanner.md), especially [Stored event interpretation](offline-scanner.md#stored-event-interpretation).
- [Conflict resolution and file provenance](conflict-resolution.md).
- [Commonlib development](development.md).
