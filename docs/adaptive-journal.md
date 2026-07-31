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

Packs and catalogues are immutable. Changing one Chunk creates any newly required pack and catalogue records; it does not replace an existing pack. Each Metadata Commit names the authenticated catalogue Delta records needed for both newly packed and reused Chunks, so a new process can resolve the Commit without duplicating an already catalogued Chunk. A remote Rebuild removes every object under the configured prefix, including Opaque and Adaptive records, so the prefix must be dedicated to one Vault. Format inspection rejects mixed or mismatched data before synchronisation.

`whole-pack` is the portable retrieval policy. `range` can reduce transferred bytes when the service implements exact Range semantics, but it may add requests and latency. The setting records the user's deployment-specific choice; the capability probe establishes correctness rather than benchmarking or recommending a policy.

## Request model and Chunk size

Adaptive Journal does not currently justify a smaller default Chunk size than Opaque Journal. The existing Journal Sync preset remains the starting point. With the current V3 splitter, its `customChunkSize` value of `10` places the binary maximum at about 1.1 MB, while the content-defined target is about 1 MiB. Object packs make smaller Chunks tolerable because all newly required Chunks in one Metadata batch normally share one pack, but smaller Chunks still increase local records, hashing work, catalogue entries, and Range requests. Each Adaptive pack adds an exact 88-byte index entry per Chunk, in addition to a 64-byte unencrypted or 92-byte encrypted record-frame overhead before payload compression. Text splitting follows different, much smaller targets, so the binary examples below do not predict text behaviour.

The following request estimate describes the current S3 object-profile implementation, not benchmark results or a service guarantee. It assumes a settled repository, one-page listings, one registered Writer, a warm process, successful first attempts, one Metadata batch per edit, and no format inspection, manifest access, capability probe, credential exchange, retry, or pagination. An Opaque batch also remains below its 250-record and 10 MB uncompressed thresholds. A complete `sync` performs the receive phase before the publication phase, so the two rows must be added when one process does both.

| Operation                                             |                     Opaque Journal |                                                Adaptive Journal object profile |
| ----------------------------------------------------- | ---------------------------------: | -----------------------------------------------------------------------------: |
| Poll with no new Commit                               |                             1 list |                              1 Writer list + 1 Writer read + 1 Commit list = 3 |
| Publish a small edit with one new Chunk               |             1 journal-object write |                            pack + index + Delta + Metadata + Commit = 5 writes |
| Publish Metadata which uses only known Chunks         |             1 journal-object write |                                                   Metadata + Commit = 2 writes |
| Receive one small edit with one locally missing Chunk | 1 list + 1 journal-object read = 2 | 3 discovery operations + Commit + Metadata + Delta + index + pack or Range = 8 |

For more general Adaptive reads, let `W` be the number of Writers, `U` the number of catalogue dependencies not already loaded in the process, `P` the number of packs containing locally missing required Chunks, and `M` the number of locally missing required Chunks. Discovery costs `1 + 2W` operations. Applying one Commit then adds `2 + 2U + P` operations with `whole-pack`, or `2 + 2U + M` with `range`. A new process has an empty in-memory catalogue and can therefore have a larger `U`; an active process reuses authenticated dependencies. The receiver checks its local Chunk database before pack retrieval, so unchanged Chunks do not contribute to `P` or `M`.

As an illustrative upper-level model, consider 100 separately synchronised, localised edits to an incompressible 10 MiB binary file. Assume content-defined splitting resumes after one changed Chunk, every receiver already has all unchanged Chunks, and compare an average changed Chunk of 1 MiB with 256 KiB. The publisher writes about 100 MiB or 25 MiB of new Chunk payload respectively, and one receiver later reads the same amount, before Metadata and framing. In either size case, the assumptions above give about 500 Adaptive publication writes and 800 Adaptive receive operations, compared with about 100 Opaque publication writes and 200 Opaque receive operations. Smaller Chunks reduce the payload in this model, but the same PouchDB Chunk split feeds both Journal formats; it is not an Adaptive-only saving. Range retrieval can also turn one edit into several reads when an edit changes several Chunks, whereas `whole-pack` groups missing Chunks which share a pack.

These figures deliberately favour simple reasoning over prediction. Compression ratio, edit position, content-defined boundary movement, batch coalescing, multiple Writers, service latency, list pagination, process restarts, and cache lifetime can change both byte and request totals. A deployment dominated by repeated localised edits to large binary files may benefit from a smaller binary Chunk maximum, but changing the project preset requires comparative measurements. Adaptive Journal should not be presented as a request-count optimisation over Opaque Journal on S3.

## Verification scope

Commonlib owns deterministic fixture generation and focused tests for the manifest, record encodings, object packs, catalogues, publication recovery, receive frontiers, repository identity, and both delivery contracts. The S3 adapter adds focused SDK-command tests and managed MinIO integration. CLI composition and maintained-host behaviour require separate tests. See [Proven in maintained hosts](proven-in-use.md) for the current evidence boundary.
