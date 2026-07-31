import type { ImmutableCreate, RemoteFailure, RemoteRead } from "./AdaptiveJournalRepository.ts";

export interface AdaptiveJournalByteRangeV1 {
    length: number;
    offset: number;
}

export type AdaptiveJournalObjectListV1 =
    | { keys: readonly string[]; status: "ok" }
    | { failure: RemoteFailure; status: "failed" };

export interface AdaptiveJournalObjectRemoteV1 {
    createAdaptiveObject(key: string, bytes: Uint8Array, mime: string): Promise<ImmutableCreate>;
    listAdaptiveObjects(prefix: string): Promise<AdaptiveJournalObjectListV1>;
    readAdaptiveObject(key: string, range?: AdaptiveJournalByteRangeV1): Promise<RemoteRead<Uint8Array>>;
}
