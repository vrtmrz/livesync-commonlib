import { describe, expect, it } from "vitest";

import { adaptiveJournalPackObjectKeyV1 } from "./AdaptiveJournalCatalogue.ts";
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
    it("publishes one content-addressed Pack and records acknowledged-create evidence", async () => {
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
        const remote = new MemoryObjectRemote();
        const publicationCache = new AdaptiveJournalObjectPublicationCacheV1(remote);

        const published = await publishAdaptiveJournalPackV1({
            pack,
            publicationCache,
            remote,
        });

        expect(published.status).toBe("ok");
        if (published.status !== "ok") throw new Error("pack publication failed");
        expect(remote.reads).toEqual([]);
        expect(
            publicationCache.hasPack({
                container: "pack",
                entries: published.entries,
                objectKey: published.packKey,
                packBytes: pack.packBytes.byteLength,
                packId: pack.packId,
            })
        ).toBe(true);
        expect(remote.objects.get(adaptiveJournalPackObjectKeyV1(pack.packId))).toEqual(pack.packBytes);
        expect(remote.objects.size).toBe(1);
    });

    it("accepts an existing identical content-addressed Pack on a concurrent retry", async () => {
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
            keys: candidate.keys,
        });
        const retryPack = await buildAdaptiveJournalPackV1({
            chunks: [{ frame: chunk.bytes, key: chunkKey }],
            keys: candidate.keys,
        });
        expect(firstPack.packId).toEqual(retryPack.packId);
        const remote = new MemoryObjectRemote();
        remote.objects.set(adaptiveJournalPackObjectKeyV1(firstPack.packId), firstPack.packBytes);

        const published = await publishAdaptiveJournalPackV1({
            pack: retryPack,
            remote,
        });

        expect(published.status).toBe("ok");
        if (published.status !== "ok") throw new Error("pack publication failed");
        expect(published.packKey).toBe(adaptiveJournalPackObjectKeyV1(firstPack.packId));
        expect(remote.reads).toEqual([published.packKey]);
        expect(remote.objects.size).toBe(1);
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
                pack,
                remote,
            })
        ).resolves.toMatchObject({ status: "collision", key: adaptiveJournalPackObjectKeyV1(pack.packId) });
    });
});
