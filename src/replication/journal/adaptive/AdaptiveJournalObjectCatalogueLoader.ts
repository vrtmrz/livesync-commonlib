import type { AdaptiveJournalCatalogueV1 } from "./AdaptiveJournalCatalogue.ts";
import { bytesToHex, fixedLength } from "./AdaptiveJournalBinary.ts";
import type { AdaptiveJournalCommitPackV1 } from "./AdaptiveJournalControl.ts";
import type { RemoteFailure } from "./AdaptiveJournalRepository.ts";

export interface AdaptiveJournalCatalogueLoadContextV1 {
    chunkPacks: readonly AdaptiveJournalCommitPackV1[];
    requiredChunkKeys: readonly Uint8Array[];
    sequence: bigint;
    writerStreamId: Uint8Array;
}

export type AdaptiveJournalCatalogueLoadOutcomeV1 = { status: "ok" } | { failure: RemoteFailure; status: "failed" };

export interface AdaptiveJournalCatalogueLoaderV1 {
    load(context: AdaptiveJournalCatalogueLoadContextV1): Promise<AdaptiveJournalCatalogueLoadOutcomeV1>;
}

const INTEGRITY_FAILURE: RemoteFailure = { category: "invalid-response", retry: "never" };

function routesCoverRequiredChunks(context: AdaptiveJournalCatalogueLoadContextV1): boolean {
    const required = new Set(
        context.requiredChunkKeys.map((key) => bytesToHex(fixedLength(key, 32, "required remote Chunk key")))
    );
    const routed = context.chunkPacks.flatMap(({ entries }) =>
        entries.map(({ key }) => bytesToHex(fixedLength(key, 32, "routed remote Chunk key")))
    );
    return (
        required.size === context.requiredChunkKeys.length &&
        routed.length === required.size &&
        new Set(routed).size === required.size &&
        routed.every((key) => required.has(key))
    );
}

/** Builds the local catalogue directly from authenticated Commit Bundle routes. */
export function createAdaptiveJournalObjectCatalogueLoaderV1(options: {
    catalogue: AdaptiveJournalCatalogueV1;
}): AdaptiveJournalCatalogueLoaderV1 {
    return {
        load: async (context) => {
            try {
                if (!routesCoverRequiredChunks(context)) {
                    return { failure: INTEGRITY_FAILURE, status: "failed" };
                }
                options.catalogue.applyCommittedPacks(context.chunkPacks);
                return { status: "ok" };
            } catch {
                return { failure: INTEGRITY_FAILURE, status: "failed" };
            }
        },
    };
}

export const ADAPTIVE_JOURNAL_NOOP_CATALOGUE_LOADER_V1: AdaptiveJournalCatalogueLoaderV1 = {
    load: async () => ({ status: "ok" }),
};
