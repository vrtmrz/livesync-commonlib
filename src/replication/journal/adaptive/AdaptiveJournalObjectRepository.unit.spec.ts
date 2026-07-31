import { describe, expect, it } from "vitest";

import {
    AdaptiveJournalCatalogueV1,
    adaptiveJournalDeltaObjectKeyV1,
    adaptiveJournalIndexObjectKeyV1,
    adaptiveJournalPackObjectKeyV1,
} from "./AdaptiveJournalCatalogue.ts";
import { bytesEqual } from "./AdaptiveJournalBinary.ts";
import { createAdaptiveJournalManifestV1 } from "./AdaptiveJournalManifest.ts";
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
        const value = this.objects.get(key);
        if (!value) return { status: "missing" };
        return {
            status: "found",
            value: range ? value.slice(range.offset, range.offset + range.length) : value.slice(),
        };
    }

    async listAdaptiveObjects(prefix: string): Promise<AdaptiveJournalObjectListV1> {
        return { status: "ok", keys: [...this.objects.keys()].filter((key) => key.startsWith(prefix)).sort() };
    }
}

describe("Adaptive Journal immutable object publication", () => {
    it("verifies pack and index before publishing a still-uncommitted catalogue delta", async () => {
        const candidate = await createAdaptiveJournalManifestV1({
            encryption: "unencrypted",
            repositoryId: sequence(0x10),
            securitySeed: sequence(0x80),
        });
        const chunkKey = sequence(0x20);
        const chunk = await encodeRecordFrameV1({
            codec: "none",
            keys: candidate.keys,
            kind: AdaptiveRecordKindV1.Chunk,
            logicalKey: chunkKey,
            plaintext: new TextEncoder().encode("object repository Chunk"),
        });
        const pack = await buildAdaptiveJournalPackV1({
            chunks: [{ frame: chunk.bytes, key: chunkKey }],
            keys: candidate.keys,
        });
        const writerStreamId = sequence(0x40);
        const remote = new MemoryObjectRemote();
        const publicationCache = new AdaptiveJournalObjectPublicationCacheV1(remote);
        const catalogue = new AdaptiveJournalCatalogueV1();

        const published = await publishAdaptiveJournalPackV1({
            keys: candidate.keys,
            pack,
            publicationCache,
            remote,
            sequence: 1n,
            writerStreamId,
        });

        expect(published.status).toBe("ok");
        if (published.status !== "ok") throw new Error("pack publication failed");
        expect(remote.reads).toEqual([]);
        expect(publicationCache.packForDelta(published.deltaKey, published.deltaDigest)).toMatchObject({
            deltaKey: published.deltaKey,
            packId: pack.packId,
        });
        expect(remote.objects.get(adaptiveJournalPackObjectKeyV1(pack.packId))).toEqual(pack.packBytes);
        expect(remote.objects.get(adaptiveJournalIndexObjectKeyV1(pack.packId))).toEqual(pack.indexFrame);
        expect(remote.objects.get(adaptiveJournalDeltaObjectKeyV1(writerStreamId, 1n))).toEqual(
            published.deltaFrame
        );
        expect(catalogue.locations(chunkKey)).toEqual([]);
        catalogue.applyCommittedPack(pack.packId, published.entries);
        expect(catalogue.locations(chunkKey)).toHaveLength(1);
    });

    it("adopts a different valid index frame for the same immutable pack on a concurrent retry", async () => {
        const candidate = await createAdaptiveJournalManifestV1({
            encryption: "encrypted",
            passphrase: "object repository passphrase",
            repositoryId: sequence(0x11),
            securitySeed: sequence(0x81),
        });
        const chunkKey = sequence(0x21);
        const chunk = await encodeRecordFrameV1({
            codec: "none",
            iv: new Uint8Array(12).fill(0x31),
            keys: candidate.keys,
            kind: AdaptiveRecordKindV1.Chunk,
            logicalKey: chunkKey,
            plaintext: new TextEncoder().encode("shared encrypted Chunk"),
            recordSalt: new Uint8Array(32).fill(0x32),
        });
        const firstPack = await buildAdaptiveJournalPackV1({
            chunks: [{ frame: chunk.bytes, key: chunkKey }],
            indexIv: new Uint8Array(12).fill(0x33),
            indexRecordSalt: new Uint8Array(32).fill(0x34),
            keys: candidate.keys,
        });
        const retryPack = await buildAdaptiveJournalPackV1({
            chunks: [{ frame: chunk.bytes, key: chunkKey }],
            indexIv: new Uint8Array(12).fill(0x35),
            indexRecordSalt: new Uint8Array(32).fill(0x36),
            keys: candidate.keys,
        });
        expect(firstPack.packId).toEqual(retryPack.packId);
        expect(firstPack.indexFrame).not.toEqual(retryPack.indexFrame);
        const remote = new MemoryObjectRemote();
        remote.objects.set(adaptiveJournalPackObjectKeyV1(firstPack.packId), firstPack.packBytes);
        remote.objects.set(adaptiveJournalIndexObjectKeyV1(firstPack.packId), firstPack.indexFrame);

        const published = await publishAdaptiveJournalPackV1({
            keys: candidate.keys,
            pack: retryPack,
            remote,
            sequence: 1n,
            writerStreamId: sequence(0x41),
        });

        expect(published.status).toBe("ok");
        if (published.status !== "ok") throw new Error("pack publication failed");
        expect(bytesEqual(published.indexFrame, firstPack.indexFrame)).toBe(true);
        expect(published.indexFrameDigest).toEqual(firstPack.indexFrameDigest);
    });

    it("fails closed when a content-addressed pack key contains different bytes", async () => {
        const candidate = await createAdaptiveJournalManifestV1({
            encryption: "unencrypted",
            repositoryId: sequence(0x12),
            securitySeed: sequence(0x82),
        });
        const chunkKey = sequence(0x22);
        const chunk = await encodeRecordFrameV1({
            codec: "none",
            keys: candidate.keys,
            kind: AdaptiveRecordKindV1.Chunk,
            logicalKey: chunkKey,
            plaintext: new TextEncoder().encode("collision Chunk"),
        });
        const pack = await buildAdaptiveJournalPackV1({
            chunks: [{ frame: chunk.bytes, key: chunkKey }],
            keys: candidate.keys,
        });
        const remote = new MemoryObjectRemote();
        remote.objects.set(adaptiveJournalPackObjectKeyV1(pack.packId), new Uint8Array([1, 2, 3]));

        await expect(
            publishAdaptiveJournalPackV1({
                keys: candidate.keys,
                pack,
                remote,
                sequence: 1n,
                writerStreamId: sequence(0x42),
            })
        ).resolves.toMatchObject({ status: "collision", key: adaptiveJournalPackObjectKeyV1(pack.packId) });
    });
});
