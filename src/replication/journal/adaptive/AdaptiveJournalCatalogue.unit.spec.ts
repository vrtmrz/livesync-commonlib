import { describe, expect, it } from "vitest";

import { bytesToBase64Url } from "./AdaptiveJournalBinary.ts";
import {
    AdaptiveJournalCatalogueV1,
    adaptiveJournalCommitObjectKeyV1,
    adaptiveJournalDeltaObjectKeyV1,
    adaptiveJournalIndexObjectKeyV1,
    adaptiveJournalMetadataObjectKeyV1,
    adaptiveJournalPackObjectKeyV1,
    adaptiveJournalWriterObjectKeyV1,
    decodeAdaptiveJournalCatalogueDeltaV1,
    encodeAdaptiveJournalCatalogueDeltaV1,
} from "./AdaptiveJournalCatalogue.ts";
import { createAdaptiveJournalManifestV1 } from "./AdaptiveJournalManifest.ts";

function sequence(start: number): Uint8Array {
    return Uint8Array.from({ length: 32 }, (_, index) => (start + index) & 0xff);
}

describe("Adaptive Journal object catalogue v1", () => {
    it("uses flat, sortable object keys with dense 20-digit per-writer sequences", () => {
        const writer = sequence(0x10);
        const pack = sequence(0x40);
        const writerText = bytesToBase64Url(writer);
        const packText = bytesToBase64Url(pack);

        expect(adaptiveJournalWriterObjectKeyV1(writer)).toBe(`a1~writer~${writerText}.writer`);
        expect(adaptiveJournalPackObjectKeyV1(pack)).toBe(`a1~pack~${packText}.bin`);
        expect(adaptiveJournalIndexObjectKeyV1(pack)).toBe(`a1~index~${packText}.idx`);
        expect(adaptiveJournalDeltaObjectKeyV1(writer, 23n)).toBe(
            `a1~delta~${writerText}~00000000000000000023.delta`
        );
        expect(adaptiveJournalMetadataObjectKeyV1(writer, 23n)).toBe(
            `a1~metadata~${writerText}~00000000000000000023.batch`
        );
        expect(adaptiveJournalCommitObjectKeyV1(writer, 23n)).toBe(
            `a1~commit~${writerText}~00000000000000000023.commit`
        );
        expect(() => adaptiveJournalCommitObjectKeyV1(writer, 0n)).toThrowError();
    });

    it("round-trips an authenticated catalogue delta and validates its route", async () => {
        const candidate = await createAdaptiveJournalManifestV1({
            encryption: "encrypted",
            passphrase: "catalogue fixture passphrase",
            repositoryId: sequence(0x11),
            securitySeed: sequence(0x81),
        });
        const writerStreamId = sequence(0x20);
        const packId = sequence(0x50);
        const encoded = await encodeAdaptiveJournalCatalogueDeltaV1({
            indexDigest: sequence(0x90),
            indexKey: adaptiveJournalIndexObjectKeyV1(packId),
            keys: candidate.keys,
            packBytes: 1234,
            packId,
            recordIv: new Uint8Array(12).fill(0xa2),
            recordSalt: new Uint8Array(32).fill(0xa3),
            sequence: 7n,
            writerStreamId,
        });

        await expect(
            decodeAdaptiveJournalCatalogueDeltaV1({
                bytes: encoded.bytes,
                keys: candidate.keys,
                sequence: 7n,
                writerStreamId,
            })
        ).resolves.toEqual({
            digest: encoded.digest,
            payload: encoded.payload,
        });
        await expect(
            decodeAdaptiveJournalCatalogueDeltaV1({
                bytes: encoded.bytes,
                keys: candidate.keys,
                sequence: 8n,
                writerStreamId,
            })
        ).rejects.toMatchObject({ code: "record-integrity-failed" });
    });

    it("adds locations only when a committed delta and its verified index are applied", () => {
        const catalogue = new AdaptiveJournalCatalogueV1();
        const chunkKey = sequence(0x30);
        const otherChunkKey = sequence(0x60);
        const firstPackId = sequence(0xa0);
        const secondPackId = sequence(0xb0);
        const entry = {
            frameDigest: sequence(0xc0),
            frameLength: 91,
            key: chunkKey,
            offset: 0,
            plaintextLength: 23,
        };

        expect(catalogue.locations(chunkKey)).toEqual([]);
        catalogue.applyCommittedPack(firstPackId, [entry]);
        catalogue.applyCommittedPack(secondPackId, [entry, { ...entry, key: otherChunkKey, offset: 91 }]);

        expect(catalogue.locations(chunkKey).map(({ packId }) => packId)).toEqual([firstPackId, secondPackId]);
        expect(catalogue.locations(otherChunkKey)).toHaveLength(1);
        expect(catalogue.size).toBe(2);
    });
});
