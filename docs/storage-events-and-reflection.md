---
date: 2026-10-26
commonlib-version: "0.2.1"
self-hosted-livesync-version: "1.0.40"
status: unreleased
---

# Storage events and database-to-storage reflection

This note separates storage-to-database event handling from
database-to-storage reflection. It documents the current guard against a stale
`DELETE` notification logically deleting Metadata while the same file is still
present in storage, and the accepted local completion contract for queued file
operations. The version fields identify the reviewed source versions; these
changes remain unreleased.

## Event-manager terminology

Hosts normally supply an adapter and, where necessary, override protected
`StorageEventManagerBase` hooks. The responsibility modules implement the shared
pipeline; hosts do not need to call every helper directly. Their TSDoc describes
inputs, completion boundaries, state changes, and persistence preconditions for
maintainers who extend or reuse them.

| Term | Meaning in this implementation |
| --- | --- |
| Facade | The host-facing class which connects adapters and overridable hooks to the shared functions. |
| Watcher | The host integration which receives file or editor change notifications. |
| Admission | Filtering a received event and registering its operation. Its completion does not await the file handler. |
| Operation | The accepted event intent whose identity survives failed attempts until completion is durably acknowledged. |
| Attempt | One execution of an operation, with its own result and completion promise. |
| Ownership | The identity relationships which determine which operation and attempt may acknowledge retained work. |
| Batching | Delaying eligible content events so related updates can be processed together. |
| Gate | A promise deciding whether a waiting operation may proceed or has been covered by a successor. Opening it is not handler completion. |
| Coalescing | Combining pending intents by making an earlier operation depend on the result of a successor which covers it. |
| Prerequisite | A related operation whose captured attempt must succeed before the dependent handler can run. |
| Ordered predecessor | An earlier operation which must settle before an ordered event proceeds, even if the earlier result is a failure. |
| Boundary | The finite selection of operations, admissions, or observed failures relevant to one request. |
| Sentinel | A queue marker before deletion or rename which waits only for earlier operations. |
| Dispatch | Taking buffered events and starting their processing; it does not itself establish durable completion. |
| Flush | Releasing delays and waiting for the captured local completion boundary. It does not establish remote replication. |
| Snapshot | The saved pending event intents. It is not a backup of every intermediate file body. |
| Reconciliation | Re-evaluating intent against current storage, database state, and provenance before choosing an effect. |
| Retry | Starting a new eligible attempt while preserving the result already observed by an earlier caller. |
| Effects | Explicit callbacks for stateful work or I/O, separated from functions which only construct a plan. |
| Type guard | A runtime predicate which also narrows the value's TypeScript type before it is used. |

## Processing directions

`StorageEventManager.appendQueue` receives watcher events, applies target and
ignore policies, and queues `CREATE`, `CHANGED`, `DELETE`, or `RENAME` work. A
rename from a selected path to a rejected path becomes a `DELETE` with an
old-path deleted stub and the destination in `FileEventArgs.renameTarget`.
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
in its existing event snapshot. It saves snapshots in order, so an older write
cannot replace a newer view of pending work. The manager acknowledges an
ordinary file operation only after its effect is durable locally, current state proves the
effect is already represented or safely covered by a successful successor, or
the handler returns a skip explicitly allowed by policy. A handler
failure or exception leaves the saved operation pending. A failed initial
snapshot prevents the handler from starting; a later snapshot failure is
reported and cannot be treated as completion. Completion of an older operation
cannot remove a newer operation for the same path.

The event snapshot records operation intent, not authoritative current file
content. Admission does not read a file body merely to wait. When a `CREATE` or
`CHANGED` operation becomes eligible, the handler rechecks the current path and
obtains its current content for processing. Restored events are revalidated
against current storage and selection before they can affect the database. The
saved stub and any optional cache are not used as a historical file version.
The current-storage deletion checks and rename-exclusion rules below continue to
apply.

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

A `DELETE` or `RENAME` ordering sentinel waits for its predecessors only. It
must not wait for itself or events which follow it in the dispatch queue. Batch
timers make work eligible to run; they do not perform it. The quiet period
follows the latest eligible content update, while the maximum intentional delay
is measured from the first uncommitted update, starting when the queue call is
accepted and before asynchronous filtering or the touched-file check. Waiting
timers do not occupy a processing slot, and time spent waiting for a slot does
not restart the maximum delay. Once due, the operation acquires a slot and reads
current content for processing.

## Retrying ordinary file operations

The following extension is unreleased. A failed ordinary `CREATE`, `CHANGED`,
`DELETE`, or `RENAME` remains pending, while its attempt has a completed failure
result. A later finite `commitPendingFileEvents()` request can start a new
attempt. A subsequent event for the same path or related rename paths can also
re-evaluate failed predecessors before proceeding. These paths share the event
manager's ownership and use the existing current-state reconciliation rules.

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

Start-up continues to restore the existing saved snapshot before watching.
Runtime retries reuse its file-reconciliation rules without replacing the
running manager through `restoreState()`. The saved format, handler return
contracts, and optional-provider retry policy remain unchanged. Hosts can use
their existing flush and lifecycle calls; no retry timer or new callback is
required. See the [retry decision](https://github.com/vrtmrz/obsidian-livesync/blob/main/docs/adr/2026_11_local_file_operation_retry.md)
for the operation matrix and considered alternatives.

## Optional file handlers

`INTERNAL` events and files marked `isInternal` use their owning feature's
contract. Hosts can register `processOptionalFileEventWithResult` handlers with
`firstHandled`. `HandlerOutcome<TValue = void, TVetoReason = void>` carries a
success value and a veto reason independently; a non-void payload is required
in its branch. Dispatch follows priority and registration order:

| Outcome | Dispatch and completion |
| --- | --- |
| `not-applicable` | Try the next provider. If none applies, complete the policy-approved skip. |
| `completed` | Stop and complete the event after the provider's actual save or verified no-op. |
| `veto` | Stop and retain the event with a reported refusal reason. |
| Exception or rejection | Propagate the original error and retain the event. |

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

| Event intent | Current storage observation | Admitted operation |
| --- | --- | --- |
| Watcher `CREATE` or `CHANGED` | A selected regular file is present | Keep the existing storage-to-database write. |
| Watcher `DELETE` without `renameTarget` | A current file resolves to the same canonical document ID, including at an excluded path, or a folder occupies the path | Suppress the database deletion; no rename destination is known. |
| Watcher `DELETE` without `renameTarget` | The host lookup reports no current item, or a file belonging to a distinct document ID | Use the existing deletion operation. |
| Watcher `DELETE` without `renameTarget` | Lookup fails | Leave the database unchanged; failure is unknown, not absence. |
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
distinct document IDs, an excluded same-ID file without inferred rename
intent, retained rename destinations, transient collision rejection,
deliberate exclusion, and source recreation. Live and restored deletions are
exercised separately. A database-to-storage test also verifies that an
incoming logical deletion can still remove unchanged storage content.

These tests do not establish the native watcher event sequence reported in
Issue 1168. Real-runtime verification belongs to the host and must distinguish
observed events from inferred causes. The watcher guard does not promise
path-case convergence or full folder-rename support. Focused manager tests cover
finite completion boundaries, ordered snapshots, retained failures, replay, and
batch timing. This work adds no second journal, unbounded retry loop, or
database-schema change.

The maintained host's real-runtime comparison is recorded in
[Proven in maintained hosts](proven-in-use.md#obsidian-plug-in), separately
from these unit-test guarantees.

## Related documents

- [Full offline scan](offline-scanner.md), especially [Stored event interpretation](offline-scanner.md#stored-event-interpretation).
- [Conflict resolution and file provenance](conflict-resolution.md).
- [Commonlib development](development.md).
