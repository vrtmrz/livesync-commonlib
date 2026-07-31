# Adaptive Journal protocol

Adaptive Journal is an experimental v1 synchronisation protocol for publishing Metadata and delivering Chunks without requiring a CouchDB-compatible server. The `/adaptive-journal` entry exposes transport-independent wire formats, immutable publication state machines, recovery rules, and test fixtures. It does not expose a ready-to-run replication client.

## Repository and record ownership

Each repository has an immutable manifest containing a random repository identity, a security seed, and the capabilities required by the protocol. A client binds that identity to its local state when it creates or attaches to the repository. If the remote is rebuilt with a different identity, the client must stop and require an explicit attach or rebuild decision rather than continuing against unrelated data.

Metadata records refer to Chunks; raw file content is not stored in a Metadata record. The core supports two delivery profiles:

- the object profile aggregates newly required Chunks into immutable Packs, authenticates their routes in a Commit Bundle, and reads a selected Pack either as a complete container or through an exact byte range; and
- the native profile delegates immutable Chunk batches and writer or commit discovery to a storage contract which can provide those semantics transactionally.

Both profiles use content-derived remote Chunk keys. Re-publishing the same Chunk therefore addresses the same immutable value without persisting a random per-Chunk secret. Writer streams remain independent, and immutable Commit publication is the visibility boundary for a Metadata batch.

A Commit Bundle is the object profile's publication unit. It contains the Commit control record, the Metadata record frame, the authenticated Chunk-to-Pack routes, and, when it fits, one inline Pack. Otherwise, newly required Chunks are placed in one or more content-addressed Pack objects before the Commit Bundle is created. When encryption is enabled, the record payloads are opaque to an untrusted storage service, while the envelope still exposes identifiers, sequence and size information, digests, and remote Chunk identifiers. This does not make it an Opaque Journal batch: the authenticated internal routes, content-addressed Chunk identity, Pack reuse, and Range retrieval remain Adaptive Journal semantics.

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

Commit Bundles and external Packs are immutable. The in-memory Catalogue is a derived lookup table, not a remote object: authenticated Pack routes are applied to it whenever Commit Bundles are received, including when every referenced Chunk is already local. This local step makes the routes available to the following publication phase without another remote request. Changing one Chunk creates a new Pack when required; it does not replace an existing Pack. A later Commit can carry a route to an earlier Pack without duplicating the Chunk.

The default inline Pack limit is 8 MiB, and the maximum raw Pack size is 256 MiB. A publication whose newly required Chunks fit one Pack at or below the inline limit creates one Commit Bundle. Otherwise, it creates the required external Packs first, then creates the Commit Bundle. Most such publications need one external Pack; a very large batch is partitioned deterministically across several. Metadata-only publication and publication which reuses already catalogued Chunks also create only the Bundle. The exact Bundle bytes are staged in durable writer state before the final create, so recovery republishes the same immutable value. A failed multi-Pack publication can leave unreferenced immutable Packs, but no partial Commit becomes visible.

A remote Rebuild removes every object under the configured prefix, including Opaque and Adaptive records, so the prefix must be dedicated to one Vault. Format inspection rejects mixed or mismatched data before synchronisation. The manifest also declares the `commit-bundle-v1` object layout. A remote created by the superseded experimental Adaptive layout is detected during open and requires a Rebuild; it is not migrated in place.

`whole-pack` is the portable retrieval policy. `range` can reduce transferred bytes when the service implements exact Range semantics, but it may add requests and latency. The setting records the user's deployment-specific choice; the capability probe establishes correctness rather than benchmarking or recommending a policy.

## Request model and Chunk size

Adaptive Journal does not currently justify a smaller default Chunk size than Opaque Journal. The existing Journal Sync preset remains the starting point. With the current V3 splitter, its `customChunkSize` value of `10` places the binary maximum at about 1.1 MB, while the content-defined target is about 1 MiB. Several newly required Chunks in one Metadata batch share one Pack, so making Chunks smaller does not normally add S3 writes. It does increase local records, hashing work, Bundle route entries, and Range requests. Each Chunk record also has a 64-byte unencrypted or 92-byte encrypted frame overhead before payload compression. Route bytes use canonical JSON inside the authenticated Commit control record, so their compressed wire size is data-dependent rather than a fixed per-entry value. Text splitting follows different, much smaller targets, so the binary examples below do not predict text behaviour.

The following request estimates describe the current S3 object-profile implementation, not benchmark results or a service guarantee. They assume a settled repository, one-page listings, acknowledged first attempts, and no format inspection, manifest access, capability probe, credential exchange, retry, or pagination. A complete `sync` performs the receive phase before the publication phase, but publication and later catch-up are shown separately because an editing device commonly publishes several changes before another device next receives them.

Let:

- `B` be the number of Adaptive Metadata batches published as distinct Commit Bundles, rather than the number of user editing gestures;
- `X` be the total number of new external Pack objects created for those batches, including every partition of an unusually large batch;
- `J` be the number of Opaque journal objects produced for the same changes;
- `W` be the number of visible Writers during a receiving phase;
- `K` be the number of those Writers whose immutable descriptor has not already been read successfully by the opened process;
- `P` be the number of additional complete Pack-container reads needed for locally missing Chunks; and
- `M` be the number of locally missing Chunks read separately with Range retrieval.

### Publication from the editing device

Opaque Journal performs approximately `J` writes. Adaptive Journal performs `B + X` writes. Every batch creates one Commit Bundle. A newly required Pack at or below 8 MiB is part of that Bundle, while each external Pack contributes one preceding write. Reused Packs do not add writes.

| Published change pattern                                  | Opaque Journal | Adaptive Journal object profile |
| --------------------------------------------------------- | -------------: | ------------------------------: |
| Metadata-only, reused Chunks, or a new Pack at most 8 MiB |     `J` writes |                      `B` writes |
| Every batch requires exactly one new external Pack        |     `J` writes |                     `2B` writes |
| General case                                              |     `J` writes |                  `B + X` writes |

An acknowledged conditional create is accepted without an immediate read-back. A transport reports an ambiguous mutation as `verify-first`, in which case the exact immutable key is read before a retry. Recovery after a process restart also verifies any external dependency named by a staged Bundle. These exceptional reads are outside the successful-first-attempt model.

If changes coalesce before synchronisation, both `B` and `J` may be much smaller than the number of edits. For example, an Opaque batch remains one object while it stays below its 250-record and 10 MB uncompressed thresholds, and one Adaptive Metadata scan currently includes up to 100 local database changes. Therefore `B` and `J` must not be assumed equal in a real workload.

### Later catch-up on a receiving device

One Opaque catch-up costs approximately one listing plus one read per new journal object, or `1 + J`. One Adaptive catch-up performs one Writer listing, one Commit listing per visible Writer, and one read for each previously unseen Writer descriptor. Each new batch then requires one Commit Bundle read. That single physical read supplies the logical Commit and Metadata records and, when present, the current inline Pack.

| Retrieval policy | Approximate Adaptive catch-up operations |
| ---------------- | ---------------------------------------: |
| `whole-pack`     |                      `1 + W + K + B + P` |
| `range`          |                      `1 + W + K + B + M` |

`P` can refer to an external Pack or to an earlier Commit Bundle containing a reused inline Pack. The default Bundle cache retains at most 64 entries and 64 MiB; an evicted Bundle is read again if a later route needs its inline Pack. A host-provided Pack cache can similarly reduce repeated external Pack reads. The receiver checks its local Chunk database after decoding Metadata and before making an additional Pack or Range request. If every required Chunk is already local, the batch contributes no `P` or `M` term. The current Bundle is still read because it is the source of the Commit and Metadata records.

A successful immutable Writer descriptor read is also reused while the same repository remains open; a missing or failed read is not cached. For one established Writer, an unchanged poll therefore costs three discovery operations the first time that Writer is encountered and two on later polls in the same process. Providers with native multi-key reads may coalesce parts of these terms; the formula above counts S3 object operations.

As an illustrative model, assume 100 Adaptive batches and 100 Opaque objects are published before another device catches up once. The first Adaptive catch-up has one visible uncached Writer; the warm case has its descriptor cached.

| Scenario                                                      | Opaque Journal | Adaptive publication | Adaptive catch-up, first / warm Writer |
| ------------------------------------------------------------- | -------------: | -------------------: | -------------------------------------: |
| Every new Pack fits in its current Bundle                     |     100 writes |           100 writes |                   103 / 102 operations |
| Every new Pack is external and must be read                   |     100 writes |           200 writes |                   203 / 202 operations |
| Every new Pack is external, but all required Chunks are local |     100 writes |           200 writes |                   103 / 102 operations |
| Every batch creates two external Packs which must be read     |     100 writes |           300 writes |                   303 / 302 operations |

The corresponding Opaque catch-up is approximately 101 operations under these assumptions. This comparison deliberately holds `B = J = 100`; Opaque batching can make `J` smaller. It also excludes the one-time repository manifest and Writer registration.

For a rough byte model, consider 100 separately published, localised edits to an incompressible 10 MiB binary file. If content-defined splitting resumes after one changed Chunk, an average changed Chunk of 1 MiB contributes about 100 MiB of new payload across the 100 Bundles, while 256 KiB contributes about 25 MiB, before Metadata, routes, and framing. Both fit comfortably below the inline limit when each batch changes one Chunk, so the request counts remain the first row of the table. The same PouchDB Chunk split feeds both Journal formats, so this byte reduction is not an Adaptive-only saving.

Larger Chunks reduce route count and Range requests, but they increase transferred bytes for a localised edit and can push a multi-Chunk Pack over the inline threshold, adding at least one write. An unusually large batch can cross the 256 MiB Pack limit and add further Pack writes. Smaller Chunks have the opposite trade-off. Compression ratio, edit position, boundary movement, batch coalescing, multiple Writers, service latency, list pagination, process restarts, and cache lifetime can change the result. A different default therefore requires comparative measurements; Adaptive Journal should not be presented as an unconditional request-count optimisation over Opaque Journal on S3.

## Verification scope

Commonlib owns deterministic fixture generation and focused tests for the manifest, record encodings, Commit Bundles, object Packs, derived Catalogues, publication recovery, receive frontiers, repository identity, and both delivery contracts. The S3 adapter adds focused SDK-command tests and managed MinIO integration. CLI composition and maintained-host behaviour require separate tests. See [Proven in maintained hosts](proven-in-use.md) for the current evidence boundary.
