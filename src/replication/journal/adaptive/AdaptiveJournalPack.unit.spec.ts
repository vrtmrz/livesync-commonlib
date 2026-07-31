import { describe, expect, it } from "vitest";

import { concatBytes } from "./AdaptiveJournalBinary.ts";
import { createAdaptiveJournalManifestV1, sha256 } from "./AdaptiveJournalManifest.ts";
import { buildAdaptiveJournalPackV1, frameFromAdaptiveJournalPackV1 } from "./AdaptiveJournalPack.ts";
import { AdaptiveRecordKindV1, encodeRecordFrameV1 } from "./AdaptiveJournalRecord.ts";

function sequence(start: number): Uint8Array {
    return Uint8Array.from({ length: 32 }, (_, index) => (start + index) & 0xff);
}

describe("Adaptive Journal immutable pack v1", () => {
    it("builds a content-addressed Pack and sorted frame routes", async () => {
        const keys = (
            await createAdaptiveJournalManifestV1({
                encryption: "unencrypted",
                repositoryId: sequence(0x10),
                securitySeed: sequence(0x80),
            })
        ).keys;
        const firstKey = sequence(0x20);
        const secondKey = sequence(0x60);
        const first = await encodeRecordFrameV1({
            codec: "none",
            keys,
            kind: AdaptiveRecordKindV1.Chunk,
            logicalKey: firstKey,
            plaintext: new TextEncoder().encode("first Chunk payload"),
        });
        const second = await encodeRecordFrameV1({
            codec: "deflate",
            keys,
            kind: AdaptiveRecordKindV1.Chunk,
            logicalKey: secondKey,
            plaintext: new TextEncoder().encode("second Chunk payload ".repeat(8)),
        });

        const built = await buildAdaptiveJournalPackV1({
            chunks: [
                { frame: second.bytes, key: secondKey },
                { frame: first.bytes, key: firstKey },
            ],
            keys,
        });

        expect(built.packBytes).toEqual(concatBytes(first.bytes, second.bytes));
        expect(built.packId).toEqual(await sha256(built.packBytes));
        expect(built.entries.map(({ key }) => key)).toEqual([firstKey, secondKey]);
        expect(built.entries[0]).toMatchObject({ offset: 0, frameLength: first.bytes.byteLength });
        expect(built.entries[1]).toMatchObject({
            offset: first.bytes.byteLength,
            frameLength: second.bytes.byteLength,
        });

        expect(frameFromAdaptiveJournalPackV1(built.packBytes, built.entries[1])).toEqual(second.bytes);
    });

    it("keeps encrypted Chunk frames independently range-addressable", async () => {
        const keys = (
            await createAdaptiveJournalManifestV1({
                encryption: "encrypted",
                passphrase: "pack fixture passphrase",
                repositoryId: sequence(0x11),
                securitySeed: sequence(0x81),
            })
        ).keys;
        const key = sequence(0x30);
        const chunk = await encodeRecordFrameV1({
            codec: "none",
            iv: new Uint8Array(12).fill(0x45),
            keys,
            kind: AdaptiveRecordKindV1.Chunk,
            logicalKey: key,
            plaintext: new TextEncoder().encode("encrypted Chunk payload"),
            recordSalt: new Uint8Array(32).fill(0x46),
        });
        const built = await buildAdaptiveJournalPackV1({
            chunks: [{ frame: chunk.bytes, key }],
            keys,
        });

        expect(frameFromAdaptiveJournalPackV1(built.packBytes, built.entries[0])).toEqual(chunk.bytes);
    });

    it("rejects duplicate keys and entries which extend beyond available Pack bytes", async () => {
        const keys = (
            await createAdaptiveJournalManifestV1({
                encryption: "unencrypted",
                repositoryId: sequence(0x12),
                securitySeed: sequence(0x82),
            })
        ).keys;
        const key = sequence(0x40);
        const chunk = await encodeRecordFrameV1({
            codec: "none",
            keys,
            kind: AdaptiveRecordKindV1.Chunk,
            logicalKey: key,
            plaintext: new TextEncoder().encode("one Chunk"),
        });
        await expect(
            buildAdaptiveJournalPackV1({
                chunks: [
                    { frame: chunk.bytes, key },
                    { frame: chunk.bytes, key },
                ],
                keys,
            })
        ).rejects.toMatchObject({ code: "invalid-pack" });

        const built = await buildAdaptiveJournalPackV1({ chunks: [{ frame: chunk.bytes, key }], keys });
        expect(() =>
            frameFromAdaptiveJournalPackV1(built.packBytes, {
                ...built.entries[0],
                frameLength: built.packBytes.byteLength + 1,
            })
        ).toThrowError(expect.objectContaining({ code: "invalid-pack" }));
        expect(() =>
            frameFromAdaptiveJournalPackV1(built.packBytes, {
                ...built.entries[0],
                frameLength: 0,
            })
        ).toThrowError(expect.objectContaining({ code: "invalid-pack" }));
    });
});
