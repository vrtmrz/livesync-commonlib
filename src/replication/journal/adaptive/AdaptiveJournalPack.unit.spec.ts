import { describe, expect, it } from "vitest";

import { bytesToBase64Url, concatBytes } from "./AdaptiveJournalBinary.ts";
import { createAdaptiveJournalManifestV1, sha256 } from "./AdaptiveJournalManifest.ts";
import {
    buildAdaptiveJournalPackV1,
    decodeAdaptiveJournalPackIndexPayloadV1,
    decodeAdaptiveJournalPackV1,
    encodeAdaptiveJournalPackIndexPayloadV1,
    frameFromAdaptiveJournalPackV1,
} from "./AdaptiveJournalPack.ts";
import { AdaptiveRecordKindV1, encodeRecordFrameV1 } from "./AdaptiveJournalRecord.ts";

function sequence(start: number): Uint8Array {
    return Uint8Array.from({ length: 32 }, (_, index) => (start + index) & 0xff);
}

describe("Adaptive Journal immutable pack v1", () => {
    it("builds a content-addressed pack and a sorted, complete index", async () => {
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
        expect(built.packIdText).toBe(bytesToBase64Url(built.packId));
        expect(built.entries.map(({ key }) => key)).toEqual([firstKey, secondKey]);
        expect(built.entries[0]).toMatchObject({ offset: 0, frameLength: first.bytes.byteLength });
        expect(built.entries[1]).toMatchObject({
            offset: first.bytes.byteLength,
            frameLength: second.bytes.byteLength,
        });

        const decoded = await decodeAdaptiveJournalPackV1({
            indexFrame: built.indexFrame,
            keys,
            packBytes: built.packBytes,
        });
        expect(decoded.packId).toEqual(built.packId);
        expect(decoded.entries).toEqual(built.entries);
        expect(frameFromAdaptiveJournalPackV1(built.packBytes, decoded.entries[1])).toEqual(second.bytes);
    });

    it("encrypts the index independently while keeping every Chunk frame range-addressable", async () => {
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
            indexIv: new Uint8Array(12).fill(0x47),
            indexRecordSalt: new Uint8Array(32).fill(0x48),
            keys,
        });

        await expect(
            decodeAdaptiveJournalPackV1({ indexFrame: built.indexFrame, keys, packBytes: built.packBytes })
        ).resolves.toMatchObject({ entries: built.entries, packId: built.packId });
        expect(frameFromAdaptiveJournalPackV1(built.packBytes, built.entries[0])).toEqual(chunk.bytes);
    });

    it("rejects duplicate keys, gaps, overlaps, and a pack whose content digest changed", async () => {
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
        ).rejects.toMatchObject({ code: "invalid-pack-index" });

        const digest = await sha256(chunk.bytes);
        const invalidPayload = encodeAdaptiveJournalPackIndexPayloadV1([
            { frameDigest: digest, frameLength: 4, key, offset: 0, plaintextLength: 1 },
            { frameDigest: digest, frameLength: 4, key: sequence(0x50), offset: 3, plaintextLength: 1 },
        ]);
        expect(() => decodeAdaptiveJournalPackIndexPayloadV1(invalidPayload, 7)).toThrowError(
            expect.objectContaining({ code: "invalid-pack-index" })
        );

        const built = await buildAdaptiveJournalPackV1({ chunks: [{ frame: chunk.bytes, key }], keys });
        const changedPack = built.packBytes.slice();
        changedPack[changedPack.byteLength - 1] ^= 0xff;
        await expect(
            decodeAdaptiveJournalPackV1({ indexFrame: built.indexFrame, keys, packBytes: changedPack })
        ).rejects.toMatchObject({ code: "pack-integrity-failed" });
    });
});
