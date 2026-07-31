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

## Verification scope

Commonlib owns deterministic fixture generation and focused tests for the manifest, record encodings, object packs, catalogues, publication recovery, receive frontiers, repository identity, and both delivery contracts. Real provider behaviour and maintained-host composition require separate adapter, integration, CLI, and host tests. See [Proven in maintained hosts](proven-in-use.md) for the current evidence boundary.
