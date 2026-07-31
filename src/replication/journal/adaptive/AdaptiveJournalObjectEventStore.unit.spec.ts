import { describe, expect, it } from "vitest";

import {
    AdaptiveJournalCatalogueV1,
    adaptiveJournalCommitObjectKeyV1,
    adaptiveJournalMetadataObjectKeyV1,
    adaptiveJournalPackObjectKeyV1,
    adaptiveJournalWriterObjectKeyV1,
} from "./AdaptiveJournalCatalogue.ts";
import { concatBytes, u64be } from "./AdaptiveJournalBinary.ts";
import { encodeCommitEnvelopeV1 } from "./AdaptiveJournalCommit.ts";
import { encodeAdaptiveJournalCommitRecordV1 } from "./AdaptiveJournalControl.ts";
import { createAdaptiveJournalManifestV1, sha256 } from "./AdaptiveJournalManifest.ts";
import { createAdaptiveJournalObjectEventStoreV1 } from "./AdaptiveJournalObjectEventStore.ts";
import type {
    AdaptiveJournalByteRangeV1,
    AdaptiveJournalObjectListV1,
    AdaptiveJournalObjectRemoteV1,
} from "./AdaptiveJournalObjectStore.ts";
import { AdaptiveJournalObjectPublicationCacheV1 } from "./AdaptiveJournalObjectPublicationCache.ts";
import { publishAdaptiveJournalPackV1 } from "./AdaptiveJournalObjectRepository.ts";
import { buildAdaptiveJournalPackV1 } from "./AdaptiveJournalPack.ts";
import type { ImmutableCreate, RemoteRead } from "./AdaptiveJournalRepository.ts";
import { AdaptiveRecordKindV1, encodeRecordFrameV1 } from "./AdaptiveJournalRecord.ts";

function sequence(start: number): Uint8Array {
    return Uint8Array.from({ length: 32 }, (_, index) => (start + index) & 0xff);
}

class MemoryObjectRemote implements AdaptiveJournalObjectRemoteV1 {
    readonly objects = new Map<string, Uint8Array>();
    readonly reads: string[] = [];

    async createAdaptiveObject(key: string, bytes: Uint8Array): Promise<ImmutableCreate> {
        if (this.objects.has(key)) return { status: "already-exists" };
        this.objects.set(key, bytes.slice());
        return { status: "created" };
    }

    async readAdaptiveObject(key: string, range?: AdaptiveJournalByteRangeV1): Promise<RemoteRead<Uint8Array>> {
        this.reads.push(key);
        const bytes = this.objects.get(key);
        if (!bytes) return { status: "missing" };
        return {
            status: "found",
            value: range ? bytes.slice(range.offset, range.offset + range.length) : bytes.slice(),
        };
    }

    async listAdaptiveObjects(prefix: string): Promise<AdaptiveJournalObjectListV1> {
        return { status: "ok", keys: [...this.objects.keys()].filter((key) => key.startsWith(prefix)).sort() };
    }
}

describe("Adaptive Journal object-store final commit", () => {
    it("discovers every Writer independently and lists dense candidates after each frontier", async () => {
        const candidate = await createAdaptiveJournalManifestV1({
            encryption: "unencrypted",
            repositoryId: sequence(0x09),
            securitySeed: sequence(0x79),
        });
        const firstWriter = sequence(0x20);
        const secondWriter = sequence(0x40);
        const remote = new MemoryObjectRemote();
        remote.objects.set(adaptiveJournalWriterObjectKeyV1(secondWriter), new Uint8Array([2]));
        remote.objects.set(adaptiveJournalWriterObjectKeyV1(firstWriter), new Uint8Array([1]));
        remote.objects.set(adaptiveJournalCommitObjectKeyV1(firstWriter, 1n), new Uint8Array([1]));
        remote.objects.set(adaptiveJournalCommitObjectKeyV1(firstWriter, 2n), new Uint8Array([2]));
        remote.objects.set(adaptiveJournalCommitObjectKeyV1(secondWriter, 1n), new Uint8Array([3]));
        const store = createAdaptiveJournalObjectEventStoreV1({
            catalogue: new AdaptiveJournalCatalogueV1(),
            keys: candidate.keys,
            remote,
        });

        await expect(store.listWriterStreamIds()).resolves.toEqual({
            status: "ok",
            writerStreamIds: [firstWriter, secondWriter],
        });
        await expect(store.listCommitSequences(firstWriter, 1n)).resolves.toEqual({
            sequences: [2n],
            status: "ok",
        });
        await expect(store.listCommitSequences(secondWriter, 0n)).resolves.toEqual({
            sequences: [1n],
            status: "ok",
        });
    });

    it("keeps Metadata invisible until every pack dependency verifies, then applies its catalogue atomically", async () => {
        const candidate = await createAdaptiveJournalManifestV1({
            encryption: "unencrypted",
            repositoryId: sequence(0x10),
            securitySeed: sequence(0x80),
        });
        const writerStreamId = sequence(0x30);
        const chunkKey = sequence(0x50);
        const chunk = await encodeRecordFrameV1({
            codec: "none",
            keys: candidate.keys,
            kind: AdaptiveRecordKindV1.Chunk,
            logicalKey: chunkKey,
            plaintext: new TextEncoder().encode("object-store committed Chunk"),
        });
        const pack = await buildAdaptiveJournalPackV1({
            chunks: [{ frame: chunk.bytes, key: chunkKey }],
            keys: candidate.keys,
        });
        const remote = new MemoryObjectRemote();
        const packPublication = await publishAdaptiveJournalPackV1({
            keys: candidate.keys,
            pack,
            remote,
            sequence: 1n,
            writerStreamId,
        });
        if (packPublication.status !== "ok") throw new Error("pack publication failed");

        const metadataLogicalKey = concatBytes(writerStreamId, u64be(1n));
        const metadata = await encodeRecordFrameV1({
            codec: "none",
            keys: candidate.keys,
            kind: AdaptiveRecordKindV1.MetadataBatch,
            logicalKey: metadataLogicalKey,
            plaintext: new TextEncoder().encode("Metadata batch payload"),
        });
        const requiredChunkKeysDigest = await sha256(chunkKey);
        const commitRecord = await encodeAdaptiveJournalCommitRecordV1({
            catalogueDeltas: [{ digest: packPublication.deltaDigest, key: packPublication.deltaKey }],
            keys: candidate.keys,
            metadata: {
                bytes: metadata.bytes.byteLength,
                digest: metadata.digest,
                key: adaptiveJournalMetadataObjectKeyV1(writerStreamId, 1n),
            },
            previousCommitDigest: null,
            requiredChunkKeysDigest,
            sequence: 1n,
            writerStreamId,
        });
        const envelope = await encodeCommitEnvelopeV1({
            commitFrame: commitRecord.bytes,
            metadataDigest: metadata.digest,
            previousCommitDigest: null,
            repositoryId: candidate.keys.repositoryId,
            requiredChunkKeys: [chunkKey],
            sequence: 1n,
            writerStreamId,
        });
        const catalogue = new AdaptiveJournalCatalogueV1();
        const publicationCache = new AdaptiveJournalObjectPublicationCacheV1(remote);
        const store = createAdaptiveJournalObjectEventStoreV1({
            catalogue,
            keys: candidate.keys,
            publicationCache,
            remote,
        });
        remote.reads.length = 0;
        const descriptor = new TextEncoder().encode("writer descriptor frame");
        await expect(
            store.registerWriter({
                descriptorDigest: await sha256(descriptor),
                descriptorFrame: descriptor,
                writerStreamId,
            })
        ).resolves.toEqual({ status: "ok", result: "inserted" });
        expect(remote.reads).toEqual([]);
        await expect(store.readWriter(writerStreamId)).resolves.toEqual({ status: "found", value: descriptor });
        await expect(
            store.putMetadataBatch({
                metadataDigest: metadata.digest,
                metadataFrame: metadata.bytes,
                sequence: 1n,
                writerStreamId,
            })
        ).resolves.toEqual({ status: "ok", result: "inserted" });
        await expect(store.readMetadata(writerStreamId, 1n)).resolves.toEqual({
            status: "found",
            value: metadata.bytes,
        });
        remote.reads.length = 0;

        const packKey = adaptiveJournalPackObjectKeyV1(pack.packId);
        const savedPack = remote.objects.get(packKey)!;
        remote.objects.delete(packKey);
        await expect(store.commitMetadataBatch(envelope.bytes)).resolves.toMatchObject({ status: "failed" });
        expect(remote.objects.has(adaptiveJournalCommitObjectKeyV1(writerStreamId, 1n))).toBe(false);
        expect(catalogue.locations(chunkKey)).toEqual([]);

        remote.objects.set(packKey, savedPack);
        publicationCache.rememberPack({
            deltaDigest: packPublication.deltaDigest,
            deltaKey: packPublication.deltaKey,
            entries: packPublication.entries,
            packId: pack.packId,
        });
        remote.reads.length = 0;
        await expect(store.commitMetadataBatch(envelope.bytes)).resolves.toEqual({
            status: "ok",
            result: "inserted",
            commitDigest: commitRecord.digest,
        });
        expect(remote.reads).toEqual([]);
        expect(catalogue.locations(chunkKey)).toHaveLength(1);
        await expect(store.commitMetadataBatch(envelope.bytes)).resolves.toEqual({
            status: "ok",
            result: "exact-existing",
            commitDigest: commitRecord.digest,
        });
        await expect(store.readCommit(writerStreamId, 1n)).resolves.toEqual({
            status: "found",
            value: commitRecord.bytes,
        });
    });
});
