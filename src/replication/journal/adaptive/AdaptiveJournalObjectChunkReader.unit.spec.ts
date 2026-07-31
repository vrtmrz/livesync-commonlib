import { describe, expect, it } from "vitest";

import { AdaptiveJournalCatalogueV1 } from "./AdaptiveJournalCatalogue.ts";
import { createAdaptiveJournalManifestV1 } from "./AdaptiveJournalManifest.ts";
import {
    createAdaptiveJournalObjectChunkReaderV1,
    type AdaptiveJournalPackCacheV1,
} from "./AdaptiveJournalObjectChunkReader.ts";
import type {
    AdaptiveJournalByteRangeV1,
    AdaptiveJournalObjectListV1,
    AdaptiveJournalObjectRemoteV1,
} from "./AdaptiveJournalObjectStore.ts";
import { buildAdaptiveJournalPackV1 } from "./AdaptiveJournalPack.ts";
import type { ImmutableCreate, RemoteRead } from "./AdaptiveJournalRepository.ts";
import { AdaptiveRecordKindV1, encodeRecordFrameV1 } from "./AdaptiveJournalRecord.ts";
import { adaptiveJournalPackObjectKeyV1 } from "./AdaptiveJournalCatalogue.ts";

function sequence(start: number): Uint8Array {
    return Uint8Array.from({ length: 32 }, (_, index) => (start + index) & 0xff);
}

class ReadingObjectRemote implements AdaptiveJournalObjectRemoteV1 {
    readonly reads: Array<{ key: string; range?: AdaptiveJournalByteRangeV1 }> = [];

    constructor(readonly objects: Map<string, Uint8Array>) {}

    async createAdaptiveObject(): Promise<ImmutableCreate> {
        throw new Error("unexpected create");
    }

    async listAdaptiveObjects(): Promise<AdaptiveJournalObjectListV1> {
        throw new Error("unexpected list");
    }

    async readAdaptiveObject(key: string, range?: AdaptiveJournalByteRangeV1): Promise<RemoteRead<Uint8Array>> {
        this.reads.push({ key, range });
        const bytes = this.objects.get(key);
        if (!bytes) return { status: "missing" };
        return {
            status: "found",
            value: range ? bytes.slice(range.offset, range.offset + range.length) : bytes.slice(),
        };
    }
}

class MemoryPackCache implements AdaptiveJournalPackCacheV1 {
    readonly values = new Map<string, Uint8Array>();

    async get(packId: string): Promise<Uint8Array | undefined> {
        return this.values.get(packId)?.slice();
    }

    async set(packId: string, bytes: Uint8Array): Promise<void> {
        this.values.set(packId, bytes.slice());
    }
}

async function fixture() {
    const candidate = await createAdaptiveJournalManifestV1({
        encryption: "unencrypted",
        repositoryId: sequence(0x10),
        securitySeed: sequence(0x80),
    });
    const firstKey = sequence(0x20);
    const secondKey = sequence(0x60);
    const first = await encodeRecordFrameV1({
        codec: "none",
        keys: candidate.keys,
        kind: AdaptiveRecordKindV1.Chunk,
        logicalKey: firstKey,
        plaintext: new TextEncoder().encode("first object Chunk"),
    });
    const second = await encodeRecordFrameV1({
        codec: "none",
        keys: candidate.keys,
        kind: AdaptiveRecordKindV1.Chunk,
        logicalKey: secondKey,
        plaintext: new TextEncoder().encode("second object Chunk"),
    });
    const pack = await buildAdaptiveJournalPackV1({
        chunks: [
            { frame: first.bytes, key: firstKey },
            { frame: second.bytes, key: secondKey },
        ],
        keys: candidate.keys,
    });
    const catalogue = new AdaptiveJournalCatalogueV1();
    catalogue.applyCommittedPack(pack.packId, pack.entries);
    return { candidate, catalogue, first, firstKey, pack, second, secondKey };
}

describe("Adaptive Journal object Chunk retrieval", () => {
    it("downloads and verifies one complete pack for several requested Chunks, then reuses its cache", async () => {
        const value = await fixture();
        const remote = new ReadingObjectRemote(
            new Map([[adaptiveJournalPackObjectKeyV1(value.pack.packId), value.pack.packBytes]])
        );
        const cache = new MemoryPackCache();
        const reader = createAdaptiveJournalObjectChunkReaderV1({
            cache,
            catalogue: value.catalogue,
            remote,
            retrieval: "whole-pack",
        });

        await expect(reader.hasMany([value.secondKey, sequence(0xf0), value.firstKey])).resolves.toEqual({
            status: "ok",
            availability: [true, false, true],
        });
        await expect(reader.getMany([value.secondKey, value.firstKey])).resolves.toEqual({
            status: "ok",
            chunks: [
                { key: value.secondKey, frame: value.second.bytes, frameDigest: value.second.digest },
                { key: value.firstKey, frame: value.first.bytes, frameDigest: value.first.digest },
            ],
        });
        await expect(reader.getMany([value.firstKey])).resolves.toMatchObject({ status: "ok" });
        expect(remote.reads).toEqual([{ key: adaptiveJournalPackObjectKeyV1(value.pack.packId), range: undefined }]);
        expect(cache.values.size).toBe(1);
    });

    it("issues exact verified frame ranges only when range retrieval is selected", async () => {
        const value = await fixture();
        const remote = new ReadingObjectRemote(
            new Map([[adaptiveJournalPackObjectKeyV1(value.pack.packId), value.pack.packBytes]])
        );
        const reader = createAdaptiveJournalObjectChunkReaderV1({
            catalogue: value.catalogue,
            remote,
            retrieval: "range",
        });

        await expect(reader.getMany([value.secondKey, value.firstKey])).resolves.toMatchObject({ status: "ok" });
        expect(remote.reads).toEqual(
            [value.secondKey, value.firstKey].map((key) => {
                const location = value.catalogue.locations(key)[0];
                return {
                    key: adaptiveJournalPackObjectKeyV1(location.packId),
                    range: { length: location.frameLength, offset: location.offset },
                };
            })
        );
    });

    it("does not return a frame when complete-pack or range integrity fails", async () => {
        const value = await fixture();
        const changed = value.pack.packBytes.slice();
        changed[changed.byteLength - 1] ^= 0xff;
        const whole = createAdaptiveJournalObjectChunkReaderV1({
            catalogue: value.catalogue,
            remote: new ReadingObjectRemote(
                new Map([[adaptiveJournalPackObjectKeyV1(value.pack.packId), changed]])
            ),
            retrieval: "whole-pack",
        });
        await expect(whole.getMany([value.firstKey])).resolves.toMatchObject({
            status: "failed",
            failure: { category: "invalid-response", retry: "never" },
        });

        const rangeRemote = new ReadingObjectRemote(
            new Map([[adaptiveJournalPackObjectKeyV1(value.pack.packId), changed]])
        );
        const range = createAdaptiveJournalObjectChunkReaderV1({
            catalogue: value.catalogue,
            remote: rangeRemote,
            retrieval: "range",
        });
        await expect(range.getMany([value.secondKey])).resolves.toMatchObject({
            status: "failed",
            failure: { category: "invalid-response", retry: "never" },
        });
    });
});
