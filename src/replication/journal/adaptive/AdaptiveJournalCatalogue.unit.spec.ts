import { describe, expect, it } from "vitest";

import { bytesToBase64Url } from "./AdaptiveJournalBinary.ts";
import {
    AdaptiveJournalCatalogueV1,
    adaptiveJournalCommitObjectKeyV1,
    adaptiveJournalPackObjectKeyV1,
    adaptiveJournalWriterObjectKeyV1,
    parseAdaptiveJournalCommitObjectKeyV1,
} from "./AdaptiveJournalCatalogue.ts";

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
        expect(adaptiveJournalCommitObjectKeyV1(writer, 23n)).toBe(
            `a1~commit~${writerText}~00000000000000000023.commit`
        );
        expect(parseAdaptiveJournalCommitObjectKeyV1(adaptiveJournalCommitObjectKeyV1(writer, 23n))).toEqual({
            sequence: 23n,
            writerStreamId: writer,
        });
        expect(() => adaptiveJournalCommitObjectKeyV1(writer, 0n)).toThrowError();
    });

    it("adds locations only when authenticated Commit Bundle routes are applied", () => {
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
        };

        expect(catalogue.locations(chunkKey)).toEqual([]);
        catalogue.applyCommittedPack({
            container: "pack",
            entries: [entry],
            objectKey: adaptiveJournalPackObjectKeyV1(firstPackId),
            packBytes: 91,
            packId: firstPackId,
        });
        catalogue.applyCommittedPack({
            container: "pack",
            entries: [entry, { ...entry, key: otherChunkKey, offset: 91 }],
            objectKey: adaptiveJournalPackObjectKeyV1(secondPackId),
            packBytes: 182,
            packId: secondPackId,
        });

        expect(catalogue.locations(chunkKey).map(({ packId }) => packId)).toEqual([firstPackId, secondPackId]);
        expect(catalogue.locations(otherChunkKey)).toHaveLength(1);
        expect(catalogue.size).toBe(2);
        expect(catalogue.routes([chunkKey, otherChunkKey])).toHaveLength(2);
    });

    it("does not partially apply a conflicting route group", () => {
        const catalogue = new AdaptiveJournalCatalogueV1();
        const existingKey = sequence(0x31);
        const pendingKey = sequence(0x61);
        const existingPackId = sequence(0xa1);
        const pendingPackId = sequence(0xb1);
        const existingObjectKey = adaptiveJournalPackObjectKeyV1(existingPackId);
        catalogue.applyCommittedPack({
            container: "pack",
            entries: [{ frameDigest: sequence(0xc1), frameLength: 10, key: existingKey, offset: 0 }],
            objectKey: existingObjectKey,
            packBytes: 10,
            packId: existingPackId,
        });

        expect(() =>
            catalogue.applyCommittedPacks([
                {
                    container: "pack",
                    entries: [{ frameDigest: sequence(0xd1), frameLength: 10, key: pendingKey, offset: 0 }],
                    objectKey: adaptiveJournalPackObjectKeyV1(pendingPackId),
                    packBytes: 10,
                    packId: pendingPackId,
                },
                {
                    container: "pack",
                    entries: [{ frameDigest: sequence(0xe1), frameLength: 10, key: existingKey, offset: 0 }],
                    objectKey: existingObjectKey,
                    packBytes: 10,
                    packId: existingPackId,
                },
            ])
        ).toThrowError(expect.objectContaining({ code: "invalid-catalogue-record" }));
        expect(catalogue.locations(pendingKey)).toEqual([]);
        expect(catalogue.locations(existingKey)).toHaveLength(1);
    });

    it("rejects conflicting identities for the same Commit Bundle object", () => {
        const catalogue = new AdaptiveJournalCatalogueV1();
        const writerStreamId = sequence(0x12);
        const objectKey = adaptiveJournalCommitObjectKeyV1(writerStreamId, 1n);
        const firstKey = sequence(0x32);
        const secondKey = sequence(0x62);
        catalogue.applyCommittedPack({
            container: "bundle",
            entries: [{ frameDigest: sequence(0xc2), frameLength: 10, key: firstKey, offset: 0 }],
            objectKey,
            packBytes: 10,
            packId: sequence(0xa2),
        });

        expect(() =>
            catalogue.applyCommittedPack({
                container: "bundle",
                entries: [{ frameDigest: sequence(0xd2), frameLength: 10, key: secondKey, offset: 0 }],
                objectKey,
                packBytes: 10,
                packId: sequence(0xb2),
            })
        ).toThrowError(expect.objectContaining({ code: "invalid-catalogue-record" }));
        expect(catalogue.locations(firstKey)).toHaveLength(1);
        expect(catalogue.locations(secondKey)).toEqual([]);
    });
});
