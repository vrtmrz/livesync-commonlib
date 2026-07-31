import { describe, expect, it } from "vitest";

import { concatBytes, u64be } from "./AdaptiveJournalBinary.ts";
import {
    ADAPTIVE_JOURNAL_COMMIT_BUNDLE_INLINE_PACK_OFFSET_V1,
    AdaptiveJournalCommitBundleCacheV1,
    decodeCommitEnvelopeV1,
    encodeCommitEnvelopeV1,
} from "./AdaptiveJournalCommit.ts";
import { AdaptiveJournalError, sha256 } from "./AdaptiveJournalManifest.ts";

function bytes(length: number, value: number): Uint8Array {
    return new Uint8Array(length).fill(value);
}

describe("CommitEnvelopeV1", () => {
    it("sorts and deduplicates required Chunk keys and freezes the exact metadata identity", async () => {
        const repositoryId = bytes(32, 0x11);
        const writerStreamId = bytes(32, 0x22);
        const metadataFrame = new TextEncoder().encode("exact-encrypted-metadata-frame");
        const metadataDigest = await sha256(metadataFrame);
        const previousCommitDigest = bytes(32, 0x44);
        const commitFrame = new TextEncoder().encode("exact-encrypted-commit-frame");
        const inlinePack = new TextEncoder().encode("inline-pack-bytes");
        const firstKey = bytes(32, 0x01);
        const secondKey = bytes(32, 0x02);
        const encoded = await encodeCommitEnvelopeV1({
            commitFrame,
            inlinePack,
            metadataDigest,
            metadataFrame,
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
            inlinePack,
            inlinePackDigest: await sha256(inlinePack),
            metadataDigest,
            metadataFrame,
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
            metadataDigest: await sha256(new Uint8Array([4, 5, 6])),
            metadataFrame: new Uint8Array([4, 5, 6]),
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

    it("rejects invalid sequences and predecessor relationships", async () => {
        const metadataFrame = new Uint8Array([4, 5, 6]);
        const common = {
            commitFrame: new Uint8Array([1, 2, 3]),
            metadataDigest: await sha256(metadataFrame),
            metadataFrame,
            repositoryId: bytes(32, 0x61),
            requiredChunkKeys: [],
            writerStreamId: bytes(32, 0x62),
        };

        await expect(
            encodeCommitEnvelopeV1({ ...common, previousCommitDigest: null, sequence: 0n })
        ).rejects.toMatchObject<Partial<AdaptiveJournalError>>({ code: "invalid-commit-envelope" });
        await expect(
            encodeCommitEnvelopeV1({ ...common, previousCommitDigest: bytes(32, 0x63), sequence: 1n })
        ).rejects.toMatchObject<Partial<AdaptiveJournalError>>({ code: "invalid-commit-envelope" });
        await expect(
            encodeCommitEnvelopeV1({ ...common, previousCommitDigest: null, sequence: 2n })
        ).rejects.toMatchObject<Partial<AdaptiveJournalError>>({ code: "invalid-commit-envelope" });

        const encoded = await encodeCommitEnvelopeV1({
            ...common,
            previousCommitDigest: bytes(32, 0x63),
            sequence: 2n,
        });
        const missingPredecessor = encoded.bytes.slice();
        missingPredecessor[88] = 0;
        missingPredecessor.fill(0, 96, 128);
        await expect(decodeCommitEnvelopeV1(missingPredecessor)).rejects.toMatchObject<Partial<AdaptiveJournalError>>({
            code: "invalid-commit-envelope",
        });
    });

    it("rejects changed key-set digests, unsorted keys, and truncated envelopes", async () => {
        const options = {
            commitFrame: new Uint8Array([1, 2, 3]),
            metadataDigest: await sha256(new Uint8Array([4, 5, 6])),
            metadataFrame: new Uint8Array([4, 5, 6]),
            previousCommitDigest: bytes(32, 0x61),
            repositoryId: bytes(32, 0x62),
            requiredChunkKeys: [bytes(32, 0x01), bytes(32, 0x02)],
            writerStreamId: bytes(32, 0x63),
        };
        const encoded = await encodeCommitEnvelopeV1({ ...options, sequence: 2n });
        const changedDigest = encoded.bytes.slice();
        changedDigest[132] ^= 0xff;
        await expect(decodeCommitEnvelopeV1(changedDigest)).rejects.toMatchObject<Partial<AdaptiveJournalError>>({
            code: "invalid-commit-envelope",
        });

        const unsorted = encoded.bytes.slice();
        const firstOffset = ADAPTIVE_JOURNAL_COMMIT_BUNDLE_INLINE_PACK_OFFSET_V1;
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

    it("bounds the shared Bundle cache by recency and retained bytes", async () => {
        const cache = new AdaptiveJournalCommitBundleCacheV1({ maxBytes: 700, maxEntries: 2 });
        const createBundle = async (sequence: bigint) => {
            const metadataFrame = new Uint8Array([Number(sequence)]);
            const encoded = await encodeCommitEnvelopeV1({
                commitFrame: new Uint8Array([Number(sequence)]),
                metadataDigest: await sha256(metadataFrame),
                metadataFrame,
                previousCommitDigest: sequence === 1n ? null : bytes(32, Number(sequence) - 1),
                repositoryId: bytes(32, 0x72),
                requiredChunkKeys: [],
                sequence,
                writerStreamId: bytes(32, 0x73),
            });
            return { encoded, envelope: await decodeCommitEnvelopeV1(encoded.bytes) };
        };
        const first = await createBundle(1n);
        const second = await createBundle(2n);
        const third = await createBundle(3n);

        cache.set("first", first.encoded.bytes, first.envelope);
        cache.set("second", second.encoded.bytes, second.envelope);
        expect(cache.get("first")?.envelope.sequence).toBe(1n);
        cache.set("third", third.encoded.bytes, third.envelope);

        expect(cache.get("first")?.envelope.sequence).toBe(1n);
        expect(cache.get("second")).toBeUndefined();
        expect(cache.get("third")?.envelope.sequence).toBe(3n);
    });
});
