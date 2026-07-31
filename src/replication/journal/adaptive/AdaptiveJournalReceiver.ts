import type { DocumentID, EntryDoc, EntryLeaf } from "@lib/common/types.ts";

import { base64UrlToBytes, bytesEqual, bytesToBase64Url, fixedLength } from "./AdaptiveJournalBinary.ts";
import type { AdaptiveJournalCatalogueLoaderV1 } from "./AdaptiveJournalObjectCatalogueLoader.ts";
import { digestAdaptiveJournalRequiredChunkKeysV1 } from "./AdaptiveJournalCommit.ts";
import type { AdaptiveJournalChunkReaderV1 } from "./AdaptiveJournalChunkStore.ts";
import { decodeAdaptiveJournalCommitRecordV1 } from "./AdaptiveJournalControl.ts";
import type { AdaptiveJournalDiscoveryStoreV1 } from "./AdaptiveJournalDiscoveryStore.ts";
import { deriveRemoteChunkKeyV1, type AdaptiveJournalKeySetV1 } from "./AdaptiveJournalManifest.ts";
import { decodeAdaptiveJournalChunkRecordV1, decodeAdaptiveJournalMetadataRecordV1 } from "./AdaptiveJournalPayload.ts";
import type { RemoteFailure, RemoteRead } from "./AdaptiveJournalRepository.ts";
import { decodeAdaptiveJournalWriterDescriptorV1 } from "./AdaptiveJournalWriterDescriptor.ts";

export interface AdaptiveJournalReceiveFrontierV1 {
    commitDigest: Uint8Array | null;
    sequence: bigint;
}

export interface AdaptiveJournalReceivedBatchV1 {
    chunks: readonly EntryLeaf[];
    commitDigest: Uint8Array;
    documents: readonly EntryDoc[];
    sequence: bigint;
    writerStreamId: Uint8Array;
}

export interface AdaptiveJournalReceiveSinkV1 {
    apply(batch: AdaptiveJournalReceivedBatchV1): Promise<void>;
    frontier(writerStreamId: Uint8Array): Promise<AdaptiveJournalReceiveFrontierV1>;
    hasChunks(localChunkIds: readonly DocumentID[]): Promise<readonly boolean[]>;
}

export interface AdaptiveJournalReceiveGapV1 {
    expectedSequence: bigint;
    observedSequence: bigint;
    writerStreamId: Uint8Array;
}

export interface AdaptiveJournalReceiveBlockV1 {
    failure: RemoteFailure;
    sequence?: bigint;
    writerStreamId: Uint8Array;
}

export type AdaptiveJournalReceiveOutcomeV1 =
    | {
          appliedBatches: number;
          blocks: readonly AdaptiveJournalReceiveBlockV1[];
          gaps: readonly AdaptiveJournalReceiveGapV1[];
          status: "ok" | "partial";
      }
    | { failure: RemoteFailure; status: "failed" };

export interface ReceiveAdaptiveJournalV1Options {
    catalogueLoader: AdaptiveJournalCatalogueLoaderV1;
    chunks: AdaptiveJournalChunkReaderV1;
    keys: AdaptiveJournalKeySetV1;
    remote: AdaptiveJournalDiscoveryStoreV1;
    sink: AdaptiveJournalReceiveSinkV1;
}

const INVALID_REMOTE: RemoteFailure = { category: "invalid-response", retry: "never" };
const MISSING_REMOTE: RemoteFailure = { category: "unavailable", retry: "later" };

class AdaptiveJournalLocalSinkFailure {
    constructor(readonly reason: unknown) {}
}

function blocked(
    blocks: AdaptiveJournalReceiveBlockV1[],
    writerStreamId: Uint8Array,
    failure: RemoteFailure,
    sequence?: bigint
): void {
    blocks.push({ failure, sequence, writerStreamId: writerStreamId.slice() });
}

function foundOrFailure(read: RemoteRead<Uint8Array>): Uint8Array | RemoteFailure {
    if (read.status === "found") return read.value;
    return read.status === "failed" ? read.failure : MISSING_REMOTE;
}

async function receiveWriter(
    options: ReceiveAdaptiveJournalV1Options,
    writerStreamId: Uint8Array,
    gaps: AdaptiveJournalReceiveGapV1[],
    blocks: AdaptiveJournalReceiveBlockV1[]
): Promise<number> {
    const descriptorRead = foundOrFailure(await options.remote.readWriter(writerStreamId));
    if (!(descriptorRead instanceof Uint8Array)) {
        blocked(blocks, writerStreamId, descriptorRead);
        return 0;
    }
    try {
        await decodeAdaptiveJournalWriterDescriptorV1({ bytes: descriptorRead, keys: options.keys, writerStreamId });
    } catch {
        blocked(blocks, writerStreamId, INVALID_REMOTE);
        return 0;
    }
    let frontier = await options.sink.frontier(writerStreamId);
    if (
        frontier.sequence < 0n ||
        frontier.sequence > 0x7fffffffffffffffn ||
        (frontier.sequence === 0n) !== (frontier.commitDigest === null)
    ) {
        throw new TypeError("Adaptive Journal receive frontier is invalid");
    }
    if (frontier.commitDigest !== null) fixedLength(frontier.commitDigest, 32, "frontier Commit digest");
    const listed = await options.remote.listCommitSequences(writerStreamId, frontier.sequence);
    if (listed.status === "failed") {
        blocked(blocks, writerStreamId, listed.failure);
        return 0;
    }
    let applied = 0;
    for (const sequence of listed.sequences) {
        const expectedSequence = frontier.sequence + 1n;
        if (sequence !== expectedSequence) {
            gaps.push({ expectedSequence, observedSequence: sequence, writerStreamId: writerStreamId.slice() });
            break;
        }
        const commitRead = foundOrFailure(await options.remote.readCommit(writerStreamId, sequence));
        if (!(commitRead instanceof Uint8Array)) {
            blocked(blocks, writerStreamId, commitRead, sequence);
            break;
        }
        let received: AdaptiveJournalReceivedBatchV1 | undefined;
        try {
            const commit = await decodeAdaptiveJournalCommitRecordV1({
                bytes: commitRead,
                keys: options.keys,
                sequence,
                writerStreamId,
            });
            const previousDigest =
                commit.payload.previousCommitDigest === null
                    ? null
                    : fixedLength(base64UrlToBytes(commit.payload.previousCommitDigest), 32, "previous Commit digest");
            if (
                (frontier.commitDigest === null && previousDigest !== null) ||
                (frontier.commitDigest !== null &&
                    (previousDigest === null || !bytesEqual(frontier.commitDigest, previousDigest)))
            ) {
                blocked(blocks, writerStreamId, INVALID_REMOTE, sequence);
                break;
            }
            const metadataRead = foundOrFailure(await options.remote.readMetadata(writerStreamId, sequence));
            if (!(metadataRead instanceof Uint8Array)) {
                blocked(blocks, writerStreamId, metadataRead, sequence);
                break;
            }
            const expectedMetadataDigest = fixedLength(
                base64UrlToBytes(commit.payload.metadata.digest),
                32,
                "Metadata digest"
            );
            const metadata = await decodeAdaptiveJournalMetadataRecordV1({
                bytes: metadataRead,
                keys: options.keys,
                sequence,
                writerStreamId,
            });
            if (
                metadataRead.byteLength !== commit.payload.metadata.bytes ||
                !bytesEqual(metadata.frameDigest, expectedMetadataDigest)
            ) {
                blocked(blocks, writerStreamId, INVALID_REMOTE, sequence);
                break;
            }
            const remoteChunkKeys = await Promise.all(
                metadata.localChunkIds.map(
                    async (localChunkId) => await deriveRemoteChunkKeyV1(options.keys, localChunkId)
                )
            );
            const required = await digestAdaptiveJournalRequiredChunkKeysV1(remoteChunkKeys);
            if (
                bytesToBase64Url(required.digest) !== commit.payload.requiredChunkKeysDigest ||
                required.keys.length !== remoteChunkKeys.length
            ) {
                blocked(blocks, writerStreamId, INVALID_REMOTE, sequence);
                break;
            }
            const loaded = await options.catalogueLoader.load({
                dependencies: commit.payload.catalogueDeltas.map(({ digest, key }) => ({
                    digest: fixedLength(base64UrlToBytes(digest), 32, "catalogue Delta digest"),
                    key,
                })),
                sequence,
                writerStreamId,
            });
            if (loaded.status === "failed") {
                blocked(blocks, writerStreamId, loaded.failure, sequence);
                break;
            }
            let availableLocally: readonly boolean[];
            try {
                availableLocally = await options.sink.hasChunks(metadata.localChunkIds);
                if (
                    availableLocally.length !== metadata.localChunkIds.length ||
                    !availableLocally.every((available) => typeof available === "boolean")
                ) {
                    throw new TypeError("Adaptive Journal local Chunk availability result is invalid");
                }
            } catch (error) {
                throw new AdaptiveJournalLocalSinkFailure(error);
            }
            const missingIndexes = availableLocally.flatMap((available, index) => (available ? [] : [index]));
            const fetched = await options.chunks.getMany(missingIndexes.map((index) => remoteChunkKeys[index]));
            if (fetched.status === "failed") {
                blocked(blocks, writerStreamId, fetched.failure, sequence);
                break;
            }
            if (fetched.chunks.length !== missingIndexes.length) {
                blocked(blocks, writerStreamId, INVALID_REMOTE, sequence);
                break;
            }
            const chunks: EntryLeaf[] = [];
            let incomplete = false;
            for (let fetchedIndex = 0; fetchedIndex < missingIndexes.length; fetchedIndex++) {
                const metadataIndex = missingIndexes[fetchedIndex];
                const stored = fetched.chunks[fetchedIndex];
                if (!stored) {
                    blocked(blocks, writerStreamId, MISSING_REMOTE, sequence);
                    incomplete = true;
                    break;
                }
                const decoded = await decodeAdaptiveJournalChunkRecordV1({
                    bytes: stored.frame,
                    keys: options.keys,
                    localChunkId: metadata.localChunkIds[metadataIndex],
                });
                if (
                    !bytesEqual(stored.key, decoded.remoteChunkKey) ||
                    !bytesEqual(stored.frameDigest, decoded.frameDigest)
                ) {
                    blocked(blocks, writerStreamId, INVALID_REMOTE, sequence);
                    incomplete = true;
                    break;
                }
                chunks.push({ _id: decoded._id, data: decoded.data, type: "leaf" });
            }
            if (incomplete) break;
            received = {
                chunks,
                commitDigest: commit.digest,
                documents: metadata.documents,
                sequence,
                writerStreamId,
            };
        } catch (error) {
            if (error instanceof AdaptiveJournalLocalSinkFailure) throw error.reason;
            blocked(blocks, writerStreamId, INVALID_REMOTE, sequence);
            break;
        }
        if (!received) break;
        await options.sink.apply(received);
        frontier = { commitDigest: received.commitDigest, sequence };
        applied += 1;
    }
    return applied;
}

export async function receiveAdaptiveJournalV1(
    options: ReceiveAdaptiveJournalV1Options
): Promise<AdaptiveJournalReceiveOutcomeV1> {
    const writers = await options.remote.listWriterStreamIds();
    if (writers.status === "failed") return writers;
    const gaps: AdaptiveJournalReceiveGapV1[] = [];
    const blocks: AdaptiveJournalReceiveBlockV1[] = [];
    let appliedBatches = 0;
    for (const writerStreamId of writers.writerStreamIds) {
        appliedBatches += await receiveWriter(options, writerStreamId, gaps, blocks);
    }
    return {
        appliedBatches,
        blocks,
        gaps,
        status: gaps.length === 0 && blocks.length === 0 ? "ok" : "partial",
    };
}
