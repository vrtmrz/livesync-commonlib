import type { RemoteFailure, RemoteRead } from "./AdaptiveJournalRepository.ts";

export type AdaptiveImmutableRecordStatusV1 = "exact-existing" | "inserted" | "validate-existing";

export type AdaptiveImmutableRecordResultV1 =
    | { result: AdaptiveImmutableRecordStatusV1; status: "ok" }
    | { failure: RemoteFailure; status: "failed" };

export type AdaptiveCommitPublicationResultV1 =
    | { commitDigest: Uint8Array; result: AdaptiveImmutableRecordStatusV1; status: "ok" }
    | { failure: RemoteFailure; status: "failed" };

export interface AdaptiveWriterDescriptorRecordV1 {
    descriptorDigest: Uint8Array;
    descriptorFrame: Uint8Array;
    writerStreamId: Uint8Array;
}

export interface AdaptiveMetadataBatchRecordV1 {
    metadataDigest: Uint8Array;
    metadataFrame: Uint8Array;
    sequence: bigint;
    writerStreamId: Uint8Array;
}

export interface AdaptiveJournalEventStoreV1 {
    commitMetadataBatch(envelope: Uint8Array): Promise<AdaptiveCommitPublicationResultV1>;
    putMetadataBatch(record: AdaptiveMetadataBatchRecordV1): Promise<AdaptiveImmutableRecordResultV1>;
    readCommit(writerStreamId: Uint8Array, sequence: bigint): Promise<RemoteRead<Uint8Array>>;
    readMetadata(writerStreamId: Uint8Array, sequence: bigint): Promise<RemoteRead<Uint8Array>>;
    readWriter(writerStreamId: Uint8Array): Promise<RemoteRead<Uint8Array>>;
    registerWriter(record: AdaptiveWriterDescriptorRecordV1): Promise<AdaptiveImmutableRecordResultV1>;
}
