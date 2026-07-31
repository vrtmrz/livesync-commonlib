import type { RemoteFailure } from "./AdaptiveJournalRepository.ts";

export interface StoredChunkRecordV1 {
    frame: Uint8Array;
    frameDigest: Uint8Array;
    key: Uint8Array;
}

export type AdaptiveChunkAvailabilityResultV1 =
    | { availability: readonly boolean[]; status: "ok" }
    | { failure: RemoteFailure; status: "failed" };

export type AdaptiveChunkGetResultV1 =
    | { chunks: readonly (StoredChunkRecordV1 | undefined)[]; status: "ok" }
    | { failure: RemoteFailure; status: "failed" };

export type AdaptiveChunkPutStatusV1 = "exact-existing" | "inserted" | "validate-existing";

export type AdaptiveChunkPutResultV1 =
    | { results: readonly AdaptiveChunkPutStatusV1[]; status: "ok" }
    | { failure: RemoteFailure; status: "failed" };

export interface AdaptiveJournalChunkReaderV1 {
    readonly capabilities: {
        atomicBatchWrite: boolean;
        nativeMultiKeyLookup: boolean;
        serverSideImmutableCreate: boolean;
    };
    getMany(keys: readonly Uint8Array[]): Promise<AdaptiveChunkGetResultV1>;
    hasMany(keys: readonly Uint8Array[]): Promise<AdaptiveChunkAvailabilityResultV1>;
}

export interface AdaptiveJournalChunkStoreV1 extends AdaptiveJournalChunkReaderV1 {
    putMany(chunks: readonly StoredChunkRecordV1[]): Promise<AdaptiveChunkPutResultV1>;
}
