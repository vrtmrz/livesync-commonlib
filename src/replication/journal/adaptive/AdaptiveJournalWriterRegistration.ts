import { bytesEqual } from "./AdaptiveJournalBinary.ts";
import type { AdaptiveJournalEventStoreV1 } from "./AdaptiveJournalEventStore.ts";
import { publishAdaptiveJournalWriterDescriptorV1 } from "./AdaptiveJournalImmutablePublication.ts";
import { AdaptiveJournalError, type AdaptiveJournalKeySetV1 } from "./AdaptiveJournalManifest.ts";
import type { RemoteFailure } from "./AdaptiveJournalRepository.ts";
import type {
    AdaptiveJournalPendingWriterDescriptorV1,
    AdaptiveJournalWriterStateV1,
} from "./AdaptiveJournalWriter.ts";
import {
    decodeAdaptiveJournalWriterDescriptorV1,
    type EncodedAdaptiveJournalWriterDescriptorV1,
} from "./AdaptiveJournalWriterDescriptor.ts";

export interface AdaptiveJournalWriterRegistrationStoreV1 {
    acceptPendingWriterDescriptor(expectedDigest: Uint8Array): Promise<void>;
    load(): Promise<AdaptiveJournalWriterStateV1>;
    stagePendingWriterDescriptor(pending: AdaptiveJournalPendingWriterDescriptorV1): Promise<void>;
}

export type AdaptiveJournalWriterDescriptorStageResultV1 = "already-staged" | "staged";

export type AdaptiveJournalWriterRegistrationOutcomeV1 =
    | { status: "collision" }
    | { status: "idle" }
    | { failure: RemoteFailure; status: "pending" }
    | { status: "registered" };

function validateStateIdentity(state: AdaptiveJournalWriterStateV1, keys: AdaptiveJournalKeySetV1): void {
    if (!bytesEqual(state.repositoryId, keys.repositoryId)) {
        throw new AdaptiveJournalError(
            "repository-id-mismatch",
            "Writer state repository ID does not match the opened Adaptive Journal repository"
        );
    }
}

export async function stageAdaptiveJournalWriterDescriptorV1(
    store: AdaptiveJournalWriterRegistrationStoreV1,
    keys: AdaptiveJournalKeySetV1,
    descriptor: EncodedAdaptiveJournalWriterDescriptorV1
): Promise<AdaptiveJournalWriterDescriptorStageResultV1> {
    const state = await store.load();
    validateStateIdentity(state, keys);
    const decoded = await decodeAdaptiveJournalWriterDescriptorV1({
        bytes: descriptor.bytes,
        keys,
        writerStreamId: state.writerStreamId,
    });
    if (
        !bytesEqual(descriptor.writerStreamId, state.writerStreamId) ||
        decoded.payload.writerEpoch !== state.writerEpoch ||
        !bytesEqual(decoded.digest, descriptor.digest)
    ) {
        throw new AdaptiveJournalError(
            "pending-writer-descriptor-mismatch",
            "Writer descriptor does not match the persisted writer identity"
        );
    }
    if (state.pendingWriterDescriptor) {
        if (
            bytesEqual(state.pendingWriterDescriptor.descriptorDigest, descriptor.digest) &&
            bytesEqual(state.pendingWriterDescriptor.exactBytes, descriptor.bytes)
        ) {
            return "already-staged";
        }
        throw new AdaptiveJournalError(
            "pending-writer-descriptor-mismatch",
            "A different Writer descriptor is already pending"
        );
    }
    await store.stagePendingWriterDescriptor({
        descriptorDigest: descriptor.digest.slice(),
        exactBytes: descriptor.bytes.slice(),
    });
    return "staged";
}

export async function publishAdaptiveJournalPendingWriterDescriptorV1(
    store: AdaptiveJournalWriterRegistrationStoreV1,
    remote: AdaptiveJournalEventStoreV1,
    keys: AdaptiveJournalKeySetV1
): Promise<AdaptiveJournalWriterRegistrationOutcomeV1> {
    const state = await store.load();
    validateStateIdentity(state, keys);
    const pending = state.pendingWriterDescriptor;
    if (!pending) return { status: "idle" };
    const decoded = await decodeAdaptiveJournalWriterDescriptorV1({
        bytes: pending.exactBytes,
        keys,
        writerStreamId: state.writerStreamId,
    });
    if (decoded.payload.writerEpoch !== state.writerEpoch || !bytesEqual(decoded.digest, pending.descriptorDigest)) {
        throw new AdaptiveJournalError(
            "pending-writer-descriptor-mismatch",
            "Pending Writer descriptor does not match the persisted writer identity"
        );
    }
    const publication = await publishAdaptiveJournalWriterDescriptorV1(remote, keys, {
        bytes: pending.exactBytes,
        digest: pending.descriptorDigest,
        payload: decoded.payload,
        writerStreamId: state.writerStreamId,
    });
    if (publication.status === "pending") return publication;
    if (publication.status === "collision") return publication;
    await store.acceptPendingWriterDescriptor(pending.descriptorDigest);
    return { status: "registered" };
}
