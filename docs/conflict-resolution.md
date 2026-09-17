# Conflict resolution and file provenance

This document defines the Commonlib-owned revision-tree rules used when LiveSync detects, merges, resolves, and reflects file conflicts. A host still owns its user interface, binary-file policy, persistence, and the decision to offer an explicit newer-file mode.

## Revision-tree model

PouchDB stores every file metadata document as a revision tree. One deterministic leaf is returned as the current winner, while the other live leaves appear in `_conflicts`. The winner is a database choice, not evidence that its content is newer, safer, or the version displayed by a host.

For example:

```text
A1
├── B1 ── C1 ── D1
└── B2 ── C2
```

`D1` and `C2` are the leaves to compare. Their nearest common ancestor is `A1`, not `B1` or `B2`. Automatic three-way merge may proceed only when the same `available` revision is present in both leaf histories. A matching generation number alone does not establish ancestry.

Resolving a conflict writes the selected or merged result on one branch and deletes every losing live leaf which the resolver has observed. Deleted leaves remain part of the tree until compaction removes their bodies. A stale client can therefore receive the resolved branch and the tombstone for a branch whose old content is still present in its storage.

## Chunk reachability during conflicts

A host which collects unreferenced chunks must include the current winner, every other live conflict leaf, their available divergent revisions, and their nearest available shared ancestor in its reachability scan. This preserves the content and merge base required to review an unresolved conflict. Chunk identifiers are shared across documents, so one reachability set must cover the whole database.

After the conflict is resolved, the deleted losing branch and no-longer-needed merge ancestry stop protecting their unique chunks. An ordinary superseded linear revision also does not protect its former chunks. A host must keep garbage collection separate from repair because collection cannot reconstruct content which is already unavailable.

## Safety invariants

Commonlib follows these rules:

- compare file content byte-for-byte; a path, size, modification time, or revision generation is not proof of identity;
- use the nearest `available` revision shared by both leaves as the base for three-way merge;
- retain a manual conflict when the common revision or a required body is missing or compacted;
- recognise an unchanged file by comparing its bytes with its exact readable file-reflection provenance;
- save a genuine edit as a child of that recorded revision, even when a newer database winner exists;
- deduplicate unknown-origin content against current non-deleted leaves, preserving differing content as a fresh independent root under the same document ID; and
- never select the newest modification time as a package-level default.

Ordinary saving and incoming reflection share this classification. A historical byte match alone cannot distinguish an unchanged stale file from an intentional revert, and a prefix or suffix relationship does not prove which version the user edited. Unknown-origin content must not acquire an inferred parent from the current winner or its parent.

After a resolution has propagated, an exact recorded revision can still identify unchanged content below a deleted losing leaf. The resolved winner may replace those bytes under the existing reflection policy. If the recorded body is unavailable, the file follows the conservative unknown-origin path. General history-query helpers remain available for callers with separate contracts, including existing deletion and rename recovery; ordinary save and overwrite protection do not scan all historical bodies.

## Resolution classes

| State                                                                           | Safe automatic action                                                       |
| ------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Both leaves contain identical bytes                                             | Collapse the duplicate leaf without creating merged content.                |
| Text or structured data has a shared available base and non-overlapping changes | Perform a conservative three-way merge.                                     |
| One side deletes content which the other leaves unchanged                       | Preserve the deletion.                                                      |
| One side deletes content which the other modifies                               | Retain a manual conflict.                                                   |
| A receiving file matches its exact readable recorded revision                   | Apply the propagated result under the existing conflict policy.             |
| A receiving file differs from its readable recorded revision                    | Preserve the edit as a child of that revision.                              |
| Origin is unknown and no current non-deleted leaf matches                        | Preserve a fresh independent root for host conflict resolution.             |
| Origin is unknown and current non-deleted leaves already contain the bytes       | Avoid duplicate storage; infer provenance only for a unique match.          |
| A body or common ancestor is missing or compacted                               | Retain a manual conflict.                                                   |
| Content is binary or otherwise not semantically mergeable                       | Leave the selection policy to the host; Commonlib cannot infer user intent. |

## Stale and concurrent resolutions

A client can resolve only the leaves which it has observed. If it resolves an older pair while another client has already extended one branch, replication can reveal another live leaf and the document remains conflicted. Two clients can also resolve different leaves concurrently. Neither result is authoritative merely because it has a higher generation or modification time; after the trees meet, every remaining live leaf must be considered again.

This is expected conflict behaviour, not a replication reset. A resolver should process the current leaves repeatedly until one live result remains or user action is required.

## More than two live versions

When a document has three or more live leaves, Commonlib compares the current PouchDB winner with one remaining leaf at a time. The remaining candidates are ordered by revision generation ascending, original leaf modification time ascending, then the complete revision ID in code-unit lexical order. A missing or non-finite modification time sorts before a finite time. This order makes the next pair reproducible; it does not make an earlier modification time authoritative.

Each duplicate collapse, conservative merge, or host-directed manual choice is committed to the ordinary revision tree before the next pair is considered. The resolver then reads the current live leaves again instead of retaining a separate accumulator. Completed stages therefore survive a process restart, while a new or externally resolved leaf is considered from the tree which actually exists at the next check.

A host must not apply a dialogue result after either compared revision has ceased to be the current pair. It should discard that stale result, refresh its warning or dialogue state, and queue the path again when conflicts remain.

## File-reflection provenance

The compatibility implementation accepts an injected, device-local `FileReflectionProvenance` capability owned by the database-to-storage composition rather than by a filesystem adapter. Maintained hosts persist:

```text
path -> { revision, observedStorageMtime? }
```

`revision` is the exact database revision most recently saved from or reflected in this device's storage. It identifies the base for subsequent local edits, rather than certifying that the current file still contains those bytes. `observedStorageMtime` is the raw modification time of the saved snapshot or the file observed after reflection. It is neither rounded nor compared across devices, and it is diagnostic only: revision identity never comes from a timestamp, path, size, or content hash.

The record is updated only after a successful database-to-storage reflection or storage-to-database write. A plain read does not change provenance. A record remains authoritative when a user edits the displayed file to bytes which happen to equal another branch; content equality must not silently change the branch being extended.

File-handler saves and reflections share a lock for the same Metadata document, held from snapshot acquisition through provenance recording. Different documents can proceed concurrently. An ordinary save keeps one captured body and its recorded base through the database write; a later local edit is processed as a subsequent change, without rereading the file to certify that it remained unchanged. The handler acquires the lock before loading a file body from storage. Rename operations acquire both document locks in a consistent order, and internal calls reuse the caller's lock rather than acquiring it again. Host conflict-check hooks run after the locks are released, allowing a hook to await another file-handler operation on the same document. Host queues may count document-lock waiters against their concurrency limits, so a burst for one document can temporarily delay unrelated files.

These locks order Commonlib file-handler operations; they do not stop user edits, external filesystem writes, or database replication. Incoming overwrite and deletion protection therefore still checks current storage. Restored storage events also retain bounded rechecks because they finish before the file watcher starts and cannot depend on a subsequent change notification.

User-directed reconciliation may select any exact current live revision, including a conflict leaf rather than the deterministic winner. `dbToStorageWithSpecificRev()` rechecks that the selected revision is still live before reflecting its content. `storeFileToDBWithBaseRevision()` performs the same live check before storing current storage content as a child of that revision. If the content already matches the selected non-deleted revision, it records that revision directly without creating a child. A host can set `createIfDifferent` to `false` when it intends only to record an exact content match; differing content then fails instead of changing the revision tree. A host may also create a logical deletion on an explicitly selected branch with `deleteRevisionFromDB()` after performing its own current-live-revision check. This leaves storage unchanged and clears device-local provenance only when that record names the deleted revision.

`storeWithBaseRevision()` is the force-write primitive for deliberately preserving a branch below an exact revision, including a revision which is no longer a leaf. It must not be used when an operation means 'advance this revision only if it is still current'. For that compare-and-store boundary, `storeWithLiveBaseRevision()` uses PouchDB's ordinary revision check and returns `false` if the supplied base has already been advanced. Any current revision-tree leaf is eligible, including a non-winning conflict leaf or a logical-deletion leaf. The caller must refresh its state after refusal rather than silently falling back to the deterministic winner.

`storeIndependentRevision()` explicitly preserves unknown-origin content through `putDBEntryAsIndependentRoot()`. Passing an undefined base to `storeWithBaseRevision()` retains its existing latest-revision behaviour and does not create an independent root. `findLiveContentRevisions()` compares only current non-deleted leaves using locally available chunks. Additional provenance comparisons also use local-only retrieval, so they do not introduce remote chunk requests or delivery waits; a missing body leads to preservation rather than an inferred base.

A successful non-deleted reconciliation records the exact selected or newly created revision as provenance. Applying a logical deletion removes the storage item and its provenance record. Deletion provenance is not retained indefinitely: an absent storage item and a current logical-deletion winner already agree and need no further reconciliation.

Hosts may construct the namespaced store handle during service composition, before its backing database is open. Store operations begin only after the host's storage lifecycle is ready. They fail rather than wait when that lifecycle contract is violated, because an implicit readiness wait could hang after failed initialisation or wait on its own initialisation handler. Database reset is a transient unavailable boundary; the host must avoid file processing during it and reconstruct derived provenance after reopening.

For ordinary saving and incoming reflection, an absent or unreadable recorded base permits reconstruction only from exactly one matching current non-deleted leaf. Multiple matches avoid duplicate storage without guessing branch identity. No current match creates a fresh independent root, even when an ancestor has the same bytes. Deletion and rename retain their existing provenance-recovery contracts.

An unchanged stale file is not saved below the winner. When the database has advanced without a conflict, the existing database-to-storage path reflects it; a conflict instead remains subject to the host's reflection and resolution policy. Independent roots retain the file's modification time and use the existing Metadata/Chunks format, with fresh revision identifiers and reusable chunks. They have no shared ancestor with unrelated existing branches, including after replication. This does not disable a host's explicit newer-file option.

Saving and reflection revalidate captured file content and provenance across asynchronous work. Restored saves reconcile changed storage directly, because host file watchers may not yet be registered. Retries are bounded; a file which keeps changing causes the operation to fail rather than report an uncompleted save as successful. These checks do not make external filesystem edits atomic with a host write: the storage contract has no conditional write operation covering that final interval.

## Operations while a conflict exists

With a proven displayed revision:

- an edit writes a child of that exact revision;
- a deletion writes a logical-deletion child of that exact revision, using the document's `deleted` marker rather than a PouchDB `_deleted` tombstone, so the operation remains a visible live branch until the conflict is resolved;
- a case-only rename writes the new path as a child of the displayed revision in the same document tree; and
- a cross-path rename stores the target first, then writes a logical-deletion child on the displayed source branch.

When edit provenance cannot be reconstructed, the new bytes are preserved as another manual-resolution branch instead of being attached silently to the deterministic winner. A deletion has no remaining file body from which to reconstruct provenance, so an unproven deletion preserves every live branch and requests conflict review. A cross-path rename with an unproven source keeps the newly stored target and preserves every source branch for review.

If the recorded base cannot be read, an ordinary save preserves differing storage bytes on an independent root without guessing the winner's parent. This also works when the existing winner is generation one or has unavailable chunks. Existing unreadable branches remain available for repair. A host may separately offer confirmed exact-revision discard; it must not infer permission for discard from a failed read.

These fallbacks favour recoverability. They may temporarily leave a duplicate target or a still-visible source conflict, but they do not discard a branch whose relationship to the user's operation cannot be proved.

## Worked revision-tree scenarios

### Editing the branch displayed by a host

Assume that the database has this conflict:

```text
A1
├── B1 ── C1     database winner
└── B2 ── C2     displayed in storage
```

The host records `C2` when it reflects that branch into storage. If the user edits the displayed file, Commonlib writes the new revision as a child of `C2`:

```text
A1
├── B1 ── C1
└── B2 ── C2 ── D2     edited content
```

It does not attach the edit to `C1`, even if PouchDB still returns `C1` as its deterministic winner. Replication carries both live leaves, `C1` and `D2`, so a resolver can compare the branches which actually produced the conflict.

### Deleting the displayed branch

With the same starting tree and recorded `C2` provenance, deleting the storage file writes a logical-deletion child of `C2`:

```text
A1
├── B1 ── C1
└── B2 ── C2 ── D2 (deleted: true)
```

`D2` remains a live metadata branch. The host can therefore ask whether to retain `C1` or the deletion. A PouchDB `_deleted` tombstone would remove that decision from the live conflict and is not used for this operation.

### Renaming while a conflict is visible

For a case-only rename, such as `Note.md` to `note.md`, the renamed entry is written as a child of the displayed revision in the same document tree. The other live branch remains available for resolution.

For a cross-path rename, such as `draft.md` to `published.md`, Commonlib stores `published.md` first. It then writes a logical-deletion child of the recorded branch in the conflicted `draft.md` tree. Storing the target first favours recoverability: an interruption can leave a duplicate for review, but it cannot remove the only copy before the target exists.

### Reconstructing provenance after local state is unavailable

Suppose a local-database reset removed the device-local record, but the storage file still has exactly the bytes held by current non-deleted leaf `C2`. If `C2` is the only matching current leaf, ordinary saving or reflection can reconstruct `C2` as the displayed base and a later edit extends it normally. An unchanged-time scan alone does not guarantee reconstruction.

If both current leaves contain the same bytes, ordinary saving avoids duplicate storage without selecting either as provenance. If neither contains the storage bytes, those bytes are preserved on an independent root. An unproven deletion preserves both existing branches, and a cross-path rename preserves unproven source branches after storing the target. These outcomes may require user review, but they do not guess that the deterministic winner was displayed.

### Receiving a resolution while showing the losing branch

Device A may resolve the conflict while Device B still displays the bytes from recorded revision `C2`. When the resolved tree reaches Device B, the exact recorded body identifies those bytes as unchanged, even below the deleted losing leaf. Device B can apply the resolution without recreating the conflict. If Device B edited the file after displaying `C2`, its bytes differ from that recorded body and the overwrite guard preserves the edit, including an intentional revert to some other historical content.

### Starting and resetting the provenance store

A host may create the namespaced provenance handle while composing services. It then opens the backing key-value database in its sequential settings lifecycle before enabling scans, storage watchers, or replication. If opening fails, start-up stops; a provenance operation is not held waiting for a readiness state which may never arrive.

During a local-database reset, the store is temporarily unavailable. A racing lookup fails promptly and is treated as unknown provenance, selecting the conservative behaviours above. Once the database has reopened, saving or reflection can reconstruct a record from a unique matching current non-deleted leaf.

## Unsafe shortcuts

Do not:

- use the first revision whose generation is lower than the other leaf as a supposed common ancestor;
- select a winner from modification time unless the host exposes and the user selects that destructive policy;
- assume the PouchDB winner is the content currently displayed in storage;
- replace a recorded displayed revision merely because current bytes match another branch;
- infer that a file is unchanged from historical byte equality without its exact provenance;
- discard storage content because history lookup failed;
- infer revision identity from path, size, modification time, or hash without the revision identifier; or
- automatically merge overlapping text changes or unrelated binary contents.

## Verification ownership

Commonlib unit tests build real in-memory PouchDB trees and inject provenance fakes at the file-handler boundary. They cover revision ancestry, conservative merge, content preservation, independent roots, repeated events, and the separate explicit reconciliation, deletion, and rename contracts. A maintained host should additionally verify persistent device-local provenance, real file events, restart processing, replication of the resulting revision trees, and dialogue policy. Package-level tests do not establish mobile lifecycle behaviour or the original reporter's environment.
