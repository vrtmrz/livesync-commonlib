---
date: 2026-10-19
commonlib-version: "0.1.42"
self-hosted-livesync-version: "1.0.38"
status: unreleased
---

# Unicode path identity

`pathNormalizationVersion` controls the logical path used to derive a normal-file
Metadata document ID. An absent value or `0` preserves legacy behaviour. Value
`1` applies Unicode NFC before the existing case and ID derivation rules. It
does not alter the Metadata path or require physical files to be renamed.
Unsupported values are rejected.

NFC identity shipped in Commonlib `0.1.42` and Self-hosted LiveSync `1.0.38`.
The deletion handling below is an unreleased refinement of reconstruction.

## Package contract

The Commonlib settings entry exposes `PathNormalizationVersion`,
`PathIdentitySettings`, `getPathNormalizationVersion`, and
`normalisePathForIdentity`. Consumers must use the shared path identity
implementation for Metadata IDs rather than add a host-specific normalisation
rule. Host storage adapters remain responsible for mapping a logical path back
to its existing physical entry.

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

The initial support boundary is the maintained CLI and Obsidian with CouchDB.
`PathService` owns logical ID derivation. The CLI resolves NFC-equivalent names
against directory entries while preserving the actual entry spelling; its
generic Node storage contract remains exact-path access. Obsidian supplies its
normalised storage paths and preserves an existing physical spelling when it
is NFC-equivalent to the received path.

Journal and P2P refuse version `1`. Direct file access refuses a remote which
declares the NFC feature. Other host adapters must establish physical path
resolution before offering this setting. The regression tests cover ASCII,
NFC, NFD, and mixed paths through in-memory PouchDB Metadata lookup, with and
without path obfuscation, plus database admission, reconstruction ordering,
collisions, and physical path handling. These tests do not establish native
iOS or macOS filesystem behaviour.

The full host setting, Rebuild/Fetch, CLI, and Obsidian migration contract is
in the [Self-hosted LiveSync Unicode path identity design](https://github.com/vrtmrz/obsidian-livesync/blob/main/docs/design_docs/unicode_path_identity.md)
and its [decision record](https://github.com/vrtmrz/obsidian-livesync/blob/main/docs/adr/2026_10_unicode_path_identity.md).
