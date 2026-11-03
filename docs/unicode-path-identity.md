---
date: 2026-10-19
commonlib-version: "0.1.42"
self-hosted-livesync-version: "1.0.38"
status: published
---

# Unicode path identity

`pathNormalizationVersion` controls the logical path used to derive a normal-file
Metadata document ID. An absent value or `0` preserves legacy behaviour. Value
`1` applies Unicode NFC before the existing case and ID derivation rules. It
does not alter the Metadata path or require physical files to be renamed.
Unsupported values are rejected.

NFC identity shipped in Commonlib `0.1.42` and Self-hosted LiveSync `1.0.38`.
The Journal and P2P extension is published in
[Commonlib 0.3.0](https://www.npmjs.com/package/@vrtmrz/livesync-commonlib/v/0.3.0).
The original date and reviewed versions above retain the CouchDB baseline.
CLI and Obsidian host adoption is pending in
[Self-hosted LiveSync #1309](https://github.com/vrtmrz/obsidian-livesync/pull/1309).

## Package contract

The Commonlib settings entry exposes `PathNormalizationVersion`,
`PathIdentitySettings`, `getPathNormalizationVersion`, and
`normalisePathForIdentity`. Consumers must use the shared path identity
implementation for Metadata IDs rather than add a host-specific normalisation
rule. Host storage adapters remain responsible for mapping a logical path back
to its existing physical entry.

## Initial host settings

Commonlib's shared new-Vault and stored-setting defaults retain version `0`.
The maintained CLI and Obsidian host extension uses version `1` for newly
created synchronisation settings, while retaining `0` for old settings and
Setup URIs which omit the field. Its application adoption is tracked above.
This policy does not enable NFC for WebApp or WebPeer, and does not migrate
existing databases.

The focused replication entry exports `inspectDatabasePathIdentity` and
`PathIdentityInspection`. The existing `RemoteConnectionProbe` may expose
`inspectPathIdentity` for read-only initial setup. Inspection distinguishes a
confirmed empty remote from an existing declaration; unavailable or unsupported
state rejects. Hosts use the existing declaration before first participation,
and keep source Rebuild and configured startup explicit. Journal inspection
reads milestone evidence without writing a node, Security Seed, or checkpoint.
A P2P signalling probe does not establish peer database identity; Setup URIs
carry the selected mode, and manual configuration must match the source.

## Database compatibility

Version `1` uses `nfc-path-identity-v1` in the existing generation-13
`used_features` list. This is separate from `idDerivationVersion`, which selects
the cryptographic ID key. The NFC setting is a required Tweak even when
encryption is disabled.

A fresh database declares the feature before its first Metadata mutation. An
existing database without the feature cannot acquire it through an ordinary
Metadata write or replication while it already contains Metadata. A client
configured for version `0` refuses an NFC database. These checks also apply
when ordinary configuration-mismatch warnings are disabled. The existing
version-document reception hook stops an active replication session when it
detects incompatible path identity. It does not revoke server credentials or
atomically cancel work already admitted by another device.

Fast Fetch checkpoints include the path identity version, so a checkpoint
created under version `0` cannot resume under version `1`, or vice versa.

## Migration contract

1. Update every participating client, stop synchronisation, and retain a
   complete backup.
2. Select a complete, authoritative Vault. Resolve distinct files or Metadata
   documents which would derive the same NFC document ID. Case-insensitive
   handling also applies its existing case rule.
3. Set version `1` on the source and Rebuild both databases from that Vault.
4. Set version `1` on the remaining clients and Fetch the rebuilt remote before
   resuming synchronisation.

Reconstruction checks the available storage listing and local Metadata before
resetting either database. When the local database is not open, the storage
check conservatively includes every listed file. A collision stops the
operation; it never chooses a file to keep or merges separate histories.
Ordinary synchronisation does not rename legacy document IDs in place.

Full Rebuild, Standard Fetch, and Fast Fetch replace the local database. Their
Metadata check requests conflict information and excludes a logically deleted
document (`deleted: true`) only when it has no unresolved conflict leaves.
A deleted winner with any unresolved conflict remains a collision candidate.
Remote-only Rebuild retains logically deleted Metadata and still requires its
stored document IDs to match the selected identity.

A fully tombstoned document is already absent from ordinary Metadata
enumeration. A deletion made only on the remote does not exclude a still
non-deleted local document until that deletion has been replicated.

The Setup URI shares `pathNormalizationVersion`; an absent value decodes as
legacy mode, and unsupported versions are rejected. Importing a shared value
does not itself perform the required reconstruction.

## Supported hosts

The published Commonlib `0.3.0` package includes NFC protocol support for
Journal and P2P. The matching Self-hosted LiveSync CLI and Obsidian host
adoption remains an unreleased candidate tracked by
[pull request #1309](https://github.com/vrtmrz/obsidian-livesync/pull/1309);
the package protocol support alone does not mean those host integrations have
shipped.

The shared `/storage` resolver, Node and File System Access adapters, and
explicit `DirectFileManipulator` path-version option are later unpublished
additions described in the [shared storage path design](design_docs/storage_path_resolution.md).
They are not in the registry artefact `0.3.0` and require a new immutable
Commonlib package version. A source checkout carrying the same version string
does not make these additions part of the published artefact.

| Consumer surface | Published baseline | Current candidate status |
| --- | --- | --- |
| CLI and Obsidian with CouchDB | NFC identity is released in Commonlib `0.1.42` and Self-hosted LiveSync `1.0.38`. | The unreleased LiveSync candidate adds the shared Node resolver in the CLI and shared namespace/comparison helpers in Obsidian. |
| CLI and Obsidian with Journal or P2P | Commonlib `0.3.0` publishes the NFC protocol support. | Matching host adoption remains unreleased pending [LiveSync #1309](https://github.com/vrtmrz/obsidian-livesync/pull/1309). |
| Bridge | Legacy version `0` remains the default baseline. | The Bridge candidate enables version `1` only by explicit peer opt-in; every peer in a group must use the same path version. Its ordinary case-mismatch check remains separate from the required version check. |
| WebApp | Legacy version `0` only. | WebApp remains Legacy-only; an explicit version `1` is rejected at startup. The browser storage primitive alone does not enable application support. |
| WebPeer | A vaultless P2P utility. | It is not an NFC filesystem host. |
| `DirectFileManipulator` | The published package rejects a remote declaring the NFC feature. | The unpublished option defaults to version `0`, accepts explicit `0` or `1`, and rejects a populated database in the opposite mode. The caller still owns physical path handling. |

`PathService` owns logical ID derivation. In the unreleased LiveSync host
candidate, the CLI resolves NFC-equivalent names against directory entries
while preserving the actual entry spelling; its generic Node storage contract
remains exact-path access. Obsidian supplies its normalised storage paths and
preserves an existing physical spelling when it is NFC-equivalent to the
received path.

Journal uses compatibility range `4` for NFC identity, independently of
encryption and path obfuscation. Legacy ranges remain unchanged. The existing
stored node ranges and required Tweak reject a different identity even when
ordinary mismatch warnings are disabled. Removing preferred Tweaks does not
remove the range check or an existing document-ID agreement proof. The existing
ID check is also reused before Fetch and ordinary milestone updates. A missing
milestone over existing journals requires Rebuild in both legacy and NFC modes;
it is not permission to declare a new identity. Older clients must be updated
before migration; their explicit version-check override is outside this
compatibility guarantee.

The same read-only identity assessment runs before a Journal Fetch resets the
local database and before ordinary milestone updates. It does not publish a
node, create a Security Seed, or change a checkpoint. Rebuild first locks the
existing milestone for the rebuilding node, retaining an existing compatibility
range for that node and preserving the old identity evidence and Tweaks until
the journals are deleted. Deletion lists the keys once, retaining skipped control
document keys until all Journal pages have been processed. It then removes those
control documents, including the milestone and Security Seed, in finite batches.
A repeated or backwards listing cursor stops the reset before those control
documents are removed. A partial failure or interrupted request during Journal
deletion retains those control documents and the transfer checkpoint for a retry. Checkpoints reset only after control
document deletion also succeeds. A missing milestone stays absent during this
step. The replacement identity is declared after deletion succeeds, so a failed
or interrupted deletion cannot label the old journals with the new identity.

P2P uses its existing Tweak exchange and version document to check both peers
before ordinary data replication. Missing path settings mean version `0`.
Local Metadata without the matching feature requires Rebuild. A fresh database
with only control documents may declare the existing NFC feature. Connection
state is renewed when the selected identity changes. This adds no
authentication protocol or persistent admission store; all participating peers
must be updated and migrated.

Journal migration rebuilds the source local database and remote journals. P2P
Rebuild prepares only the source local database. Other devices replace their
local databases through Fetch. The existing local reset destroys Journal KV
checkpoints; the P2P source mark and target checkpoint handle database
replacement. These operations do not rewrite IDs or merge histories in place.
P2P retains its existing source selection during Fetch.

Published Commonlib direct file access refuses a remote which declares the NFC
feature. The unpublished `DirectFileManipulator` addition exposes explicit
`pathNormalizationVersion` options, defaulting to `0`: missing or `0` retains
Legacy and rejects an NFC database; `1` accepts NFC and rejects a populated
Legacy database before feature negotiation can change its declaration. A
confirmed empty database follows the existing first-write feature contract.
Direct integrations must establish physical path resolution before offering
this setting; database admission alone does not provide that host behaviour. The regression tests cover ASCII,
NFC, NFD, and mixed paths through in-memory PouchDB Metadata lookup, with and
without path obfuscation, plus database admission, reconstruction ordering,
collisions, and physical path handling. These tests do not establish native
iOS or macOS filesystem behaviour.

The full host setting, Rebuild/Fetch, CLI, and Obsidian migration contract is
in the [Self-hosted LiveSync Unicode path identity design](https://github.com/vrtmrz/obsidian-livesync/blob/main/docs/design_docs/unicode_path_identity.md)
and its [decision record](https://github.com/vrtmrz/obsidian-livesync/blob/main/docs/adr/2026_10_unicode_path_identity.md).
