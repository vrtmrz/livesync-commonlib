import { describe, expect, it } from "vitest";

import { adaptiveJournalPackObjectKeyV1 } from "./AdaptiveJournalCatalogue.ts";
import {
    decodeAdaptiveJournalCommitPacksV1,
    decodeAdaptiveJournalCommitRecordV1,
    encodeAdaptiveJournalCommitRecordV1,
} from "./AdaptiveJournalControl.ts";
import { createAdaptiveJournalManifestV1 } from "./AdaptiveJournalManifest.ts";

function sequence(start: number): Uint8Array {
    return Uint8Array.from({ length: 32 }, (_, index) => (start + index) & 0xff);
}

describe("Adaptive Journal Commit control record v1", () => {
    it("round-trips canonical Pack routes inside an authenticated Commit frame", async () => {
        const candidate = await createAdaptiveJournalManifestV1({
            encryption: "encrypted",
            passphrase: "commit control passphrase",
            repositoryId: sequence(0x10),
            securitySeed: sequence(0x80),
        });
        const writerStreamId = sequence(0x30);
        const packId = sequence(0x40);
        const encoded = await encodeAdaptiveJournalCommitRecordV1({
            chunkPacks: [
                {
                    container: "pack",
                    entries: [
                        {
                            frameDigest: sequence(0x50),
                            frameLength: 91,
                            key: sequence(0x60),
                            offset: 0,
                        },
                    ],
                    objectKey: adaptiveJournalPackObjectKeyV1(packId),
                    packBytes: 91,
                    packId,
                },
            ],
            keys: candidate.keys,
            metadata: {
                bytes: 345,
                digest: sequence(0x70),
            },
            previousCommitDigest: sequence(0x90),
            recordIv: new Uint8Array(12).fill(0xa1),
            recordSalt: new Uint8Array(32).fill(0xa2),
            requiredChunkKeysDigest: sequence(0xb0),
            sequence: 2n,
            writerStreamId,
        });

        const decoded = await decodeAdaptiveJournalCommitRecordV1({
            bytes: encoded.bytes,
            keys: candidate.keys,
            sequence: 2n,
            writerStreamId,
        });
        expect(decoded).toEqual({ digest: encoded.digest, payload: encoded.payload });
        expect(decodeAdaptiveJournalCommitPacksV1(decoded.payload)).toEqual([
            expect.objectContaining({ container: "pack", objectKey: adaptiveJournalPackObjectKeyV1(packId), packId }),
        ]);
    });

    it("rejects a predecessor which does not match the Commit sequence", async () => {
        const candidate = await createAdaptiveJournalManifestV1({
            encryption: "unencrypted",
            repositoryId: sequence(0x11),
            securitySeed: sequence(0x81),
        });
        const writerStreamId = sequence(0x31);
        await expect(
            encodeAdaptiveJournalCommitRecordV1({
                chunkPacks: [],
                keys: candidate.keys,
                metadata: {
                    bytes: 1,
                    digest: sequence(0x71),
                },
                previousCommitDigest: sequence(0x91),
                requiredChunkKeysDigest: sequence(0xb1),
                sequence: 1n,
                writerStreamId,
            })
        ).rejects.toMatchObject({ code: "invalid-commit-record" });

        await expect(
            encodeAdaptiveJournalCommitRecordV1({
                chunkPacks: [],
                keys: candidate.keys,
                metadata: {
                    bytes: 1,
                    digest: sequence(0x71),
                },
                previousCommitDigest: null,
                requiredChunkKeysDigest: sequence(0xb1),
                sequence: 2n,
                writerStreamId,
            })
        ).rejects.toMatchObject({ code: "invalid-commit-record" });
    });
});
