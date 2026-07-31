import type { DocumentID, EntryDoc } from "@lib/common/types.ts";
import { describe, expect, it } from "vitest";

import { bytesToBase64Url } from "./AdaptiveJournalBinary.ts";
import { ADAPTIVE_JOURNAL_NOOP_CATALOGUE_LOADER_V1 } from "./AdaptiveJournalObjectCatalogueLoader.ts";
import { digestAdaptiveJournalRequiredChunkKeysV1 } from "./AdaptiveJournalCommit.ts";
import type { AdaptiveJournalChunkReaderV1, StoredChunkRecordV1 } from "./AdaptiveJournalChunkStore.ts";
import { adaptiveJournalMetadataObjectKeyV1 } from "./AdaptiveJournalCatalogue.ts";
import { encodeAdaptiveJournalCommitRecordV1 } from "./AdaptiveJournalControl.ts";
import type { AdaptiveJournalDiscoveryStoreV1 } from "./AdaptiveJournalDiscoveryStore.ts";
import { createAdaptiveJournalManifestV1 } from "./AdaptiveJournalManifest.ts";
import {
    encodeAdaptiveJournalChunkRecordV1,
    encodeAdaptiveJournalMetadataRecordV1,
} from "./AdaptiveJournalPayload.ts";
import {
    receiveAdaptiveJournalV1,
    type AdaptiveJournalReceiveFrontierV1,
    type AdaptiveJournalReceivedBatchV1,
} from "./AdaptiveJournalReceiver.ts";
import { encodeAdaptiveJournalWriterDescriptorV1 } from "./AdaptiveJournalWriterDescriptor.ts";

function sequence(start: number): Uint8Array {
    return Uint8Array.from({ length: 32 }, (_, index) => (start + index) & 0xff);
}

function document(path: string): EntryDoc {
    return {
        _id: path as DocumentID,
        _rev: "1-first",
        children: ["h:chunk"],
        ctime: 1,
        mtime: 1,
        path,
        size: 4,
        type: "newnote",
    } as EntryDoc;
}

describe("Adaptive Journal receiver", () => {
    it("applies an independent Writer while another Writer is stopped at a sequence gap", async () => {
        const candidate = await createAdaptiveJournalManifestV1({
            encryption: "unencrypted",
            repositoryId: sequence(0x10),
            securitySeed: sequence(0x80),
        });
        const gapWriter = await encodeAdaptiveJournalWriterDescriptorV1({
            hostId: "gap-host",
            keys: candidate.keys,
            writerEpoch: "gap-epoch",
        });
        const activeWriter = await encodeAdaptiveJournalWriterDescriptorV1({
            hostId: "active-host",
            keys: candidate.keys,
            writerEpoch: "active-epoch",
        });
        const chunk = await encodeAdaptiveJournalChunkRecordV1({
            data: "body",
            keys: candidate.keys,
            localChunkId: "h:chunk" as DocumentID,
        });
        const metadata = await encodeAdaptiveJournalMetadataRecordV1({
            documents: [document("active.md")],
            keys: candidate.keys,
            sequence: 1n,
            writerStreamId: activeWriter.writerStreamId,
        });
        const required = await digestAdaptiveJournalRequiredChunkKeysV1([chunk.remoteChunkKey]);
        const commit = await encodeAdaptiveJournalCommitRecordV1({
            catalogueDeltas: [],
            keys: candidate.keys,
            metadata: {
                bytes: metadata.bytes.byteLength,
                digest: metadata.digest,
                key: adaptiveJournalMetadataObjectKeyV1(activeWriter.writerStreamId, 1n),
            },
            previousCommitDigest: null,
            requiredChunkKeysDigest: required.digest,
            sequence: 1n,
            writerStreamId: activeWriter.writerStreamId,
        });
        const id = (value: Uint8Array) => bytesToBase64Url(value);
        const writers = [gapWriter.writerStreamId, activeWriter.writerStreamId];
        const descriptorFrames = new Map([
            [id(gapWriter.writerStreamId), gapWriter.bytes],
            [id(activeWriter.writerStreamId), activeWriter.bytes],
        ]);
        const remote: AdaptiveJournalDiscoveryStoreV1 = {
            commitMetadataBatch: async () => ({
                failure: { category: "unknown", retry: "never" },
                status: "failed",
            }),
            listCommitSequences: async (writerStreamId) => ({
                sequences: id(writerStreamId) === id(gapWriter.writerStreamId) ? [2n] : [1n],
                status: "ok",
            }),
            listWriterStreamIds: async () => ({ status: "ok", writerStreamIds: writers }),
            putMetadataBatch: async () => ({ result: "inserted", status: "ok" }),
            readCommit: async (writerStreamId) =>
                id(writerStreamId) === id(activeWriter.writerStreamId)
                    ? { status: "found", value: commit.bytes }
                    : { status: "missing" },
            readMetadata: async (writerStreamId) =>
                id(writerStreamId) === id(activeWriter.writerStreamId)
                    ? { status: "found", value: metadata.bytes }
                    : { status: "missing" },
            readWriter: async (writerStreamId) => ({
                status: "found",
                value: descriptorFrames.get(id(writerStreamId))!,
            }),
            registerWriter: async () => ({ result: "inserted", status: "ok" }),
        };
        const storedChunk: StoredChunkRecordV1 = {
            frame: chunk.bytes,
            frameDigest: chunk.digest,
            key: chunk.remoteChunkKey,
        };
        const chunkReader: AdaptiveJournalChunkReaderV1 = {
            capabilities: { atomicBatchWrite: true, nativeMultiKeyLookup: true, serverSideImmutableCreate: true },
            getMany: async () => ({ chunks: [storedChunk], status: "ok" }),
            hasMany: async () => ({ availability: [true], status: "ok" }),
        };
        const applied: AdaptiveJournalReceivedBatchV1[] = [];
        const frontiers = new Map<string, AdaptiveJournalReceiveFrontierV1>();

        const result = await receiveAdaptiveJournalV1({
            catalogueLoader: ADAPTIVE_JOURNAL_NOOP_CATALOGUE_LOADER_V1,
            chunks: chunkReader,
            keys: candidate.keys,
            remote,
            sink: {
                apply: async (batch) => {
                    applied.push(batch);
                    frontiers.set(id(batch.writerStreamId), {
                        commitDigest: batch.commitDigest,
                        sequence: batch.sequence,
                    });
                },
                frontier: async (writerStreamId) =>
                    frontiers.get(id(writerStreamId)) ?? { commitDigest: null, sequence: 0n },
            },
        });

        expect(result).toMatchObject({ appliedBatches: 1, status: "partial" });
        if (result.status === "failed") return;
        expect(result.gaps).toEqual([
            { expectedSequence: 1n, observedSequence: 2n, writerStreamId: gapWriter.writerStreamId },
        ]);
        expect(applied).toHaveLength(1);
        expect(applied[0].documents).toEqual([document("active.md")]);
        expect(applied[0].chunks[0]).toMatchObject({ _id: "h:chunk", data: "body", type: "leaf" });
    });

    it("propagates a local sink failure without classifying valid remote data as invalid", async () => {
        const candidate = await createAdaptiveJournalManifestV1({
            encryption: "unencrypted",
            repositoryId: sequence(0x12),
            securitySeed: sequence(0x82),
        });
        const writer = await encodeAdaptiveJournalWriterDescriptorV1({
            hostId: "local-failure-host",
            keys: candidate.keys,
            writerEpoch: "local-failure-epoch",
        });
        const chunk = await encodeAdaptiveJournalChunkRecordV1({
            data: "body",
            keys: candidate.keys,
            localChunkId: "h:chunk" as DocumentID,
        });
        const metadata = await encodeAdaptiveJournalMetadataRecordV1({
            documents: [document("local-failure.md")],
            keys: candidate.keys,
            sequence: 1n,
            writerStreamId: writer.writerStreamId,
        });
        const required = await digestAdaptiveJournalRequiredChunkKeysV1([chunk.remoteChunkKey]);
        const commit = await encodeAdaptiveJournalCommitRecordV1({
            catalogueDeltas: [],
            keys: candidate.keys,
            metadata: {
                bytes: metadata.bytes.byteLength,
                digest: metadata.digest,
                key: adaptiveJournalMetadataObjectKeyV1(writer.writerStreamId, 1n),
            },
            previousCommitDigest: null,
            requiredChunkKeysDigest: required.digest,
            sequence: 1n,
            writerStreamId: writer.writerStreamId,
        });
        const remote: AdaptiveJournalDiscoveryStoreV1 = {
            commitMetadataBatch: async () => ({
                failure: { category: "unknown", retry: "never" },
                status: "failed",
            }),
            listCommitSequences: async () => ({ sequences: [1n], status: "ok" }),
            listWriterStreamIds: async () => ({ status: "ok", writerStreamIds: [writer.writerStreamId] }),
            putMetadataBatch: async () => ({ result: "inserted", status: "ok" }),
            readCommit: async () => ({ status: "found", value: commit.bytes }),
            readMetadata: async () => ({ status: "found", value: metadata.bytes }),
            readWriter: async () => ({ status: "found", value: writer.bytes }),
            registerWriter: async () => ({ result: "inserted", status: "ok" }),
        };
        const chunkReader: AdaptiveJournalChunkReaderV1 = {
            capabilities: { atomicBatchWrite: true, nativeMultiKeyLookup: true, serverSideImmutableCreate: true },
            getMany: async () => ({
                chunks: [{ frame: chunk.bytes, frameDigest: chunk.digest, key: chunk.remoteChunkKey }],
                status: "ok",
            }),
            hasMany: async () => ({ availability: [true], status: "ok" }),
        };
        const localFailure = new Error("local sink failed");

        await expect(
            receiveAdaptiveJournalV1({
                catalogueLoader: ADAPTIVE_JOURNAL_NOOP_CATALOGUE_LOADER_V1,
                chunks: chunkReader,
                keys: candidate.keys,
                remote,
                sink: {
                    apply: async () => {
                        throw localFailure;
                    },
                    frontier: async () => ({ commitDigest: null, sequence: 0n }),
                },
            })
        ).rejects.toBe(localFailure);
    });
});
