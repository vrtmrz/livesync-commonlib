---
date: 2026-10-19
commonlib_version: '0.1.43'
livesync_version: '1.0.38'
status: unreleased
---

# Database diagnostics

The focused `/diagnostics` entry supplies read-only database usage analysis and integrity inspection. Hosts choose original names or temporary pseudonyms before each run, provide progress and cancellation controls, and present the resulting reports. Analysis uses the original identifiers; name projection happens afterwards.

Usage retains the existing available-revision selection and incremental chunk accounting. The first processed reference counts a chunk as unique; later references count it as shared. Sizes count JavaScript string units, as in the existing report. These columns do not measure physical database size or establish whether a chunk can be deleted.

Integrity inspection enumerates actual stored document IDs, including logically deleted normal-file Metadata and current conflict branches. It uses the same identity classifier as the existing Metadata inspector. It reads content only for groups with identity discrepancies, conflicting branches, duplicate path claims, or differences between the inspected local and remote Metadata. Content comparisons use reconstructed bytes, including the Vault file where available. Missing, unreadable, and uninspected content remain distinct outcomes. Equal content within this scope does not establish that an entry is safe to delete.

The first implementation supports the local database and CouchDB. Internal-file, customisation, and plug-in storage Metadata, older revision history, and other remote backends are explicitly outside integrity inspection. Usage continues to cover the revisions available to its local source. A remote failure retains the local findings and marks the integrity report partial.

The CouchDB reader only sends GET requests. It reads existing synchronisation parameters when decryption needs a Security Seed and never creates missing parameters, initialises a database, or invokes replication admission. Local content reads do not fetch or cache remote Chunks. Owned requests are cancelled and released when the run ends; host-native request adapters may finish an already dispatched request after cancellation, but its result is discarded.

Database update sequences and the host's configuration identity are checked again before completion. Storage readers must detect changes while reading a file. These observations can detect concurrent changes; they do not provide an atomic snapshot or prevent a file from changing later.

Reports project a whitelist of facts. Pseudonyms preserve exact path equality across sources and keep document, revision, and Chunk identifiers separate. Case and Unicode normalisation facts are computed before projection. Maps are local to one run and are not persisted. Original-name mode still excludes credentials, connection addresses, encryption keys, raw errors, and file contents. JSON and Markdown use the same projected integrity result; TSV uses the same name mapper for Usage.

Hosts may pass Commonlib, plug-in, and application versions to either report projector through its optional third argument. Only those three version fields are retained. Integrity reports also retain the five identity-related settings used for the inspection; credentials and the active connection configuration remain outside the report.
