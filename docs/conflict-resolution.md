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

## Safety invariants

Commonlib follows these rules:

- compare file content byte-for-byte; a path, size, modification time, or revision generation is not proof of identity;
- use the nearest `available` revision shared by both leaves as the base for three-way merge;
- retain a manual conflict when the common revision or a required body is missing or compacted;
- treat content found in any available branch of the same tree, including an ancestor of a deleted leaf, as content which has already been synchronised;
- preserve storage content as a conflict when it is absent from all available branches; and
- never select the newest modification time as a package-level default.

The all-branch history check matters after a resolution has propagated. If a receiving device still displays the deleted losing revision, that exact content is known synchronised content. The resolved winner may replace it without recreating the conflict. If the device has edited that content again, the bytes no longer match the old revision, so the storage-protection guard preserves the new edit.

## Resolution classes

| State                                                                           | Safe automatic action                                                       |
| ------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Both leaves contain identical bytes                                             | Collapse the duplicate leaf without creating merged content.                |
| Text or structured data has a shared available base and non-overlapping changes | Perform a conservative three-way merge.                                     |
| One side deletes content which the other leaves unchanged                       | Preserve the deletion.                                                      |
| One side deletes content which the other modifies                               | Retain a manual conflict.                                                   |
| A receiving file matches any available revision in the tree                     | Apply the propagated database result.                                       |
| A receiving file matches no available revision                                  | Preserve it as an unsynchronised conflict.                                  |
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

`revision` is the exact database revision which most recently produced the file displayed on that device. `observedStorageMtime` is the raw modification time observed after reflection. It is neither rounded nor compared across devices, and it is diagnostic only: revision identity never comes from a timestamp, path, size, or content hash.

The record is updated only after a successful database-to-storage reflection or storage-to-database write. A plain read does not change provenance. A record remains authoritative when a user edits the displayed file to bytes which happen to equal another branch; content equality must not silently change the branch being extended.

Hosts may construct the namespaced store handle during service composition, before its backing database is open. Store operations begin only after the host's storage lifecycle is ready. They fail rather than wait when that lifecycle contract is violated, because an implicit readiness wait could hang after failed initialisation or wait on its own initialisation handler. Database reset is a transient unavailable boundary; the host must avoid file processing during it and reconstruct derived provenance after reopening.

When a record is absent, the implementation reconstructs it only if the current storage bytes match exactly one available revision body. No match, or more than one match, leaves the branch identity unknown.

## Operations while a conflict exists

With a proven displayed revision:

- an edit writes a child of that exact revision;
- a deletion writes a logical-deletion child of that exact revision, using the document's `deleted` marker rather than a PouchDB `_deleted` tombstone, so the operation remains a visible live branch until the conflict is resolved;
- a case-only rename writes the new path as a child of the displayed revision in the same document tree; and
- a cross-path rename stores the target first, then writes a logical-deletion child on the displayed source branch.

When edit provenance cannot be reconstructed, the new bytes are preserved as another manual-resolution branch instead of being attached silently to the deterministic winner. A deletion has no remaining file body from which to reconstruct provenance, so an unproven deletion preserves every live branch and requests conflict review. A cross-path rename with an unproven source keeps the newly stored target and preserves every source branch for review.

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

Suppose a local-database reset removed the device-local record, but the storage file still has exactly the bytes held by `C2`. If `C2` is the only available revision with those bytes, Commonlib reconstructs `C2` as the displayed base and an edit extends it normally.

If both `C1` and `C2` contain the same bytes, or neither available body matches, content cannot identify the displayed branch. An edit is preserved as another manual-resolution branch. A deletion preserves both existing branches, and a cross-path rename preserves the source branches after storing the target. These outcomes may require user review, but they do not guess that the deterministic winner was displayed.

### Receiving a resolution while showing the losing branch

Device A may resolve the conflict while Device B still displays the bytes from `C2`. When the resolved tree reaches Device B, the all-branch history check recognises those bytes below the deleted losing leaf. Device B can apply the resolution without recreating the conflict. If Device B edited the file after displaying `C2`, its bytes no longer match the historical revision and the overwrite guard preserves that new local edit instead.

### Starting and resetting the provenance store

A host may create the namespaced provenance handle while composing services. It then opens the backing key-value database in its sequential settings lifecycle before enabling scans, storage watchers, or replication. If opening fails, start-up stops; a provenance operation is not held waiting for a readiness state which may never arrive.

During a local-database reset, the store is temporarily unavailable. A racing lookup fails promptly and is treated as unknown provenance, selecting the conservative behaviours above. Once the database has reopened, a later scan can reconstruct uniquely identifiable records from exact revision bodies.

## Unsafe shortcuts

Do not:

- use the first revision whose generation is lower than the other leaf as a supposed common ancestor;
- select a winner from modification time unless the host exposes and the user selects that destructive policy;
- assume the PouchDB winner is the content currently displayed in storage;
- replace a recorded displayed revision merely because current bytes match another branch;
- recreate a conflict from a byte-identical deleted losing revision after a remote resolution;
- discard storage content because history lookup failed;
- infer revision identity from path, size, modification time, or hash without the revision identifier; or
- automatically merge overlapping text changes or unrelated binary contents.

## Verification ownership

Commonlib unit tests build real in-memory PouchDB trees and inject provenance fakes at the file-handler boundary. They cover unequal branch lengths, nearest shared ancestry, deterministic selection from multiple live leaves, reconstruction of a later manual pair after an earlier sensible merge, content retained below a deleted losing leaf, recorded and reconstructed branch identity, ambiguous content, conflict-time editing, logical deletion, case-only rename, cross-path rename, and safe unproven fallbacks. A maintained host should additionally verify its composition: persistent device-local provenance, real file events, replication of the resulting revision trees, and dialogue policy.
