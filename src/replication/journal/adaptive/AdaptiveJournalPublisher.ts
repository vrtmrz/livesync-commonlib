import type { DocumentID, EntryDoc } from "@lib/common/types.ts";

import { bytesEqual } from "./AdaptiveJournalBinary.ts";
import type { AdaptiveJournalChunkDeliveryV1 } from "./AdaptiveJournalChunkDelivery.ts";
import { digestAdaptiveJournalRequiredChunkKeysV1, encodeCommitEnvelopeV1 } from "./AdaptiveJournalCommit.ts";
import { encodeAdaptiveJournalCommitRecordV1 } from "./AdaptiveJournalControl.ts";
import type { AdaptiveJournalEventStoreV1 } from "./AdaptiveJournalEventStore.ts";
import { publishAdaptiveJournalMetadataRecordV1 } from "./AdaptiveJournalImmutablePublication.ts";
import { AdaptiveJournalError, type AdaptiveJournalKeySetV1 } from "./AdaptiveJournalManifest.ts";
import { encodeAdaptiveJournalChunkRecordV1, encodeAdaptiveJournalMetadataRecordV1 } from "./AdaptiveJournalPayload.ts";
import type { RemoteFailure } from "./AdaptiveJournalRepository.ts";
import {
    publishAdaptiveJournalPendingCommitV1,
    stageAdaptiveJournalCommitV1,
    type AdaptiveJournalWriterStateStoreV1,
} from "./AdaptiveJournalWriter.ts";

export interface AdaptiveJournalChunkSourceV1 {
    data: string;
    localChunkId: DocumentID;
}

export interface PublishAdaptiveJournalMetadataBatchV1Options {
    chunkDelivery: AdaptiveJournalChunkDeliveryV1;
    chunks: readonly AdaptiveJournalChunkSourceV1[];
    documents: readonly EntryDoc[];
    keys: AdaptiveJournalKeySetV1;
    remote: AdaptiveJournalEventStoreV1;
    writerState: AdaptiveJournalWriterStateStoreV1;
}

export type AdaptiveJournalMetadataBatchPublicationOutcomeV1 =
    | { key?: string | Uint8Array; phase: "chunk" | "commit" | "metadata"; status: "collision" }
    | { sequence: bigint; status: "committed" }
    | { failure: RemoteFailure; phase: "chunk" | "commit" | "metadata"; status: "pending" }
    | { status: "registration-required" }
    | { sequence: bigint; status: "recovered" };

function invalidChunkSet(message: string): AdaptiveJournalError {
    return new AdaptiveJournalError("invalid-metadata-payload", message);
}

async function recoverPendingCommit(
    options: PublishAdaptiveJournalMetadataBatchV1Options
): Promise<AdaptiveJournalMetadataBatchPublicationOutcomeV1 | undefined> {
    const state = await options.writerState.load();
    if (state.pendingWriterDescriptor) return { status: "registration-required" };
    if (!state.pendingCommit) return undefined;
    const recovered = await publishAdaptiveJournalPendingCommitV1(options.writerState, options.remote);
    if (recovered.status === "committed") return { sequence: recovered.sequence, status: "recovered" };
    if (recovered.status === "collision") {
        return { phase: "commit", status: "collision" };
    }
    if (recovered.status === "pending") {
        return { failure: recovered.failure, phase: "commit", status: "pending" };
    }
    return undefined;
}

function requiredChunkSources(
    localChunkIds: readonly DocumentID[],
    sources: readonly AdaptiveJournalChunkSourceV1[]
): readonly AdaptiveJournalChunkSourceV1[] {
    const byId = new Map<DocumentID, AdaptiveJournalChunkSourceV1>();
    for (const source of sources) {
        if (!source.localChunkId.startsWith("h:")) throw invalidChunkSet("Chunk source has an invalid local Chunk ID");
        if (byId.has(source.localChunkId))
            throw invalidChunkSet("Chunk source set contains a duplicate local Chunk ID");
        byId.set(source.localChunkId, source);
    }
    if (byId.size !== localChunkIds.length) {
        throw invalidChunkSet("Chunk source set does not match the Metadata dependencies");
    }
    return localChunkIds.map((localChunkId) => {
        const source = byId.get(localChunkId);
        if (!source) throw invalidChunkSet(`Missing Chunk source for ${localChunkId}`);
        return source;
    });
}

export async function publishAdaptiveJournalMetadataBatchV1(
    options: PublishAdaptiveJournalMetadataBatchV1Options
): Promise<AdaptiveJournalMetadataBatchPublicationOutcomeV1> {
    const recovered = await recoverPendingCommit(options);
    if (recovered) return recovered;
    const state = await options.writerState.load();
    if (!bytesEqual(state.repositoryId, options.keys.repositoryId)) {
        throw new AdaptiveJournalError(
            "repository-id-mismatch",
            "Writer state repository ID does not match the opened Adaptive Journal repository"
        );
    }
    if (options.documents.length === 0) throw invalidChunkSet("Metadata batch must contain at least one document");
    const sequence = state.lastCommittedSequence + 1n;
    const metadata = await encodeAdaptiveJournalMetadataRecordV1({
        documents: options.documents,
        keys: options.keys,
        sequence,
        writerStreamId: state.writerStreamId,
    });
    const chunkSources = requiredChunkSources(metadata.localChunkIds, options.chunks);
    const chunkItems = [];
    for (const { data, localChunkId } of chunkSources) {
        chunkItems.push({
            localChunkId,
            record: await encodeAdaptiveJournalChunkRecordV1({ data, keys: options.keys, localChunkId }),
        });
    }
    const chunks = await options.chunkDelivery.publish({
        items: chunkItems,
        sequence,
        writerStreamId: state.writerStreamId,
    });
    if (chunks.status === "pending") return { ...chunks, phase: "chunk" };
    if (chunks.status === "collision") return { ...chunks, phase: "chunk" };

    const metadataPublication = await publishAdaptiveJournalMetadataRecordV1({
        keys: options.keys,
        record: metadata,
        remote: options.remote,
        sequence,
        writerStreamId: state.writerStreamId,
    });
    if (metadataPublication.status === "pending") return { ...metadataPublication, phase: "metadata" };
    if (metadataPublication.status === "collision") return { phase: "metadata", status: "collision" };

    const requiredChunkKeySet = await digestAdaptiveJournalRequiredChunkKeysV1(chunks.requiredChunkKeys);
    const commitRecord = await encodeAdaptiveJournalCommitRecordV1({
        chunkPacks: chunks.chunkPacks,
        keys: options.keys,
        metadata: {
            bytes: metadataPublication.bytes,
            digest: metadataPublication.digest,
        },
        previousCommitDigest: state.lastCommitDigest,
        requiredChunkKeysDigest: requiredChunkKeySet.digest,
        sequence,
        writerStreamId: state.writerStreamId,
    });
    const envelope = await encodeCommitEnvelopeV1({
        commitFrame: commitRecord.bytes,
        ...(chunks.inlinePack ? { inlinePack: chunks.inlinePack } : {}),
        metadataDigest: metadataPublication.digest,
        metadataFrame: metadata.bytes,
        previousCommitDigest: state.lastCommitDigest,
        repositoryId: state.repositoryId,
        requiredChunkKeys: requiredChunkKeySet.keys,
        sequence,
        writerStreamId: state.writerStreamId,
    });
    await stageAdaptiveJournalCommitV1(options.writerState, envelope.bytes);
    const committed = await publishAdaptiveJournalPendingCommitV1(options.writerState, options.remote);
    if (committed.status === "pending") return { ...committed, phase: "commit" };
    if (committed.status === "collision") return { phase: "commit", status: "collision" };
    if (committed.status !== "committed") {
        throw new AdaptiveJournalError("remote-operation-failed", "Staged Adaptive Journal Commit was not published");
    }
    options.chunkDelivery.acceptCommitted(chunks.committedPackCandidates);
    return { sequence: committed.sequence, status: "committed" };
}
