---
date: 2026-09-27
commonlib-version: "0.1.30"
self-hosted-livesync-version: "1.0.32"
status: unreleased
---

# Remote feature compatibility

This document defines the persisted feature contract for CouchDB databases and
the checks required of Commonlib consumers. It describes unreleased behaviour
being implemented in this branch.
The first feature is encrypted Metadata for Hidden File Sync and Customisation
Sync. Journal and P2P retain their existing transport contracts.

## Ownership and compatibility dimensions

Commonlib owns the wire representation, validation, feature identifiers, shared
assessment, and admission requirements. Hosts own presentation, scheduling, and
the application of received documents to their files.

Keep these independent dimensions separate:

- the remote protocol generation states how to interpret the control document;
- the used-feature set states which representations the database may contain;
- the supported-feature set belongs to the running client implementation;
- Tweak values describe settings which participating writers should share; and
- the existing Chunk version range describes Chunk format compatibility.

A feature is supported only when the client can interpret its data and preserve
its dependencies during applicable operations, including maintenance. Ignoring
an unfamiliar file path is not sufficient: encrypted Chunk references must not
be mistaken for an empty reference set.

## Control document

Extend the existing ordinary document, preserving its existing identifier:

```json
{
  "_id": "obsydian_livesync_version",
  "type": "versioninfo",
  "version": 13,
  "used_features": ["encrypted-internal-metadata-v1"]
}
```

Generation 13 is the introduction boundary. It makes legacy clients
which understand only generation 12 reject the enabled remote through their
existing version check. Subsequent independent features use the feature list;
they do not each require another protocol generation.

Generation 12 remains readable without a feature list. Connecting with a newer
client must not promote a legacy database. The existing local compatibility
acknowledgement and settings-schema version remain separate concerns; adding
this remote contract must not implicitly advance those markers for every user.

The document remains readable before Metadata decryption and is replicated to
local databases. The `_local/obsydian_livesync_milestone` document continues to
hold participant and Tweak information; it is not the sole source of feature
requirements. The ordinary version document also provides the existing route
for observing compatibility changes during replication.

### Validation and unknown identifiers

Read `used_features` as an array of opaque, non-empty strings. Preserve unknown
strings before comparing them with the client-owned supported set. A closed
enum must not discard the evidence needed to diagnose an unknown feature.
Order and duplicates do not change the set's meaning.

Assessment returns distinct outcomes for a compatible document, an unsupported
protocol generation, unknown feature identifiers, and malformed control data.
Unknown identifiers are included in the result so any host can render a generic
message such as `Unknown features are in use: example-feature-v2` without a
feature-specific label or translation. Hosts render identifiers as text.

A missing list is accepted as legacy input only in the legacy generation. A
new-generation document with a missing or invalid list is not silently treated
as an empty set. Deleting or corrupting the control document does not authorise
ordinary data operations or recreate a legacy declaration over a non-empty DB.

### Updating requirements

Declare a feature before writing documents which depend on it. Introduce the
new generation and its initial feature set in the same control-document update.
Preserve existing identifiers and unrelated fields when updating the document.
On a revision conflict, fetch and reassess the current document before merging
or retrying; never replace another writer's requirements with a stale snapshot.

The used-feature set is retained when a writer turns its corresponding setting
off. Older documents or revisions may still depend on that feature. Removing
a requirement needs a verified data-history transition, such as an explicit
reconstruction which removes that representation. Manually shortening the declaration is not a supported migration.

This is a client compatibility contract, not CouchDB access control. It cannot
retrofit checks into legacy direct-access clients or revoke requests which a
server has already accepted.

## Admission and changes during replication

Use the same assessment before ordinary replication, Fast Fetch, direct file
access, and cleaned-remote recovery before counting Chunk references. Declare
required write features after admission, including for the writer accepted by a
Rebuild lock. A locked-out device cannot declare or upload a new representation.

Fast Fetch reads the version document with its configured HTTP credentials and
custom headers before opening or resetting the local database, including when
resuming a checkpoint. Rejection leaves local data and the checkpoint intact.
An empty remote and legacy generations retain their existing completion and
migration paths; a missing version document in a populated remote is rejected.

The remote document is the source of requirements. The milestone retains its
participant, Tweak comparison, and lock responsibilities. Hosts do not need a
second persistent feature list or rejection history in KV storage.

The existing received-version handler also uses the shared assessment. An
unknown identifier, unsupported generation, or malformed document requests
Replicator retirement and reports the reason. Supported requirements do not
interrupt the connection merely because the revision or feature list changed.
Do not await retirement inside the change callback: the owner may be waiting
for that callback to settle before it can drain and close the operation.

A received notification can follow persistence to the local database. The
handler is a best-effort response to an exceptional live change; it does not
fence every queued file application or atomically revoke admitted requests.
Use the established rollout workflow: update every synchronising client, enable
the preference, and perform the strongly recommended manual Rebuild. Rebuild
uses the existing remote lock. Merely changing the preference does not lock the
remote, so continuing without rebuilding requires compatible devices first,
including those with an active connection.

The next connection assesses the current remote declaration, including after
restart. Existing host snapshot and startup behaviour remain unchanged. After
updating, use the host's normal reconciliation or Fetch facilities as needed;
this contract does not add permanent local rejection flags or repair unrelated
snapshot inconsistencies.

## First feature: encrypted internal Metadata

`encrypted-internal-metadata-v1` denotes the first specification of this feature,
not the legacy E2EE V1 algorithm. It uses E2EE V2's existing HKDF Metadata
representation for obfuscated `i:`, `ix:`, and supported legacy `ps:` entries.
Document IDs and path-to-ID conversion remain unchanged.

Supporting readers decode by the encrypted Metadata marker, independently of
the current write preference. Existing plaintext and encrypted Metadata may
coexist. Activating the preference affects subsequent writes; it does not
rewrite unchanged documents or erase earlier plaintext revisions. Reconstruction
is strongly recommended for existing-data privacy, and remains a manual choice.

Garbage Collection V3 remains a beta, manually initiated operation. Its
workflow first performs an ordinary bidirectional synchronisation, which checks
the remote feature contract. It does not add another check at every collection
step. The separate cleaned-remote recovery path checks the local contract
before its first Chunk-reference count because that path does not begin with
ordinary synchronisation.

## Verification required before acceptance

Protect the wire contract with tests for unknown names, multiple unknown names,
malformed lists, legacy absence, new-generation absence, duplicate and reordered
entries, concurrent updates, and preservation of existing fields. Use a made-up
future identifier so the test does not depend on a known feature's label.

Protect runtime behaviour with tests for initial admission, an admitted writer
on a locked remote, unknown names received at the same generation, and
retirement without a circular wait. Keep direct access, Fast Fetch, and
maintenance admission checks covered. Host tests should preserve existing
startup and queue semantics, including snapshot failures.

Use real CouchDB and downstream Obsidian and CLI tests to validate encrypted
Metadata, file restoration, receipt of a changed declaration, and rejection
before synchronisation after restart. These checks do not establish atomic
cancellation timing or automatic recovery under a future compatible client.

Related contracts: [local database lifecycle](database-lifecycle.md) and
[settings lifecycle](settings-lifecycle.md).
