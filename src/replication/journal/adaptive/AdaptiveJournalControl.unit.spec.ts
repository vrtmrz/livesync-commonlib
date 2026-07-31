import { describe, expect, it } from "vitest";

import { adaptiveJournalDeltaObjectKeyV1, adaptiveJournalMetadataObjectKeyV1 } from "./AdaptiveJournalCatalogue.ts";
import { decodeAdaptiveJournalCommitRecordV1, encodeAdaptiveJournalCommitRecordV1 } from "./AdaptiveJournalControl.ts";
import { createAdaptiveJournalManifestV1 } from "./AdaptiveJournalManifest.ts";

function sequence(start: number): Uint8Array {
    return Uint8Array.from({ length: 32 }, (_, index) => (start + index) & 0xff);
}

describe("Adaptive Journal Commit control record v1", () => {
    it("round-trips the canonical dependency manifest inside an authenticated Commit frame", async () => {
        const candidate = await createAdaptiveJournalManifestV1({
            encryption: "encrypted",
            passphrase: "commit control passphrase",
            repositoryId: sequence(0x10),
            securitySeed: sequence(0x80),
        });
        const writerStreamId = sequence(0x30);
        const catalogueWriterStreamId = sequence(0x40);
        const encoded = await encodeAdaptiveJournalCommitRecordV1({
            catalogueDeltas: [
                {
                    digest: sequence(0x50),
                    key: adaptiveJournalDeltaObjectKeyV1(catalogueWriterStreamId, 1n),
                },
            ],
            keys: candidate.keys,
            metadata: {
                bytes: 345,
                digest: sequence(0x70),
                key: adaptiveJournalMetadataObjectKeyV1(writerStreamId, 2n),
            },
            previousCommitDigest: sequence(0x90),
            recordIv: new Uint8Array(12).fill(0xa1),
            recordSalt: new Uint8Array(32).fill(0xa2),
            requiredChunkKeysDigest: sequence(0xb0),
            sequence: 2n,
            writerStreamId,
        });

        await expect(
            decodeAdaptiveJournalCommitRecordV1({
                bytes: encoded.bytes,
                keys: candidate.keys,
                sequence: 2n,
                writerStreamId,
            })
        ).resolves.toEqual({ digest: encoded.digest, payload: encoded.payload });
    });

    it("rejects a Metadata route, predecessor, or writer route which does not match the Commit identity", async () => {
        const candidate = await createAdaptiveJournalManifestV1({
            encryption: "unencrypted",
            repositoryId: sequence(0x11),
            securitySeed: sequence(0x81),
        });
        const writerStreamId = sequence(0x31);
        await expect(
            encodeAdaptiveJournalCommitRecordV1({
                catalogueDeltas: [],
                keys: candidate.keys,
                metadata: {
                    bytes: 1,
                    digest: sequence(0x71),
                    key: adaptiveJournalMetadataObjectKeyV1(writerStreamId, 1n),
                },
                previousCommitDigest: sequence(0x91),
                requiredChunkKeysDigest: sequence(0xb1),
                sequence: 1n,
                writerStreamId,
            })
        ).rejects.toMatchObject({ code: "invalid-commit-record" });

        await expect(
            encodeAdaptiveJournalCommitRecordV1({
                catalogueDeltas: [],
                keys: candidate.keys,
                metadata: {
                    bytes: 1,
                    digest: sequence(0x71),
                    key: adaptiveJournalMetadataObjectKeyV1(writerStreamId, 2n),
                },
                previousCommitDigest: null,
                requiredChunkKeysDigest: sequence(0xb1),
                sequence: 2n,
                writerStreamId,
            })
        ).rejects.toMatchObject({ code: "invalid-commit-record" });
    });
});
