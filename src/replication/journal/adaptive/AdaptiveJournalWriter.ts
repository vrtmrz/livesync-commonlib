import { bytesEqual } from "./AdaptiveJournalBinary.ts";
import { decodeCommitEnvelopeV1, type DecodedCommitEnvelopeV1 } from "./AdaptiveJournalCommit.ts";
import type { AdaptiveJournalEventStoreV1 } from "./AdaptiveJournalEventStore.ts";
import { AdaptiveJournalError, sha256 } from "./AdaptiveJournalManifest.ts";
import type { RemoteFailure } from "./AdaptiveJournalRepository.ts";

export interface AdaptiveJournalPendingCommitV1 {
    commitFrameDigest: Uint8Array;
    envelopeDigest: Uint8Array;
    exactBytes: Uint8Array;
    sequence: bigint;
}

export interface AdaptiveJournalPendingWriterDescriptorV1 {
    descriptorDigest: Uint8Array;
    exactBytes: Uint8Array;
}

export interface AdaptiveJournalWriterStateV1 {
    lastCommitDigest: Uint8Array | null;
    lastCommittedSequence: bigint;
    lastLocalSequence?: number | string;
    pendingCommit?: AdaptiveJournalPendingCommitV1;
    pendingWriterDescriptor?: AdaptiveJournalPendingWriterDescriptorV1;
    repositoryId: Uint8Array;
    writerEpoch: string;
    writerRegistered?: boolean;
    writerStreamId: Uint8Array;
}

export interface AdaptiveJournalWriterStateStoreV1 {
    acceptPendingCommit(expectedEnvelopeDigest: Uint8Array, commitFrameDigest: Uint8Array): Promise<void>;
    load(): Promise<AdaptiveJournalWriterStateV1>;
    stagePendingCommit(pending: AdaptiveJournalPendingCommitV1): Promise<void>;
}

export type AdaptiveJournalCommitStageResultV1 = "already-staged" | "staged";

export type AdaptiveJournalCommitPublicationOutcomeV1 =
    | { status: "idle" }
    | { failure: RemoteFailure; status: "pending" }
    | { sequence: bigint; status: "collision" }
    | { sequence: bigint; status: "committed" };

function requireWriterFrontier(
    state: AdaptiveJournalWriterStateV1,
    commit: DecodedCommitEnvelopeV1
): void {
    if (!bytesEqual(state.repositoryId, commit.repositoryId)) {
        throw new AdaptiveJournalError(
            "repository-id-mismatch",
            "Commit repository ID does not match the local writer binding"
        );
    }
    if (!bytesEqual(state.writerStreamId, commit.writerStreamId)) {
        throw new AdaptiveJournalError(
            "writer-sequence-mismatch",
            "Commit writer stream does not match the local writer binding"
        );
    }
    if (commit.sequence !== state.lastCommittedSequence + 1n) {
        throw new AdaptiveJournalError(
            "writer-sequence-mismatch",
            "Commit sequence is not the next dense local writer sequence"
        );
    }
    const predecessorMatches =
        state.lastCommitDigest === null
            ? commit.previousCommitDigest === null
            : commit.previousCommitDigest !== null && bytesEqual(state.lastCommitDigest, commit.previousCommitDigest);
    if (!predecessorMatches) {
        throw new AdaptiveJournalError(
            "writer-sequence-mismatch",
            "Commit predecessor does not match the local writer frontier"
        );
    }
}

async function validatePendingCommit(
    state: AdaptiveJournalWriterStateV1,
    pending: AdaptiveJournalPendingCommitV1
): Promise<DecodedCommitEnvelopeV1> {
    const commit = await decodeCommitEnvelopeV1(pending.exactBytes);
    if (
        pending.sequence !== commit.sequence ||
        !bytesEqual(pending.envelopeDigest, commit.digest) ||
        !bytesEqual(pending.commitFrameDigest, commit.commitFrameDigest)
    ) {
        throw new AdaptiveJournalError(
            "pending-commit-mismatch",
            "Pending Commit state does not match its exact persisted bytes"
        );
    }
    requireWriterFrontier(state, commit);
    return commit;
}

export async function stageAdaptiveJournalCommitV1(
    store: AdaptiveJournalWriterStateStoreV1,
    exactBytes: Uint8Array
): Promise<AdaptiveJournalCommitStageResultV1> {
    const state = await store.load();
    const commit = await decodeCommitEnvelopeV1(exactBytes);
    requireWriterFrontier(state, commit);
    if (state.pendingCommit) {
        const pending = await validatePendingCommit(state, state.pendingCommit);
        if (bytesEqual(pending.digest, commit.digest) && bytesEqual(state.pendingCommit.exactBytes, exactBytes)) {
            return "already-staged";
        }
        throw new AdaptiveJournalError(
            "pending-commit-mismatch",
            "A different Commit is already pending for this writer sequence"
        );
    }
    await store.stagePendingCommit({
        commitFrameDigest: commit.commitFrameDigest.slice(),
        envelopeDigest: commit.digest.slice(),
        exactBytes: exactBytes.slice(),
        sequence: commit.sequence,
    });
    return "staged";
}

async function acceptPending(
    store: AdaptiveJournalWriterStateStoreV1,
    pending: AdaptiveJournalPendingCommitV1
): Promise<AdaptiveJournalCommitPublicationOutcomeV1> {
    await store.acceptPendingCommit(pending.envelopeDigest, pending.commitFrameDigest);
    return { status: "committed", sequence: pending.sequence };
}

async function resolveByRead(
    store: AdaptiveJournalWriterStateStoreV1,
    remote: AdaptiveJournalEventStoreV1,
    state: AdaptiveJournalWriterStateV1,
    pending: AdaptiveJournalPendingCommitV1,
    commit: DecodedCommitEnvelopeV1,
    originalFailure?: RemoteFailure
): Promise<AdaptiveJournalCommitPublicationOutcomeV1> {
    const read = await remote.readCommit(state.writerStreamId, pending.sequence);
    if (read.status === "found") {
        if (bytesEqual(read.value, commit.commitFrame) && bytesEqual(await sha256(read.value), pending.commitFrameDigest)) {
            return await acceptPending(store, pending);
        }
        return { status: "collision", sequence: pending.sequence };
    }
    if (read.status === "failed") return { status: "pending", failure: read.failure };
    return {
        status: "pending",
        failure: originalFailure ?? { category: "invalid-response", retry: "later" },
    };
}

export async function publishAdaptiveJournalPendingCommitV1(
    store: AdaptiveJournalWriterStateStoreV1,
    remote: AdaptiveJournalEventStoreV1
): Promise<AdaptiveJournalCommitPublicationOutcomeV1> {
    const state = await store.load();
    const pending = state.pendingCommit;
    if (!pending) return { status: "idle" };
    const commit = await validatePendingCommit(state, pending);
    const published = await remote.commitMetadataBatch(pending.exactBytes);
    if (published.status === "ok") {
        if (published.result === "validate-existing") {
            return await resolveByRead(store, remote, state, pending, commit);
        }
        if (!bytesEqual(published.commitDigest, pending.commitFrameDigest)) {
            return { status: "collision", sequence: pending.sequence };
        }
        return await acceptPending(store, pending);
    }
    if (published.failure.retry === "verify-first") {
        return await resolveByRead(store, remote, state, pending, commit, published.failure);
    }
    return { status: "pending", failure: published.failure };
}
