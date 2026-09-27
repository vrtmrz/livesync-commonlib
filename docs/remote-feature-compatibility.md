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
reconstruction which removes that representation. A manually shortened list
does not clear requirements already observed in a local database.

This is a client compatibility contract, not CouchDB access control. It cannot
retrofit checks into legacy direct-access clients or revoke requests which a
server has already accepted.

## Admission and changes during replication

Use the same assessment before ordinary replication, Fast Fetch, direct file
access, and cleaned-remote recovery before counting Chunk references. The host's
received-document path also uses that assessment. Checking only when a
connection opens is insufficient
for a connection which remains active whilst another client enables a feature.

| Observed change | Required action |
| --- | --- |
| Only `_rev`, list order, or duplicate entries change | Keep the semantic assessment; no compatibility interruption is required |
| Requirements change and remain supported | Reassess the requirements and any affected shared writer settings; continue when those checks succeed |
| An unknown feature or unsupported generation appears | Block new affected work, request transfer cancellation, and report the unsupported requirements |
| The control document is malformed or deleted | Block affected work and report invalid control information |
| A previously observed requirement disappears | Keep local requirements until an explicit, verified data-history transition establishes that they are no longer needed |

Inspect the control documents in a received batch before admitting that batch's
file changes to host processing. The control document may be the last item in
the batch. Reassess against the physical database and operation owner which
produced the event; a late callback for a retired database must not change the
state of its replacement.

On rejection, establish the compatibility block synchronously before requesting
asynchronous retirement. New synchronisation and queued file reflection must
observe the block. Work waiting on another operation rechecks
compatibility before beginning another write. Known metadata-only updates must
not repeatedly retire a healthy connection or duplicate a Notice.

The Replicator owner remains responsible for transfer cancellation, draining
admitted work, and physical close. A received-document callback must not await
retirement when retirement is waiting for the operation which delivered that
callback. Use the existing ownership transition, with the immediate compatibility
block providing the separate protection for subsequent work.

### Limits and recovery

A replication change notification can follow persistence to the local database.
The block does not promise to prevent every unsupported byte from entering that
database, undo completed writes, or cancel a server-accepted request atomically.
Already-started operations settle under their owners; further operations are
withheld at their admission or commit boundaries.

Preserve unprocessed documents or durable reconciliation information. Do not
discard a pending item and then assume ordinary replication will emit it again:
its checkpoint may already cover the document. Restart restores the block from
the database's requirements before queued reflection or ordinary
synchronisation proceeds.
The host persists its blocked pending-work snapshot before the received-change
callback settles, without waiting for Replicator retirement in that callback.

Recovery requires a compatible client and a fresh assessment of remote and
local state. Retained work must then be reprocessed with the supported decoder
or reacquired through a defined recovery path. Do not clear the block merely
because the notification was dismissed, a feature name was removed remotely,
or the connection was replaced. Do not silently rewind replication checkpoints
or reconstruct databases as a side effect of this check.

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

Protect runtime behaviour with tests for initial admission, feature-only changes
at the same protocol generation, control records at either end of a batch,
queued and waiting work, transfer cancellation, absence of retirement deadlock,
stale callbacks, restart, retained work after checkpoint advancement, direct
access, Fast Fetch, and maintenance.

The released code already observes numeric version changes. A focused host
processor probe found that requesting retirement alone does not establish a
file-application block. Host unit coverage must therefore verify both effects;
calling a retirement mock is not proof that reflection has stopped.

Use a real CouchDB and downstream Obsidian and CLI tests to validate actual
delivery, cancellation, persistence, and recovery. Unit tests establish the
stated contracts and do not establish transport cancellation timing.

Related contracts: [local database lifecycle](database-lifecycle.md) and
[settings lifecycle](settings-lifecycle.md).
