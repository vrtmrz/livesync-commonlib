---
date: 2026-10-19
commonlib_version: '0.1.43'
livesync_version: '1.0.38'
status: unreleased
---

# Database diagnostics

The focused `/diagnostics` entry supplies read-only database usage analysis and integrity inspection. Hosts choose original names or temporary pseudonyms before each run, provide progress and cancellation controls, and present the resulting reports. Analysis uses the original identifiers; name projection happens afterwards.

Usage retains the existing available-revision selection and incremental chunk accounting. The first processed reference counts a chunk as unique; later references count it as shared. Sizes count JavaScript string units, as in the existing report. These columns do not measure physical database size or establish whether a chunk can be deleted.

Usage progress emits a `reading` phase while it discovers revisions, with `idsProcessed` and `revisionsProcessed` retained for existing consumers. `processed` counts settled available-revision reads, including failures; `total` grows as available revisions are discovered and is not final until enumeration finishes. The analyser does not pre-scan to calculate a total. The separate `accounting` phase has a fixed work-item total and yields between batches so the host can respond to cancellation. Cancellation during reading retains collected evidence; cancellation during accounting omits incomplete rows and orphan statistics. A failing progress callback does not change the result.

Integrity inspection enumerates actual stored document IDs, including logically deleted normal-file Metadata and current conflict branches. It uses the same identity classifier as the existing Metadata inspector. It reads content only for groups with identity discrepancies, conflicting branches, duplicate path claims, or differences between the inspected local and remote Metadata. Content comparisons use reconstructed bytes, including the Vault file where available. Missing, unreadable, and uninspected content remain distinct outcomes. Equal content within this scope does not establish that an entry is safe to delete.

Standard integrity observations include recorded document type, size, and total, unique, and embedded Chunk-reference counts. When suspect bytes have already been read, they also include measured decoded-content and Vault sizes, their differences from recorded or reconstructed sizes, and the Vault-to-Metadata modification-time difference. Case-only and NFC-equivalent path group membership is included once for each group. These facts use the normal decoded and decrypted Metadata and reads already needed for inspection; they do not add database, HTTP, or Vault reads. Facts which were not inspected remain absent or `not-checked`.

Integrity inspection classifies up to four Metadata documents or processes up to four suspect content groups concurrently. Hosts can set `concurrency` between one and sixteen for comparison or resource limits. Local and remote Metadata scans remain separate, and results retain enumeration order regardless of completion order. Sources with `getMany` fetch current Metadata and required Chunks in groups of up to 64 documents. Metadata classification follows each bulk read; content groups read their Chunk batches and Vault files sequentially. The CouchDB reader separately decodes up to four documents per bulk response, so `concurrency` limits analyser work rather than total concurrent decryption across active groups. Exact conflict revisions still use individual reads. Cancellation stops dispatching new work and drains active reads before releasing the remote source; collected findings remain available.

Integrity progress identifies the phase and source. Metadata progress counts completed documents, including excluded IDs, against the source's `doc_count` when available. Content progress counts completed suspect groups against their known total. Missing document totals remain unknown until enumeration finishes. A source changed during inspection can change the total and makes the report partial. Hosts should label these separate units rather than combine them into one percentage.

The optional `onLog` callback receives phase start and finish events, with progress events at most once every five seconds while work completes. Events contain counts, elapsed time, the concurrency limit, active and peak reads, read operations, and summed read duration. Read operations count requested documents; a bulk read counts once towards active reads and elapsed read duration. Summed read duration includes overlapping reads. HTTP request counts belong to the host's injected fetch boundary and can differ from document reads. Grouping has its own timing event. These events contain no paths, document identifiers, connection details, or raw errors. Progress and log callback failures do not interrupt inspection.

The first implementation supports the local database and CouchDB. Internal-file, customisation, and plug-in storage Metadata, older revision history, and other remote backends are explicitly outside integrity inspection. Usage continues to cover the revisions available to its local source. A remote failure retains the local findings and marks the integrity report partial.

`includeRemote` defaults to true. Setting it to false does not open the remote source: local identity, conflict, and duplicate-path checks still run, with content comparisons against the Vault for suspect groups. Remote coverage and cross-source comparisons remain `not-checked`, and `scope.remote` is `excluded` in JSON and Markdown reports. A local-only run can complete within that declared scope; excluding a remote is distinct from a failed connection. Hosts should collect this choice for each run rather than change synchronisation settings.

The CouchDB reader only sends GET requests. It reads existing synchronisation parameters when decryption needs a Security Seed and never creates missing parameters, initialises a database, or invokes replication admission. Local content reads do not fetch or cache remote Chunks. Owned requests are cancelled and released when the run ends; host-native request adapters may finish an already dispatched request after cancellation, but its result is discarded.

Bulk reads use `_all_docs` with selected `keys`, `include_docs`, and optional `conflicts`. The reader limits each request to 64 documents and a 6,000-character encoded URL; an individual key which exceeds that URL limit uses the existing single-document GET. ID enumeration does not include document bodies, so unrelated Chunks are not downloaded. Embedded Chunks require no request, and repeated Chunk IDs within one batch share a read. Missing rows, deleted documents, unreadable results, and failed HTTP requests retain distinct evidence; a failed batch does not establish that its documents are absent. Bulk results use the same decryption and decompression as individual reads and are released after each batch.

Database update sequences and the host's configuration identity are checked again before completion. Storage readers must detect changes while reading a file. These observations can detect concurrent changes; they do not provide an atomic snapshot or prevent a file from changing later.

Reports project a whitelist of facts. Pseudonyms preserve exact path equality across sources and keep document, revision, and Chunk identifiers separate. Case and Unicode normalisation facts are computed before projection. Maps are local to one run and are not persisted. Original-name mode still excludes credentials, connection addresses, encryption keys, raw errors, and file contents. JSON and Markdown use the same projected integrity result; TSV uses the same name mapper for Usage.

Each pseudonym report uses a random eight-character public salt. Path tokens have the form `<salt>$<hash>`; `<hash>` is the first 128 bits of a SHA-256 digest, shown as 32 lowercase hexadecimal characters. The digest is domain-separated by name kind and uses the exact stored Vault-relative path, without lower-casing or Unicode NFC normalisation. The mapper keeps no persistent salt or correspondence table. A consumer can parse a complete path token with `parseDiagnosticPathToken` and pass its salt to `createDiagnosticNameMapper('pseudonym', parsed.salt)` to reproduce path, document, revision, and Chunk pseudonyms for a targeted follow-up. Revision pseudonyms retain a valid generation prefix, such as `7-psu…`.

The salt is public, so someone with the report can test guessed path values against a token; pseudonyms are not encryption. Earlier ordinal pseudonyms cannot be looked up this way. The path-token parser only extracts a salt and hash from a complete token; it does not recover the original path.

### Compact Integrity Markdown report

Integrity Markdown retains its status, name mode, versions, settings, scope, coverage, and count summary, with separate counts for content and Vault checks which were not performed. **State counts** count observations, not unique files; each local or remote observation contributes to its state total. The **Review index** lists references to observations which match review conditions, before **Findings**. Those conditions are identity mismatches, current conflicts, case- or NFC-equivalent paths, non-NFC paths, a missing group in the other inspected source, missing or unreadable content or Vault files, unavailable Chunks, different or unavailable comparisons, non-zero measured differences, and absent Metadata. These are review candidates, not findings of corruption. An observation outside the index is still present in **Findings**, and unchecked content or Vault state is not evidence of health.

Each observation uses a compact field order while preserving every observation and its complete path, document ID, revision, and reference values:

```text
### `remote:4410` source=remote
path: `<salt>$<hash>`
doc: `<document-id>` rev=`<revision>` expected=self
state: consistent-winner-logicallyLive-NFC-newnote conflicts=0
paths: case=none nfcPeers=none | otherDB=present
data: recorded=47584B chunks=1/1/0 read=0
check: content=not-checked vault=not-checked@`vault:remote:4410`
measure: content=47584B vault=47584B deltaContent=0B deltaVault=0B deltaMtime=0ms
```

The `state` value orders identity, current branch, logical deletion, exact stored-path NFC status, and Metadata type. Identity is `consistent`, `documentIdMismatch`, or `namespaceMismatch`; JSON keeps the values `document-id-mismatch` and `namespace-mismatch` for the latter two states. The branch is `winner` or `conflict`; `winner` can coexist with a non-zero conflict count. `logicallyLive` and `logicallyDeleted` describe the deletion marker. `NFC` means the stored path is normalised to Unicode NFC; `nonNFC` means it is not. The type is `plain`, `newnote`, `notes`, or `unknown`, and is `notRecorded` when Metadata is absent. `consistent` confirms the identity check only; it does not establish readable or equal content.

`expected=self` means the actual document ID exactly matches the expected ID. Otherwise, the field contains the expected ID, or `?` if it was not recorded. In `paths`, `case` and `nfcPeers` report case-equivalent and NFC-equivalent path groups: `none` means no equivalent path was found, `yes` means one was found, and `yes@case:1` or `yes@nfc:1` adds the group reference when available. `otherDB` describes whether the same identity and path group is present in the other inspected source; it does not compare content. An excluded or unavailable source is `not-checked`.

In `data`, `chunks` is the total/unique/embedded Chunk-reference count, and `read` is the number of Chunk reads, not HTTP requests. When Metadata is absent, its recorded size and Chunk counts are `?`. A `?` means a value was not recorded; it is distinct from zero, missing, unreadable, and `not-checked`. The `check` line distinguishes `available`, `missing`, `unreadable`, and `not-checked` for content and Vault evidence; a recorded reason follows the status in parentheses. The optional `measure` line includes only available values: decoded content size and Vault size in bytes, `deltaContent` (decoded content minus recorded Metadata size), `deltaVault` (Vault size minus decoded content size), and `deltaMtime` (Vault modification time minus Metadata modification time) in milliseconds. Positive differences have a `+` prefix, negative differences retain `-`, and zero is `0`; these measurements describe collected evidence and do not select an authoritative version.

Unavailable Chunk entries, comparisons, case/NFC equivalence groups, and errors retain their names, reasons, and references. The collapsible details section and fenced text copy remain available for sharing the report. The compact Markdown representation does not change the JSON data or schema.

Integrity Markdown wraps the complete report in a `details` element and a fenced text block for pasting into an issue. The fence is longer than any backtick run in the report, including original names. This keeps the full evidence together without expanding every observation in the issue body.

Hosts may pass Commonlib, plug-in, and application versions to either report projector through its optional third argument. Only those three version fields are retained. Integrity reports also retain the five identity-related settings used for the inspection; credentials and the active connection configuration remain outside the report.
