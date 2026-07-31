import { describe, expect, it } from "vitest";

import { concatBytes, u64be } from "./AdaptiveJournalBinary.ts";
import { decodeCommitEnvelopeV1, encodeCommitEnvelopeV1 } from "./AdaptiveJournalCommit.ts";
import { AdaptiveJournalError, sha256 } from "./AdaptiveJournalManifest.ts";

function bytes(length: number, value: number): Uint8Array {
    return new Uint8Array(length).fill(value);
}

describe("CommitEnvelopeV1", () => {
    it("sorts and deduplicates required Chunk keys and freezes the exact metadata identity", async () => {
        const repositoryId = bytes(32, 0x11);
        const writerStreamId = bytes(32, 0x22);
        const metadataDigest = bytes(32, 0x33);
        const previousCommitDigest = bytes(32, 0x44);
        const commitFrame = new TextEncoder().encode("exact-encrypted-commit-frame");
        const firstKey = bytes(32, 0x01);
        const secondKey = bytes(32, 0x02);
        const encoded = await encodeCommitEnvelopeV1({
            commitFrame,
            metadataDigest,
            previousCommitDigest,
            repositoryId,
            requiredChunkKeys: [secondKey, firstKey, secondKey],
            sequence: 7n,
            writerStreamId,
        });

        expect(encoded.requiredChunkKeys).toEqual([firstKey, secondKey]);
        expect(encoded.requiredChunkKeysDigest).toEqual(await sha256(concatBytes(firstKey, secondKey)));
        expect(encoded.commitFrameDigest).toEqual(await sha256(commitFrame));
        expect(encoded.digest).toEqual(await sha256(encoded.bytes));

        const decoded = await decodeCommitEnvelopeV1(encoded.bytes);
        expect(decoded).toEqual({
            commitFrame,
            commitFrameDigest: encoded.commitFrameDigest,
            digest: encoded.digest,
            metadataDigest,
            metadataLogicalKey: concatBytes(writerStreamId, u64be(7n)),
            previousCommitDigest,
            repositoryId,
            requiredChunkKeys: [firstKey, secondKey],
            requiredChunkKeysDigest: encoded.requiredChunkKeysDigest,
            sequence: 7n,
            writerStreamId,
        });
    });

    it("encodes the first writer commit with no predecessor and an empty required-key set", async () => {
        const encoded = await encodeCommitEnvelopeV1({
            commitFrame: new Uint8Array([1, 2, 3]),
            metadataDigest: bytes(32, 0x51),
            previousCommitDigest: null,
            repositoryId: bytes(32, 0x52),
            requiredChunkKeys: [],
            sequence: 1n,
            writerStreamId: bytes(32, 0x53),
        });
        const decoded = await decodeCommitEnvelopeV1(encoded.bytes);

        expect(decoded.previousCommitDigest).toBeNull();
        expect(decoded.requiredChunkKeys).toEqual([]);
        expect(decoded.requiredChunkKeysDigest).toEqual(await sha256(new Uint8Array()));
    });

    it("rejects sequence zero, changed key-set digests, unsorted keys, and truncated envelopes", async () => {
        const options = {
            commitFrame: new Uint8Array([1, 2, 3]),
            metadataDigest: bytes(32, 0x61),
            previousCommitDigest: null,
            repositoryId: bytes(32, 0x62),
            requiredChunkKeys: [bytes(32, 0x01), bytes(32, 0x02)],
            writerStreamId: bytes(32, 0x63),
        };
        await expect(encodeCommitEnvelopeV1({ ...options, sequence: 0n })).rejects.toMatchObject<
            Partial<AdaptiveJournalError>
        >({ code: "invalid-commit-envelope" });

        const encoded = await encodeCommitEnvelopeV1({ ...options, sequence: 2n });
        const changedDigest = encoded.bytes.slice();
        changedDigest[132] ^= 0xff;
        await expect(decodeCommitEnvelopeV1(changedDigest)).rejects.toMatchObject<Partial<AdaptiveJournalError>>({
            code: "invalid-commit-envelope",
        });

        const unsorted = encoded.bytes.slice();
        const firstOffset = 244;
        const secondOffset = firstOffset + 32;
        unsorted.set(bytes(32, 0x02), firstOffset);
        unsorted.set(bytes(32, 0x01), secondOffset);
        const unsortedDigest = await sha256(unsorted.slice(firstOffset, secondOffset + 32));
        unsorted.set(unsortedDigest, 132);
        await expect(decodeCommitEnvelopeV1(unsorted)).rejects.toMatchObject<Partial<AdaptiveJournalError>>({
            code: "invalid-commit-envelope",
        });

        await expect(decodeCommitEnvelopeV1(encoded.bytes.slice(0, -1))).rejects.toMatchObject<
            Partial<AdaptiveJournalError>
        >({ code: "invalid-commit-envelope" });
    });
});
