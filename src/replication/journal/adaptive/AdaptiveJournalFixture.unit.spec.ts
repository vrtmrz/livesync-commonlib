import { readFile } from "node:fs/promises";

import { beforeAll, describe, expect, it } from "vitest";

import {
    AdaptiveBatchOperationV1,
    decodeBatchRequestV1,
    decodeBatchResponseV1,
    encodeBatchRequestV1,
    encodeBatchResponseV1,
} from "./AdaptiveJournalBatch.ts";
import { base64UrlToBytes, bytesToBase64Url } from "./AdaptiveJournalBinary.ts";
import { decodeCommitEnvelopeV1, encodeCommitEnvelopeV1 } from "./AdaptiveJournalCommit.ts";
import {
    ADAPTIVE_JOURNAL_ROLES_V1,
    adaptiveJournalRoleKeyV1,
    deriveRemoteChunkKeyV1,
    deriveWriterStreamIdV1,
    parseAndVerifyAdaptiveJournalManifestV1,
    type AdaptiveJournalEncryption,
    type AdaptiveJournalManifestCandidateV1,
} from "./AdaptiveJournalManifest.ts";
import { decodeAdaptiveJournalPackV1, frameFromAdaptiveJournalPackV1 } from "./AdaptiveJournalPack.ts";
import { AdaptiveRecordKindV1, decodeRecordFrameV1 } from "./AdaptiveJournalRecord.ts";

type FixtureRecordKind =
    | "catalogue-delta"
    | "catalogue-snapshot"
    | "chunk"
    | "commit"
    | "metadata-batch"
    | "pack-index"
    | "writer-descriptor";

interface AdaptiveJournalFixtureV1 {
    batches: Record<"getRequest" | "getResponse" | "hasRequest" | "hasResponse" | "putRequest" | "putResponse", string>;
    commit: {
        commitFrameDigest: string;
        digest: string;
        envelope: string;
        metadataDigest: string;
        previousCommitDigest: string;
        requiredChunkKeys: string[];
        requiredChunkKeysDigest: string;
        sequence: string;
        writerStreamId: string;
    };
    format: string;
    formatVersion: number;
    inputs: {
        hostId: string;
        localChunkId: string;
        passphrase: string;
        repositoryId: string;
        writerEpoch: string;
    };
    keySchedule: {
        encryptedRemoteChunkKey: string;
        encryptedRoleKeys: Record<string, string>;
        encryptedWriterStreamId: string;
        unencryptedRemoteChunkKey: string;
        unencryptedWriterStreamId: string;
    };
    manifests: Record<AdaptiveJournalEncryption, { bytes: string; digest: string }>;
    pack: {
        entries: Array<{
            frameDigest: string;
            frameLength: number;
            key: string;
            offset: number;
            plaintextLength: number;
        }>;
        indexFrame: string;
        indexFrameDigest: string;
        packBytes: string;
        packId: string;
    };
    records: Array<{
        codec: "deflate" | "none";
        digest: string;
        frame: string;
        kind: FixtureRecordKind;
        logicalKey: string;
        mode: AdaptiveJournalEncryption;
        plaintext: string;
    }>;
}

const kindByName: Record<FixtureRecordKind, AdaptiveRecordKindV1> = {
    "catalogue-delta": AdaptiveRecordKindV1.CatalogueDelta,
    "catalogue-snapshot": AdaptiveRecordKindV1.CatalogueSnapshot,
    chunk: AdaptiveRecordKindV1.Chunk,
    commit: AdaptiveRecordKindV1.Commit,
    "metadata-batch": AdaptiveRecordKindV1.MetadataBatch,
    "pack-index": AdaptiveRecordKindV1.PackIndex,
    "writer-descriptor": AdaptiveRecordKindV1.WriterDescriptor,
};

const fixture = JSON.parse(
    await readFile(new URL("./fixtures/v1.json", import.meta.url), "utf8")
) as AdaptiveJournalFixtureV1;
const candidates = {} as Record<AdaptiveJournalEncryption, AdaptiveJournalManifestCandidateV1>;

beforeAll(async () => {
    for (const encryption of ["encrypted", "unencrypted"] as const) {
        candidates[encryption] = await parseAndVerifyAdaptiveJournalManifestV1(
            base64UrlToBytes(fixture.manifests[encryption].bytes),
            {
                expectedEncryption: encryption,
                expectedRepositoryId: fixture.inputs.repositoryId,
                passphrase: fixture.inputs.passphrase,
            }
        );
    }
});

describe("Adaptive Journal v1 frozen interoperability fixture", () => {
    it("authenticates both manifests and freezes the key schedule", async () => {
        expect(fixture).toMatchObject({ format: "adaptive-journal-v1-fixture", formatVersion: 1 });
        for (const encryption of ["encrypted", "unencrypted"] as const) {
            expect(bytesToBase64Url(candidates[encryption].digest)).toBe(fixture.manifests[encryption].digest);
            expect(bytesToBase64Url(candidates[encryption].bytes)).toBe(fixture.manifests[encryption].bytes);
        }
        for (const role of ADAPTIVE_JOURNAL_ROLES_V1) {
            expect(bytesToBase64Url(adaptiveJournalRoleKeyV1(candidates.encrypted.keys, role))).toBe(
                fixture.keySchedule.encryptedRoleKeys[role]
            );
        }
        await expect(
            deriveRemoteChunkKeyV1(candidates.encrypted.keys, fixture.inputs.localChunkId)
        ).resolves.toEqual(base64UrlToBytes(fixture.keySchedule.encryptedRemoteChunkKey));
        await expect(
            deriveRemoteChunkKeyV1(candidates.unencrypted.keys, fixture.inputs.localChunkId)
        ).resolves.toEqual(base64UrlToBytes(fixture.keySchedule.unencryptedRemoteChunkKey));
        await expect(
            deriveWriterStreamIdV1(candidates.encrypted.keys, fixture.inputs.hostId, fixture.inputs.writerEpoch)
        ).resolves.toEqual(base64UrlToBytes(fixture.keySchedule.encryptedWriterStreamId));
        await expect(
            deriveWriterStreamIdV1(candidates.unencrypted.keys, fixture.inputs.hostId, fixture.inputs.writerEpoch)
        ).resolves.toEqual(base64UrlToBytes(fixture.keySchedule.unencryptedWriterStreamId));
    });

    it("decodes every record kind in both modes and codecs", async () => {
        expect(fixture.records).toHaveLength(28);
        for (const record of fixture.records) {
            const decoded = await decodeRecordFrameV1({
                bytes: base64UrlToBytes(record.frame),
                expectedKind: kindByName[record.kind],
                keys: candidates[record.mode].keys,
                logicalKey: base64UrlToBytes(record.logicalKey),
            });
            expect(decoded).toMatchObject({ codec: record.codec, kind: kindByName[record.kind] });
            expect(bytesToBase64Url(decoded.frameDigest)).toBe(record.digest);
            expect(bytesToBase64Url(decoded.plaintext)).toBe(record.plaintext);
        }
    });

    it("round-trips the batch, Commit, Pack, and index envelopes byte-for-byte", async () => {
        const hasRequest = decodeBatchRequestV1(base64UrlToBytes(fixture.batches.hasRequest));
        const getRequest = decodeBatchRequestV1(base64UrlToBytes(fixture.batches.getRequest));
        const putRequest = decodeBatchRequestV1(base64UrlToBytes(fixture.batches.putRequest));
        expect(hasRequest.operation).toBe(AdaptiveBatchOperationV1.Has);
        expect(getRequest.operation).toBe(AdaptiveBatchOperationV1.Get);
        expect(putRequest.operation).toBe(AdaptiveBatchOperationV1.Put);
        expect(bytesToBase64Url(encodeBatchRequestV1(hasRequest))).toBe(fixture.batches.hasRequest);
        expect(bytesToBase64Url(encodeBatchRequestV1(getRequest))).toBe(fixture.batches.getRequest);
        expect(bytesToBase64Url(encodeBatchRequestV1(putRequest))).toBe(fixture.batches.putRequest);

        for (const name of ["hasResponse", "getResponse", "putResponse"] as const) {
            const response = decodeBatchResponseV1(base64UrlToBytes(fixture.batches[name]));
            expect(bytesToBase64Url(encodeBatchResponseV1(response))).toBe(fixture.batches[name]);
        }

        const commit = await decodeCommitEnvelopeV1(base64UrlToBytes(fixture.commit.envelope));
        expect(commit.sequence.toString()).toBe(fixture.commit.sequence);
        expect(bytesToBase64Url(commit.digest)).toBe(fixture.commit.digest);
        expect(bytesToBase64Url(commit.commitFrameDigest)).toBe(fixture.commit.commitFrameDigest);
        expect(bytesToBase64Url(commit.requiredChunkKeysDigest)).toBe(fixture.commit.requiredChunkKeysDigest);
        expect(commit.requiredChunkKeys.map(bytesToBase64Url)).toEqual(fixture.commit.requiredChunkKeys);
        const reencodedCommit = await encodeCommitEnvelopeV1({
            commitFrame: commit.commitFrame,
            metadataDigest: commit.metadataDigest,
            previousCommitDigest: commit.previousCommitDigest,
            repositoryId: commit.repositoryId,
            requiredChunkKeys: commit.requiredChunkKeys,
            sequence: commit.sequence,
            writerStreamId: commit.writerStreamId,
        });
        expect(bytesToBase64Url(reencodedCommit.bytes)).toBe(fixture.commit.envelope);

        const packBytes = base64UrlToBytes(fixture.pack.packBytes);
        const decodedPack = await decodeAdaptiveJournalPackV1({
            expectedPackId: base64UrlToBytes(fixture.pack.packId),
            indexFrame: base64UrlToBytes(fixture.pack.indexFrame),
            keys: candidates.unencrypted.keys,
            packBytes,
        });
        expect(bytesToBase64Url(decodedPack.indexFrameDigest)).toBe(fixture.pack.indexFrameDigest);
        expect(
            decodedPack.entries.map((entry) => ({
                frameDigest: bytesToBase64Url(entry.frameDigest),
                frameLength: entry.frameLength,
                key: bytesToBase64Url(entry.key),
                offset: entry.offset,
                plaintextLength: entry.plaintextLength,
            }))
        ).toEqual(fixture.pack.entries);
        for (const entry of decodedPack.entries) {
            expect(frameFromAdaptiveJournalPackV1(packBytes, entry)).toHaveLength(entry.frameLength);
        }
    });
});
