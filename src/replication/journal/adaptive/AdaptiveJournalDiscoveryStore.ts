import type { AdaptiveJournalEventStoreV1 } from "./AdaptiveJournalEventStore.ts";
import type { RemoteFailure } from "./AdaptiveJournalRepository.ts";

export type AdaptiveJournalWriterListResultV1 =
    | { status: "ok"; writerStreamIds: readonly Uint8Array[] }
    | { failure: RemoteFailure; status: "failed" };

export type AdaptiveJournalCommitSequenceListResultV1 =
    | { sequences: readonly bigint[]; status: "ok" }
    | { failure: RemoteFailure; status: "failed" };

export interface AdaptiveJournalDiscoveryStoreV1 extends AdaptiveJournalEventStoreV1 {
    listCommitSequences(writerStreamId: Uint8Array, afterSequence: bigint): Promise<AdaptiveJournalCommitSequenceListResultV1>;
    listWriterStreamIds(): Promise<AdaptiveJournalWriterListResultV1>;
}
