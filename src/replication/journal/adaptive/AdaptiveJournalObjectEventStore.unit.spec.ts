import type { DocumentID, EntryDoc } from "@lib/common/types.ts";
import { describe, expect, it } from "vitest";

import {
    AdaptiveJournalCatalogueV1,
    adaptiveJournalCommitObjectKeyV1,
    adaptiveJournalWriterObjectKeyV1,
} from "./AdaptiveJournalCatalogue.ts";
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
import { encodeAdaptiveJournalMetadataRecordV1 } from "./AdaptiveJournalPayload.ts";
import type { ImmutableCreate, RemoteRead } from "./AdaptiveJournalRepository.ts";
import { AdaptiveRecordKindV1, encodeRecordFrameV1 } from "./AdaptiveJournalRecord.ts";

function sequence(start: number): Uint8Array {
    return Uint8Array.from({ length: 32 }, (_, index) => (start + index) & 0xff);
}

class MemoryObjectRemote implements AdaptiveJournalObjectRemoteV1 {
    readonly creates: string[] = [];
    readonly objects = new Map<string, Uint8Array>();
    readonly reads: string[] = [];

    async createAdaptiveObject(key: string, bytes: Uint8Array): Promise<ImmutableCreate> {
        this.creates.push(key);
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
    it("reuses an immutable Writer record after its first visible read", async () => {
        const candidate = await createAdaptiveJournalManifestV1({
            encryption: "unencrypted",
            repositoryId: sequence(0x08),
            securitySeed: sequence(0x78),
        });
        const writerStreamId = sequence(0x18);
        const writerKey = adaptiveJournalWriterObjectKeyV1(writerStreamId);
        const descriptor = new Uint8Array([1, 2, 3]);
        const remote = new MemoryObjectRemote();
        remote.objects.set(writerKey, descriptor);
        const store = createAdaptiveJournalObjectEventStoreV1({
            catalogue: new AdaptiveJournalCatalogueV1(),
            keys: candidate.keys,
            remote,
        });

        await expect(store.readWriter(writerStreamId)).resolves.toEqual({ status: "found", value: descriptor });
        await expect(store.readWriter(writerStreamId)).resolves.toEqual({ status: "found", value: descriptor });

        expect(remote.reads).toEqual([writerKey]);
    });

    it("does not cache a Writer record before it becomes visible", async () => {
        const candidate = await createAdaptiveJournalManifestV1({
            encryption: "unencrypted",
            repositoryId: sequence(0x07),
            securitySeed: sequence(0x77),
        });
        const writerStreamId = sequence(0x17);
        const writerKey = adaptiveJournalWriterObjectKeyV1(writerStreamId);
        const descriptor = new Uint8Array([4, 5, 6]);
        const remote = new MemoryObjectRemote();
        const store = createAdaptiveJournalObjectEventStoreV1({
            catalogue: new AdaptiveJournalCatalogueV1(),
            keys: candidate.keys,
            remote,
        });

        await expect(store.readWriter(writerStreamId)).resolves.toEqual({ status: "missing" });
        remote.objects.set(writerKey, descriptor);
        await expect(store.readWriter(writerStreamId)).resolves.toEqual({ status: "found", value: descriptor });

        expect(remote.reads).toEqual([writerKey, writerKey]);
    });

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

    it("publishes Metadata, routes, and a small Pack as one immutable Commit Bundle", async () => {
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
        const metadata = await encodeAdaptiveJournalMetadataRecordV1({
            codec: "none",
            documents: [
                {
                    _id: "notes/bundle.md" as DocumentID,
                    _rev: "1-bundle",
                    children: [] as DocumentID[],
                    type: "newnote",
                } as EntryDoc,
            ],
            keys: candidate.keys,
            sequence: 1n,
            writerStreamId,
        });
        const requiredChunkKeysDigest = await sha256(chunkKey);
        const commitKey = adaptiveJournalCommitObjectKeyV1(writerStreamId, 1n);
        const route = {
            container: "bundle" as const,
            entries: pack.entries,
            objectKey: commitKey,
            packBytes: pack.packBytes.byteLength,
            packId: pack.packId,
        };
        const commitRecord = await encodeAdaptiveJournalCommitRecordV1({
            chunkPacks: [route],
            keys: candidate.keys,
            metadata: {
                bytes: metadata.bytes.byteLength,
                digest: metadata.digest,
            },
            previousCommitDigest: null,
            requiredChunkKeysDigest,
            sequence: 1n,
            writerStreamId,
        });
        const envelope = await encodeCommitEnvelopeV1({
            commitFrame: commitRecord.bytes,
            inlinePack: pack.packBytes,
            metadataDigest: metadata.digest,
            metadataFrame: metadata.bytes,
            previousCommitDigest: null,
            repositoryId: candidate.keys.repositoryId,
            requiredChunkKeys: [chunkKey],
            sequence: 1n,
            writerStreamId,
        });
        const remote = new MemoryObjectRemote();
        const catalogue = new AdaptiveJournalCatalogueV1();
        const store = createAdaptiveJournalObjectEventStoreV1({
            catalogue,
            keys: candidate.keys,
            remote,
        });
        await expect(
            store.putMetadataBatch({
                metadataDigest: metadata.digest,
                metadataFrame: metadata.bytes,
                sequence: 1n,
                writerStreamId,
            })
        ).resolves.toEqual({ status: "ok", result: "inserted" });
        expect(remote.objects.size).toBe(0);
        expect(catalogue.locations(chunkKey)).toEqual([]);

        await expect(store.commitMetadataBatch(envelope.bytes)).resolves.toEqual({
            status: "ok",
            result: "inserted",
            commitDigest: commitRecord.digest,
        });
        expect(remote.reads).toEqual([]);
        expect(remote.objects).toEqual(new Map([[commitKey, envelope.bytes]]));
        expect(catalogue.locations(chunkKey)).toEqual([
            expect.objectContaining({ container: "bundle", objectKey: commitKey }),
        ]);
        await expect(store.readCommit(writerStreamId, 1n)).resolves.toEqual({
            status: "found",
            value: commitRecord.bytes,
        });
        await expect(store.readMetadata(writerStreamId, 1n)).resolves.toEqual({
            status: "found",
            value: metadata.bytes,
        });
        expect(remote.reads).toEqual([]);
        await expect(store.commitMetadataBatch(envelope.bytes)).resolves.toEqual({
            status: "ok",
            result: "exact-existing",
            commitDigest: commitRecord.digest,
        });
        expect(remote.reads).toEqual([commitKey]);

        const conflictingPack = pack.packBytes.slice();
        conflictingPack[0] ^= 0xff;
        const conflictingEnvelope = await encodeCommitEnvelopeV1({
            commitFrame: commitRecord.bytes,
            inlinePack: conflictingPack,
            metadataDigest: metadata.digest,
            metadataFrame: metadata.bytes,
            previousCommitDigest: null,
            repositoryId: candidate.keys.repositoryId,
            requiredChunkKeys: [chunkKey],
            sequence: 1n,
            writerStreamId,
        });
        remote.objects.set(commitKey, conflictingEnvelope.bytes);
        const conflictingStore = createAdaptiveJournalObjectEventStoreV1({
            catalogue: new AdaptiveJournalCatalogueV1(),
            keys: candidate.keys,
            remote,
        });
        await expect(conflictingStore.readCommit(writerStreamId, 1n)).resolves.toEqual({
            failure: { category: "invalid-response", retry: "never" },
            status: "failed",
        });
    });

    it("publishes a large change as one external Pack followed by one Commit Bundle", async () => {
        const candidate = await createAdaptiveJournalManifestV1({
            encryption: "unencrypted",
            repositoryId: sequence(0x11),
            securitySeed: sequence(0x81),
        });
        const writerStreamId = sequence(0x31);
        const chunkKey = sequence(0x51);
        const chunk = await encodeRecordFrameV1({
            codec: "none",
            keys: candidate.keys,
            kind: AdaptiveRecordKindV1.Chunk,
            logicalKey: chunkKey,
            plaintext: new TextEncoder().encode("external Pack Chunk"),
        });
        const pack = await buildAdaptiveJournalPackV1({
            chunks: [{ frame: chunk.bytes, key: chunkKey }],
            keys: candidate.keys,
        });
        const metadata = await encodeAdaptiveJournalMetadataRecordV1({
            documents: [
                {
                    _id: "notes/external.md" as DocumentID,
                    _rev: "1-external",
                    children: [] as DocumentID[],
                    type: "newnote",
                } as EntryDoc,
            ],
            keys: candidate.keys,
            sequence: 1n,
            writerStreamId,
        });
        const remote = new MemoryObjectRemote();
        const publicationCache = new AdaptiveJournalObjectPublicationCacheV1(remote);
        const published = await publishAdaptiveJournalPackV1({ pack, publicationCache, remote });
        if (published.status !== "ok") throw new Error("Pack publication failed");
        const route = {
            container: "pack" as const,
            entries: pack.entries,
            objectKey: published.packKey,
            packBytes: pack.packBytes.byteLength,
            packId: pack.packId,
        };
        const commitRecord = await encodeAdaptiveJournalCommitRecordV1({
            chunkPacks: [route],
            keys: candidate.keys,
            metadata: { bytes: metadata.bytes.byteLength, digest: metadata.digest },
            previousCommitDigest: null,
            requiredChunkKeysDigest: await sha256(chunkKey),
            sequence: 1n,
            writerStreamId,
        });
        const envelope = await encodeCommitEnvelopeV1({
            commitFrame: commitRecord.bytes,
            metadataDigest: metadata.digest,
            metadataFrame: metadata.bytes,
            previousCommitDigest: null,
            repositoryId: candidate.keys.repositoryId,
            requiredChunkKeys: [chunkKey],
            sequence: 1n,
            writerStreamId,
        });
        const commitKey = adaptiveJournalCommitObjectKeyV1(writerStreamId, 1n);

        const missingDependencyRemote = new MemoryObjectRemote();
        const recoveringWithoutPack = createAdaptiveJournalObjectEventStoreV1({
            catalogue: new AdaptiveJournalCatalogueV1(),
            keys: candidate.keys,
            remote: missingDependencyRemote,
        });
        await expect(recoveringWithoutPack.commitMetadataBatch(envelope.bytes)).resolves.toMatchObject({
            status: "failed",
            failure: { category: "unavailable", retry: "later" },
        });
        expect(missingDependencyRemote.objects.has(commitKey)).toBe(false);

        const store = createAdaptiveJournalObjectEventStoreV1({
            catalogue: new AdaptiveJournalCatalogueV1(),
            keys: candidate.keys,
            publicationCache,
            remote,
        });

        await expect(store.commitMetadataBatch(envelope.bytes)).resolves.toMatchObject({
            result: "inserted",
            status: "ok",
        });
        expect(remote.creates).toEqual([published.packKey, commitKey]);
        expect(remote.reads).toEqual([]);
        expect(remote.objects.size).toBe(2);

        remote.reads.length = 0;
        const recoveredStore = createAdaptiveJournalObjectEventStoreV1({
            catalogue: new AdaptiveJournalCatalogueV1(),
            keys: candidate.keys,
            remote,
        });
        await expect(recoveredStore.commitMetadataBatch(envelope.bytes)).resolves.toMatchObject({
            result: "exact-existing",
            status: "ok",
        });
        expect(remote.reads).toEqual([published.packKey, commitKey]);
    });
});
