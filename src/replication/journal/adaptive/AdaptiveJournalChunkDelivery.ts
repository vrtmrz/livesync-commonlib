import type { AdaptiveJournalCatalogueV1 } from "./AdaptiveJournalCatalogue.ts";
import type { AdaptiveJournalChunkStoreV1 } from "./AdaptiveJournalChunkStore.ts";
import type { AdaptiveJournalCommitPackV1 } from "./AdaptiveJournalControl.ts";
import type { AdaptiveJournalKeySetV1 } from "./AdaptiveJournalManifest.ts";
import {
    publishAdaptiveJournalNativeChunksV1,
    type AdaptiveJournalChunkPublicationItemV1,
} from "./AdaptiveJournalNativeChunkPublication.ts";
import {
    publishAdaptiveJournalObjectChunksV1,
    type AdaptiveJournalCommittedPackCandidateV1,
} from "./AdaptiveJournalObjectChunkPublication.ts";
import type { AdaptiveJournalObjectPublicationCacheV1 } from "./AdaptiveJournalObjectPublicationCache.ts";
import type { AdaptiveJournalObjectRemoteV1 } from "./AdaptiveJournalObjectStore.ts";
import type { RemoteFailure } from "./AdaptiveJournalRepository.ts";

export interface AdaptiveJournalChunkDeliveryContextV1 {
    items: readonly AdaptiveJournalChunkPublicationItemV1[];
    sequence: bigint;
    writerStreamId: Uint8Array;
}

export type AdaptiveJournalChunkDeliveryOutcomeV1 =
    | {
          chunkPacks: readonly AdaptiveJournalCommitPackV1[];
          committedPackCandidates: readonly AdaptiveJournalCommittedPackCandidateV1[];
          inlinePack?: Uint8Array;
          requiredChunkKeys: readonly Uint8Array[];
          status: "ok";
      }
    | { key?: string | Uint8Array; status: "collision" }
    | { failure: RemoteFailure; status: "pending" };

export interface AdaptiveJournalChunkDeliveryV1 {
    acceptCommitted(candidates: readonly AdaptiveJournalCommittedPackCandidateV1[]): void;
    publish(context: AdaptiveJournalChunkDeliveryContextV1): Promise<AdaptiveJournalChunkDeliveryOutcomeV1>;
}

export function createAdaptiveJournalNativeChunkDeliveryV1(
    store: AdaptiveJournalChunkStoreV1,
    keys: AdaptiveJournalKeySetV1
): AdaptiveJournalChunkDeliveryV1 {
    return {
        acceptCommitted: () => undefined,
        publish: async ({ items }) => {
            const result = await publishAdaptiveJournalNativeChunksV1(store, keys, items);
            if (result.status === "pending" || result.status === "collision") return result;
            return {
                chunkPacks: [],
                committedPackCandidates: [],
                requiredChunkKeys: items.map(({ record }) => record.remoteChunkKey.slice()),
                status: "ok",
            };
        },
    };
}

export interface CreateAdaptiveJournalObjectChunkDeliveryV1Options {
    catalogue: AdaptiveJournalCatalogueV1;
    inlinePackMaxBytes?: number;
    keys: AdaptiveJournalKeySetV1;
    packMaxBytes?: number;
    publicationCache?: AdaptiveJournalObjectPublicationCacheV1;
    remote: AdaptiveJournalObjectRemoteV1;
}

export function createAdaptiveJournalObjectChunkDeliveryV1(
    options: CreateAdaptiveJournalObjectChunkDeliveryV1Options
): AdaptiveJournalChunkDeliveryV1 {
    return {
        acceptCommitted: (candidates) => {
            options.catalogue.applyCommittedPacks(candidates);
        },
        publish: async (context) => {
            const result = await publishAdaptiveJournalObjectChunksV1({
                catalogue: options.catalogue,
                inlinePackMaxBytes: options.inlinePackMaxBytes,
                items: context.items,
                keys: options.keys,
                packMaxBytes: options.packMaxBytes,
                publicationCache: options.publicationCache,
                remote: options.remote,
                sequence: context.sequence,
                writerStreamId: context.writerStreamId,
            });
            if (result.status === "failed") return { failure: result.failure, status: "pending" };
            return result;
        },
    };
}
