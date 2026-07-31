import { bytesEqual, bytesToBase64Url } from "./AdaptiveJournalBinary.ts";
import type { AdaptiveJournalCatalogueV1, AdaptiveJournalPackLocationV1 } from "./AdaptiveJournalCatalogue.ts";
import {
    MAX_ADAPTIVE_JOURNAL_CATALOGUE_DELTAS_V1,
    type AdaptiveJournalCommitDependencyV1,
} from "./AdaptiveJournalControl.ts";
import type { AdaptiveJournalKeySetV1 } from "./AdaptiveJournalManifest.ts";
import type { AdaptiveJournalChunkPublicationItemV1 } from "./AdaptiveJournalNativeChunkPublication.ts";
import type { AdaptiveJournalObjectPublicationCacheV1 } from "./AdaptiveJournalObjectPublicationCache.ts";
import {
    publishAdaptiveJournalPackV1,
    type AdaptiveJournalPackPublicationResultV1,
} from "./AdaptiveJournalObjectRepository.ts";
import type { AdaptiveJournalObjectRemoteV1 } from "./AdaptiveJournalObjectStore.ts";
import { buildAdaptiveJournalPackV1, type AdaptiveJournalPackIndexEntryV1 } from "./AdaptiveJournalPack.ts";

export interface AdaptiveJournalCommittedPackCandidateV1 {
    dependency: AdaptiveJournalCommitDependencyV1;
    entries: readonly AdaptiveJournalPackIndexEntryV1[];
    packId: Uint8Array;
}

export type AdaptiveJournalObjectChunkPublicationOutcomeV1 =
    | {
          catalogueDeltas: readonly AdaptiveJournalCommitDependencyV1[];
          committedPackCandidates: readonly AdaptiveJournalCommittedPackCandidateV1[];
          requiredChunkKeys: readonly Uint8Array[];
          status: "ok";
      }
    | Exclude<AdaptiveJournalPackPublicationResultV1, { status: "ok" }>;

export interface PublishAdaptiveJournalObjectChunksV1Options {
    catalogue: AdaptiveJournalCatalogueV1;
    items: readonly AdaptiveJournalChunkPublicationItemV1[];
    keys: AdaptiveJournalKeySetV1;
    publicationCache?: AdaptiveJournalObjectPublicationCacheV1;
    remote: AdaptiveJournalObjectRemoteV1;
    sequence: bigint;
    writerStreamId: Uint8Array;
}

function reusableDependency(
    locations: readonly AdaptiveJournalPackLocationV1[]
): AdaptiveJournalCommitDependencyV1 | undefined {
    return locations.find(({ catalogueDependency }) => catalogueDependency !== undefined)?.catalogueDependency;
}

function addDependency(
    dependencies: Map<string, AdaptiveJournalCommitDependencyV1>,
    dependency: AdaptiveJournalCommitDependencyV1
): void {
    const existing = dependencies.get(dependency.key);
    if (existing && !bytesEqual(existing.digest, dependency.digest)) {
        throw new TypeError("Adaptive Journal catalogue dependency key has conflicting digests");
    }
    dependencies.set(dependency.key, { digest: dependency.digest.slice(), key: dependency.key });
}

export async function publishAdaptiveJournalObjectChunksV1(
    options: PublishAdaptiveJournalObjectChunksV1Options
): Promise<AdaptiveJournalObjectChunkPublicationOutcomeV1> {
    const byKey = new Map<string, AdaptiveJournalChunkPublicationItemV1>();
    for (const item of options.items) {
        const key = bytesToBase64Url(item.record.remoteChunkKey);
        if (byKey.has(key)) throw new TypeError("Adaptive Journal Chunk publication contains a duplicate key");
        byKey.set(key, item);
    }
    const requiredChunkKeys = [...byKey.values()].map(({ record }) => record.remoteChunkKey.slice());
    const dependencies = new Map<string, AdaptiveJournalCommitDependencyV1>();
    let missing: AdaptiveJournalChunkPublicationItemV1[] = [];
    for (const item of byKey.values()) {
        const dependency = reusableDependency(options.catalogue.locations(item.record.remoteChunkKey));
        if (dependency) addDependency(dependencies, dependency);
        else missing.push(item);
    }
    if (dependencies.size + (missing.length > 0 ? 1 : 0) > MAX_ADAPTIVE_JOURNAL_CATALOGUE_DELTAS_V1) {
        dependencies.clear();
        missing = [...byKey.values()];
    }
    if (missing.length === 0) {
        return {
            catalogueDeltas: [...dependencies.values()],
            committedPackCandidates: [],
            requiredChunkKeys,
            status: "ok",
        };
    }
    const pack = await buildAdaptiveJournalPackV1({
        chunks: missing.map(({ record }) => ({ frame: record.bytes, key: record.remoteChunkKey })),
        keys: options.keys,
    });
    const published = await publishAdaptiveJournalPackV1({
        keys: options.keys,
        pack,
        publicationCache: options.publicationCache,
        remote: options.remote,
        sequence: options.sequence,
        writerStreamId: options.writerStreamId,
    });
    if (published.status !== "ok") return published;
    const dependency = { digest: published.deltaDigest.slice(), key: published.deltaKey };
    addDependency(dependencies, dependency);
    return {
        catalogueDeltas: [...dependencies.values()],
        committedPackCandidates: [{ dependency, entries: published.entries, packId: pack.packId }],
        requiredChunkKeys,
        status: "ok",
    };
}
