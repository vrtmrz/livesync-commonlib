import { bytesEqual } from "./AdaptiveJournalBinary.ts";
import type { AdaptiveJournalEventStoreV1, AdaptiveImmutableRecordResultV1 } from "./AdaptiveJournalEventStore.ts";
import type { AdaptiveJournalKeySetV1 } from "./AdaptiveJournalManifest.ts";
import {
    decodeAdaptiveJournalMetadataRecordV1,
    type EncodedAdaptiveJournalMetadataRecordV1,
} from "./AdaptiveJournalPayload.ts";
import type { RemoteFailure, RemoteRead } from "./AdaptiveJournalRepository.ts";
import {
    decodeAdaptiveJournalWriterDescriptorV1,
    type EncodedAdaptiveJournalWriterDescriptorV1,
} from "./AdaptiveJournalWriterDescriptor.ts";

export type AdaptiveJournalImmutablePublicationDispositionV1 =
    | "equivalent-existing"
    | "exact-existing"
    | "inserted";

export type AdaptiveJournalImmutablePublicationOutcomeV1 =
    | {
          bytes: number;
          digest: Uint8Array;
          disposition: AdaptiveJournalImmutablePublicationDispositionV1;
          status: "accepted";
      }
    | { status: "collision" }
    | { failure: RemoteFailure; status: "pending" };

interface PublishImmutableRecordV1Options {
    create(): Promise<AdaptiveImmutableRecordResultV1>;
    equivalentDigest(existing: Uint8Array): Promise<Uint8Array | false>;
    intended: Uint8Array;
    intendedDigest: Uint8Array;
    read(): Promise<RemoteRead<Uint8Array>>;
}

const MISSING_AFTER_CREATE: RemoteFailure = { category: "invalid-response", retry: "later" };

async function resolveImmutableRecordByRead(
    options: PublishImmutableRecordV1Options,
    precedingFailure?: RemoteFailure
): Promise<AdaptiveJournalImmutablePublicationOutcomeV1> {
    const read = await options.read();
    if (read.status === "failed") return { status: "pending", failure: read.failure };
    if (read.status === "missing") {
        return { status: "pending", failure: precedingFailure ?? MISSING_AFTER_CREATE };
    }
    if (bytesEqual(read.value, options.intended)) {
        return {
            bytes: options.intended.byteLength,
            digest: options.intendedDigest.slice(),
            disposition: "exact-existing",
            status: "accepted",
        };
    }
    try {
        const digest = await options.equivalentDigest(read.value);
        return digest
            ? {
                  bytes: read.value.byteLength,
                  digest: digest.slice(),
                  disposition: "equivalent-existing",
                  status: "accepted",
              }
            : { status: "collision" };
    } catch {
        return { status: "collision" };
    }
}

async function publishImmutableRecordV1(
    options: PublishImmutableRecordV1Options
): Promise<AdaptiveJournalImmutablePublicationOutcomeV1> {
    const created = await options.create();
    if (created.status === "ok") {
        if (created.result === "inserted" || created.result === "exact-existing") {
            return {
                bytes: options.intended.byteLength,
                digest: options.intendedDigest.slice(),
                disposition: created.result,
                status: "accepted",
            };
        }
        return await resolveImmutableRecordByRead(options);
    }
    if (created.failure.retry === "verify-first") {
        return await resolveImmutableRecordByRead(options, created.failure);
    }
    return { status: "pending", failure: created.failure };
}

export async function publishAdaptiveJournalWriterDescriptorV1(
    remote: AdaptiveJournalEventStoreV1,
    keys: AdaptiveJournalKeySetV1,
    descriptor: EncodedAdaptiveJournalWriterDescriptorV1
): Promise<AdaptiveJournalImmutablePublicationOutcomeV1> {
    const intended = await decodeAdaptiveJournalWriterDescriptorV1({
        bytes: descriptor.bytes,
        keys,
        writerStreamId: descriptor.writerStreamId,
    });
    if (!bytesEqual(intended.digest, descriptor.digest)) {
        throw new TypeError("Adaptive Journal Writer descriptor digest does not match its frame");
    }
    return await publishImmutableRecordV1({
        create: async () =>
            await remote.registerWriter({
                descriptorDigest: descriptor.digest,
                descriptorFrame: descriptor.bytes,
                writerStreamId: descriptor.writerStreamId,
            }),
        equivalentDigest: async (existing) => {
            const decoded = await decodeAdaptiveJournalWriterDescriptorV1({
                bytes: existing,
                keys,
                writerStreamId: descriptor.writerStreamId,
            });
            return JSON.stringify(decoded.payload) === JSON.stringify(intended.payload) ? decoded.digest : false;
        },
        intended: descriptor.bytes,
        intendedDigest: intended.digest,
        read: async () => await remote.readWriter(descriptor.writerStreamId),
    });
}

export interface PublishAdaptiveJournalMetadataRecordV1Options {
    keys: AdaptiveJournalKeySetV1;
    record: EncodedAdaptiveJournalMetadataRecordV1;
    remote: AdaptiveJournalEventStoreV1;
    sequence: bigint;
    writerStreamId: Uint8Array;
}

export async function publishAdaptiveJournalMetadataRecordV1(
    options: PublishAdaptiveJournalMetadataRecordV1Options
): Promise<AdaptiveJournalImmutablePublicationOutcomeV1> {
    const intended = await decodeAdaptiveJournalMetadataRecordV1({
        bytes: options.record.bytes,
        keys: options.keys,
        sequence: options.sequence,
        writerStreamId: options.writerStreamId,
    });
    if (!bytesEqual(intended.frameDigest, options.record.digest)) {
        throw new TypeError("Adaptive Journal Metadata digest does not match its frame");
    }
    return await publishImmutableRecordV1({
        create: async () =>
            await options.remote.putMetadataBatch({
                metadataDigest: options.record.digest,
                metadataFrame: options.record.bytes,
                sequence: options.sequence,
                writerStreamId: options.writerStreamId,
            }),
        equivalentDigest: async (existing) => {
            const decoded = await decodeAdaptiveJournalMetadataRecordV1({
                bytes: existing,
                keys: options.keys,
                sequence: options.sequence,
                writerStreamId: options.writerStreamId,
            });
            return bytesEqual(decoded.bytes, intended.bytes) ? decoded.frameDigest : false;
        },
        intended: options.record.bytes,
        intendedDigest: intended.frameDigest,
        read: async () => await options.remote.readMetadata(options.writerStreamId, options.sequence),
    });
}
