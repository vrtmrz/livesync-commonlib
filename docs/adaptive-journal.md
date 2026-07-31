# Adaptive Journal protocol

Adaptive Journal is an experimental v1 synchronisation protocol for publishing Metadata and delivering Chunks without requiring a CouchDB-compatible server. The `/adaptive-journal` entry exposes transport-independent wire formats, immutable publication state machines, recovery rules, and test fixtures. It does not expose a ready-to-run replication client.

## Repository and record ownership

Each repository has an immutable manifest containing a random repository identity, a security seed, and the capabilities required by the protocol. A client binds that identity to its local state when it creates or attaches to the repository. If the remote is rebuilt with a different identity, the client must stop and require an explicit attach or rebuild decision rather than continuing against unrelated data.

Metadata records refer to Chunks; raw file content is not stored in a Metadata record. The core supports two delivery profiles:

- the object profile aggregates Chunks into immutable packs, publishes immutable catalogue records, and reads a selected pack either as a complete object or through an exact byte range; and
- the native profile delegates immutable Chunk batches and writer or commit discovery to a storage contract which can provide those semantics transactionally.

Both profiles use content-derived remote Chunk keys. Re-publishing the same Chunk therefore addresses the same immutable value without persisting a random per-Chunk secret. Writer streams remain independent, and immutable commit publication is the visibility boundary for a Metadata batch.

## Failure and retry boundary

Immutable creation distinguishes a confirmed create, an existing key, and a failed operation. A failed mutation also states whether retry is forbidden, may happen later, or requires an exact read-back first because the request outcome was ambiguous. Transport adapters must preserve this distinction. Treating every network failure as a safe blind retry can replace evidence about a write which already reached the remote.

The protocol requires binary fidelity, complete discovery, conditional immutable creation, deletion visibility, and read-after-write behaviour. A delivery profile may require further capabilities. Exact byte-range reads are required only when the host selects Range retrieval.

## Consumer boundary

Import protocol primitives through the focused entry:

```ts
import {
    openAdaptiveJournalRepositoryV1,
    type AdaptiveJournalManifestRemoteV1,
} from "@vrtmrz/livesync-commonlib/adaptive-journal";
```

The host remains responsible for durable local binding storage, credentials, remote adapter construction, synchronisation scheduling, local database application, user choices, and disposal. The protocol core does not select a provider or infer that matching TypeScript methods provide the required semantics.

Adaptive and Opaque Journal data formats are deliberately distinct. A host must detect a format mismatch and require an explicit remote Rebuild; the v1 protocol does not migrate remote data between formats.

## S3-compatible object delivery

S3-compatible Object Storage is the reference adapter for the object profile. Existing Object Storage settings remain on `opaque-v1` when the new protocol fields are absent. A host opts into Adaptive Journal by setting `journalFormat` to `adaptive-v1`:

| Setting                | Meaning                                                                                                                                                  | Default      |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| `journalFormat`        | Selects `opaque-v1` or `adaptive-v1`. The formats cannot share one configured prefix.                                                                    | `opaque-v1`  |
| `expectedRepositoryId` | Optionally pins a canonical base64url-encoded 32-byte repository identity. Local creation and attachment also record the binding in durable local state. | Empty        |
| `packReadPolicy`       | Selects complete-pack reads or exact Range reads for Adaptive Chunk retrieval.                                                                           | `whole-pack` |

The focused `/journal-storage` entry exposes these setting types and host-facing resolution helpers without importing the AWS SDK client:

```ts
import {
    REMOTE_MINIO,
    journalProtocolConfigurationForSettings,
    type RemoteDBSettings,
} from "@vrtmrz/livesync-commonlib/journal-storage";

declare const settings: RemoteDBSettings;
if (settings.remoteType === REMOTE_MINIO) {
    const protocol = journalProtocolConfigurationForSettings(settings);
    console.log(protocol.journalFormat, protocol.packReadPolicy);
}
```

Before the first Adaptive write, the adapter uses owned random probe objects to verify binary fidelity, listing visibility, conditional immutable creation, deletion visibility, read-after-write behaviour, and exact Range semantics when Range retrieval is selected. It removes only its own probe objects. A verified result is cached for the active adapter configuration; a transient failed probe is not cached.

Ordinary successful SDK responses are treated as confirmed operations, so publication does not add an immediate verification request after every write. An ambiguous mutation failure is reported as `verify-first`; the protocol then reads the exact immutable key before deciding whether a retry is safe. Immutable objects use `PutObject` with `If-None-Match: *`, listing follows every `ListObjectsV2` continuation token, and exact Range reads require a `206` response with the requested length and `Content-Range`.

Packs and catalogues are immutable. Changing one Chunk creates any newly required pack and catalogue records; it does not replace an existing pack. A remote Rebuild removes every object under the configured prefix, including Opaque and Adaptive records, so the prefix must be dedicated to one Vault. Format inspection rejects mixed or mismatched data before synchronisation.

`whole-pack` is the portable retrieval policy. `range` can reduce transferred bytes when the service implements exact Range semantics, but it may add requests and latency. The setting records the user's deployment-specific choice; the capability probe establishes correctness rather than benchmarking or recommending a policy.

## Verification scope

Commonlib owns deterministic fixture generation and focused tests for the manifest, record encodings, object packs, catalogues, publication recovery, receive frontiers, repository identity, and both delivery contracts. The S3 adapter adds focused SDK-command tests and managed MinIO integration. CLI composition and maintained-host behaviour require separate tests. See [Proven in maintained hosts](proven-in-use.md) for the current evidence boundary.
