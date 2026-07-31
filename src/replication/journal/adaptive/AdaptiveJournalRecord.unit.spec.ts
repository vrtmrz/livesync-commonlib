import { describe, expect, it } from "vitest";

import {
    AdaptiveJournalError,
    createAdaptiveJournalManifestV1,
    deriveRemoteChunkKeyV1,
    parseAndVerifyAdaptiveJournalManifestV1,
} from "./AdaptiveJournalManifest.ts";
import {
    AdaptiveRecordKindV1,
    decodeRecordFrameV1,
    encodeRecordFrameV1,
} from "./AdaptiveJournalRecord.ts";

function bytes(length: number, start = 0): Uint8Array {
    return Uint8Array.from({ length }, (_, index) => (start + index) & 0xff);
}

async function encryptedKeys() {
    const manifest = await createAdaptiveJournalManifestV1({
        encryption: "encrypted",
        passphrase: "frame passphrase",
        repositoryId: bytes(32, 0x11),
        securitySeed: bytes(32, 0x51),
    });
    return (
        await parseAndVerifyAdaptiveJournalManifestV1(manifest.bytes, {
            expectedEncryption: "encrypted",
            passphrase: "frame passphrase",
        })
    ).keys;
}

describe("RecordFrameV1", () => {
    it("round-trips an independently authenticated encrypted Chunk frame", async () => {
        const keys = await encryptedKeys();
        const logicalKey = await deriveRemoteChunkKeyV1(keys, "h:frame-chunk");
        const plaintext = new TextEncoder().encode("payload\u0000with\nbytes");
        const encoded = await encodeRecordFrameV1({
            codec: "none",
            iv: bytes(12, 0x91),
            keys,
            kind: AdaptiveRecordKindV1.Chunk,
            logicalKey,
            plaintext,
            recordSalt: bytes(32, 0x31),
        });

        expect(encoded.bytes.slice(0, 4)).toEqual(new TextEncoder().encode("LSAR"));
        expect(encoded.bytes[4]).toBe(1);
        expect(encoded.bytes[5]).toBe(AdaptiveRecordKindV1.Chunk);
        expect(encoded.bytes[7] & 1).toBe(1);

        const decoded = await decodeRecordFrameV1({
            bytes: encoded.bytes,
            expectedKind: AdaptiveRecordKindV1.Chunk,
            keys,
            logicalKey,
        });
        expect(decoded.plaintext).toEqual(plaintext);
        expect(decoded.frameDigest).toEqual(encoded.digest);
        expect(decoded.codec).toBe("none");
    });

    it("allows different encrypted frames for one logical Chunk while preserving its remote key", async () => {
        const keys = await encryptedKeys();
        const logicalKey = await deriveRemoteChunkKeyV1(keys, "h:same-chunk");
        const plaintext = new TextEncoder().encode("same logical content");
        const first = await encodeRecordFrameV1({
            codec: "none",
            iv: bytes(12, 0x01),
            keys,
            kind: AdaptiveRecordKindV1.Chunk,
            logicalKey,
            plaintext,
            recordSalt: bytes(32, 0x21),
        });
        const second = await encodeRecordFrameV1({
            codec: "none",
            iv: bytes(12, 0x02),
            keys,
            kind: AdaptiveRecordKindV1.Chunk,
            logicalKey,
            plaintext,
            recordSalt: bytes(32, 0x22),
        });

        expect(first.bytes).not.toEqual(second.bytes);
        await expect(
            decodeRecordFrameV1({
                bytes: first.bytes,
                expectedKind: AdaptiveRecordKindV1.Chunk,
                keys,
                logicalKey,
            })
        ).resolves.toMatchObject({ plaintext });
        await expect(
            decodeRecordFrameV1({
                bytes: second.bytes,
                expectedKind: AdaptiveRecordKindV1.Chunk,
                keys,
                logicalKey,
            })
        ).resolves.toMatchObject({ plaintext });
    });

    it("compresses and verifies public frames without claiming authentication", async () => {
        const manifest = await createAdaptiveJournalManifestV1({
            encryption: "unencrypted",
            repositoryId: bytes(32, 0x12),
            securitySeed: bytes(32, 0x52),
        });
        const keys = (
            await parseAndVerifyAdaptiveJournalManifestV1(manifest.bytes, {
                expectedEncryption: "unencrypted",
                passphrase: "",
            })
        ).keys;
        const logicalKey = await deriveRemoteChunkKeyV1(keys, "h:compressible");
        const plaintext = new TextEncoder().encode("repeat:".repeat(200));
        const encoded = await encodeRecordFrameV1({
            codec: "auto",
            keys,
            kind: AdaptiveRecordKindV1.Chunk,
            logicalKey,
            plaintext,
        });
        expect(encoded.codec).toBe("deflate");
        await expect(
            decodeRecordFrameV1({
                bytes: encoded.bytes,
                expectedKind: AdaptiveRecordKindV1.Chunk,
                keys,
                logicalKey,
            })
        ).resolves.toMatchObject({ plaintext });

        const corrupted = encoded.bytes.slice();
        corrupted[corrupted.length - 1] ^= 0xff;
        await expect(
            decodeRecordFrameV1({
                bytes: corrupted,
                expectedKind: AdaptiveRecordKindV1.Chunk,
                keys,
                logicalKey,
            })
        ).rejects.toMatchObject<Partial<AdaptiveJournalError>>({ code: "record-integrity-failed" });
    });

    it("rejects wrong logical keys and truncated or unsupported frames before decoding payloads", async () => {
        const keys = await encryptedKeys();
        const logicalKey = await deriveRemoteChunkKeyV1(keys, "h:expected");
        const wrongLogicalKey = await deriveRemoteChunkKeyV1(keys, "h:wrong");
        const encoded = await encodeRecordFrameV1({
            codec: "none",
            iv: bytes(12, 0x71),
            keys,
            kind: AdaptiveRecordKindV1.Chunk,
            logicalKey,
            plaintext: bytes(64, 0x41),
            recordSalt: bytes(32, 0x61),
        });

        await expect(
            decodeRecordFrameV1({
                bytes: encoded.bytes,
                expectedKind: AdaptiveRecordKindV1.Chunk,
                keys,
                logicalKey: wrongLogicalKey,
            })
        ).rejects.toMatchObject<Partial<AdaptiveJournalError>>({ code: "record-integrity-failed" });
        await expect(
            decodeRecordFrameV1({
                bytes: encoded.bytes.slice(0, -1),
                expectedKind: AdaptiveRecordKindV1.Chunk,
                keys,
                logicalKey,
            })
        ).rejects.toMatchObject<Partial<AdaptiveJournalError>>({ code: "invalid-record-frame" });

        const unsupported = encoded.bytes.slice();
        unsupported[4] = 2;
        await expect(
            decodeRecordFrameV1({
                bytes: unsupported,
                expectedKind: AdaptiveRecordKindV1.Chunk,
                keys,
                logicalKey,
            })
        ).rejects.toMatchObject<Partial<AdaptiveJournalError>>({ code: "unsupported-record-version" });
    });
});
