# Document information views and raw validation

## Status and scope

Unreleased. The focused `@vrtmrz/livesync-commonlib/documents` entry supplies
information views and synchronous shape validation. It has no host runtime
dependencies, initialisation, or disposal requirements. It does not provide a
file client, decode documents, or change stored data.

The document-contract migration is in progress. An interface describes the
information available to a function; it is not a constructor or evidence that
a database operation completed. Compatibility names remain available while
new reads distinguish Metadata from reconstructed content.

## Information views

| Type | Required information |
| --- | --- |
| `DocumentIdentity` | Tagged database ID |
| `DocumentPathRef` | Tagged document ID and logical path |
| `DeletionState` | Optional logical and database deletion markers |
| `FileProperties` | Recorded creation time, modification time, and size |
| `ContentDescription` | Logical path and optional content classification fields |
| `FileContentView` | Content description and `string` or ordered `string[]` data |
| `SplitSource` | Logical path and Blob content |
| `FileToSave` | Target identity, file attributes, and Blob content |
| `RevisionRef` | Tagged document ID and an explicit revision |
| `FetchedChunkPayload` | Raw string ID and string content |
| `RawRevisionRef` | Raw string ID and revision |
| `RawCurrentFileMetadata` | Unbranded current Metadata fields before codecs |
| `FileChangeRef` | Identity, path, optional revision, and deletion markers |
| `FileMetadataNotification` | File-change reference and file attributes |

Path helpers, deletion checks, content interpretation, and the content splitter
accept the corresponding views without requiring unrelated saved-document
fields. Existing content interpretation, including `datatype` and path-based
compatibility rules, remains unchanged.

## Save and read contracts

`FileToSave` supplies identity, path, file attributes, and Blob content.
The writer derives Chunk references and content classification; callers do not
need to invent them. `CompatibleFileToSave` additionally accepts optional
fields from existing callers. `CurrentFileDocument` excludes `data` and
`datatype` statically. Writes still construct persisted Metadata explicitly.

On `LiveSyncLocalDB`, `getFileMetadata(path, options?, includeDeleted?)` returns
`FileMetadataResponse` or `false`. Current Metadata has no content placeholder.
Legacy inline Metadata retains its body. With `includeDeleted: true`, a
body-less tombstone can instead return `DeletedFileRef`. Each successful result
carries the revision returned by that read. `getFile(path, options?,
waitForReady?, localOnly?)` reconstructs `MaterialisedFile`, with ordered
`string[]` content and a required revision. Empty content is valid; these
results do not establish freshness or successful storage reflection.

DFM exposes `getMetadata(path)` and `getFile(path)` over those contracts.
`getById(id, true)` and Metadata enumeration return `CurrentFileMetadata`;
content mode returns `CurrentFileContent`, retaining DFM's array-content
guarantee. A runtime Boolean returns their union. Watch selection receives
Metadata, while its content callback receives ordered parts. Existing `get`
and legacy entry aliases remain available; their old broad declarations do
not certify that content was reconstructed.

Path reads recognise the oldest inline `notes` and missing-`type` forms and
exclude deletions by default. ID reads retain their current-format admission,
logical-deletion handling, and raw-error policy. The new methods do not make
those policies identical. The legacy path-read correction retains inline data
until the existing path-based text or Base64 interpretation runs, including
for a selected earlier revision. It leaves the stored document unchanged.

Replication notifications request work through references and file attributes.
The reflection owner still re-reads current Metadata under its lock. Selected
revision restoration retains its separate provenance checks.

## Inspect, test, or assert a raw shape

```ts
import {
    inspectFetchedChunkPayload,
    assertRawRevisionRef,
} from "@vrtmrz/livesync-commonlib/documents";

declare const input: unknown;
const inspected = inspectFetchedChunkPayload(input);
if (inspected.ok === true) {
    const content: string = inspected.value.data;
} else {
    const fields = inspected.invalidFields;
}

assertRawRevisionRef(input);
const revision: string = input._rev;
```

Each shape has `inspect…`, `is…`, and `assert…` functions sharing one validator.
Inspection returns the original value on success. Failure reports field names
and reason codes without including payload values. Assertions throw `TypeError`
for an invalid shape. A predicate reports whether that shape is accepted.

Chunk payload validation requires string `_id` and `data` fields, accepts empty
content, and allows extra fields, including absent or unexpected `type` values.
Raw revision validation requires string `_id` and `_rev` fields. Current
Metadata validation checks `plain` or `newnote`, string identity and path,
finite file attributes, non-negative size, ordered string children, Eden
content and epochs, and any supplied revision, deletion, or conflict fields.
It accepts empty content references, repeated references, and extra fields.
Eden failures report stable paths without embedded IDs or values. These checks
do not classify an ID namespace, validate a revision's syntax or ancestry, brand
raw strings as domain IDs, or establish that data exists in a database.

Validation of these shapes does not certify reconstruction, successful
persistence, current-leaf membership, or Vault provenance. Those guarantees
remain with the operations which read and verify the relevant state. In
particular, a fetched notification is not proof that its database write
succeeded.

Current-Metadata validation is opt-in. Here, 'current' identifies the `plain`
and `newnote` formats, not the current winning or live revision. A complete
body with `_deleted: true` can satisfy the shape; a body-less tombstone cannot.
The canonical reader projects either database deletion to `DeletedFileRef`.
Legacy inline documents and encrypted representations retain their owning
decoding and compatibility paths.

File reads retain the existing typed database-model contract and admission
policies; they do not invoke the raw shape inspectors or certify that every
stored field passed validation. For example, reconstruction can consume Eden
content without `epoch`, while complete raw Metadata inspection requires it.
Malformed stored bodies can therefore fail inspection even when a compatibility
read accepts them. Strict read-boundary rejection or normalisation is a separate
change.
The retrieval classifier promises only `FetchedChunkPayload`. The existing
Chunk write/event adapter preserves original objects and optional revisions;
it does not insert a `leaf` discriminator or strengthen acceptance rules.
