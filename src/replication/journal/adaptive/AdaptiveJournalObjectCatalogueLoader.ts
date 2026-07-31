import {
    AdaptiveJournalCatalogueV1,
    adaptiveJournalIndexObjectKeyV1,
    decodeAdaptiveJournalCatalogueDeltaV1,
    parseAdaptiveJournalDeltaObjectKeyV1,
} from "./AdaptiveJournalCatalogue.ts";
import { base64UrlToBytes, bytesEqual, fixedLength } from "./AdaptiveJournalBinary.ts";
import type { AdaptiveJournalCommitDependencyV1 } from "./AdaptiveJournalControl.ts";
import type { AdaptiveJournalKeySetV1 } from "./AdaptiveJournalManifest.ts";
import type { AdaptiveJournalObjectRemoteV1 } from "./AdaptiveJournalObjectStore.ts";
import { decodeAdaptiveJournalPackIndexFrameV1, type AdaptiveJournalPackIndexEntryV1 } from "./AdaptiveJournalPack.ts";
import type { RemoteFailure } from "./AdaptiveJournalRepository.ts";
import { sha256 } from "./AdaptiveJournalManifest.ts";

export interface AdaptiveJournalCatalogueLoadContextV1 {
    dependencies: readonly AdaptiveJournalCommitDependencyV1[];
    sequence: bigint;
    writerStreamId: Uint8Array;
}

export type AdaptiveJournalCatalogueLoadOutcomeV1 = { status: "ok" } | { failure: RemoteFailure; status: "failed" };

export interface AdaptiveJournalCatalogueLoaderV1 {
    load(context: AdaptiveJournalCatalogueLoadContextV1): Promise<AdaptiveJournalCatalogueLoadOutcomeV1>;
}

type Addition = {
    dependency: AdaptiveJournalCommitDependencyV1;
    entries: readonly AdaptiveJournalPackIndexEntryV1[];
    packId: Uint8Array;
};

const INTEGRITY_FAILURE: RemoteFailure = { category: "invalid-response", retry: "never" };
const MISSING_FAILURE: RemoteFailure = { category: "unavailable", retry: "later" };

async function requiredObject(
    remote: AdaptiveJournalObjectRemoteV1,
    key: string
): Promise<{ bytes: Uint8Array; status: "ok" } | { failure: RemoteFailure; status: "failed" }> {
    const read = await remote.readAdaptiveObject(key);
    if (read.status === "failed") return read;
    if (read.status === "missing") return { failure: MISSING_FAILURE, status: "failed" };
    return { bytes: read.value, status: "ok" };
}

export function createAdaptiveJournalObjectCatalogueLoaderV1(options: {
    catalogue: AdaptiveJournalCatalogueV1;
    keys: AdaptiveJournalKeySetV1;
    remote: AdaptiveJournalObjectRemoteV1;
}): AdaptiveJournalCatalogueLoaderV1 {
    return {
        load: async (context) => {
            const additions: Addition[] = [];
            for (const dependency of context.dependencies) {
                if (options.catalogue.hasDependency(dependency)) continue;
                const deltaFrame = await requiredObject(options.remote, dependency.key);
                if (deltaFrame.status === "failed") return deltaFrame;
                try {
                    if (!bytesEqual(await sha256(deltaFrame.bytes), dependency.digest)) {
                        return { failure: INTEGRITY_FAILURE, status: "failed" };
                    }
                    const route = parseAdaptiveJournalDeltaObjectKeyV1(dependency.key);
                    const delta = await decodeAdaptiveJournalCatalogueDeltaV1({
                        bytes: deltaFrame.bytes,
                        keys: options.keys,
                        sequence: route.sequence,
                        writerStreamId: route.writerStreamId,
                    });
                    const packId = fixedLength(base64UrlToBytes(delta.payload.add.packId), 32, "packId");
                    const indexDigest = fixedLength(base64UrlToBytes(delta.payload.add.indexDigest), 32, "indexDigest");
                    if (delta.payload.add.indexKey !== adaptiveJournalIndexObjectKeyV1(packId)) {
                        return { failure: INTEGRITY_FAILURE, status: "failed" };
                    }
                    const indexFrame = await requiredObject(options.remote, delta.payload.add.indexKey);
                    if (indexFrame.status === "failed") return indexFrame;
                    if (!bytesEqual(await sha256(indexFrame.bytes), indexDigest)) {
                        return { failure: INTEGRITY_FAILURE, status: "failed" };
                    }
                    const index = await decodeAdaptiveJournalPackIndexFrameV1({
                        expectedPackId: packId,
                        indexFrame: indexFrame.bytes,
                        keys: options.keys,
                        packBytes: delta.payload.add.packBytes,
                    });
                    additions.push({
                        dependency: { digest: dependency.digest.slice(), key: dependency.key },
                        entries: index.entries,
                        packId,
                    });
                } catch {
                    return { failure: INTEGRITY_FAILURE, status: "failed" };
                }
            }
            for (const addition of additions) {
                options.catalogue.applyCommittedPack(addition.packId, addition.entries, addition.dependency);
            }
            return { status: "ok" };
        },
    };
}

export const ADAPTIVE_JOURNAL_NOOP_CATALOGUE_LOADER_V1: AdaptiveJournalCatalogueLoaderV1 = {
    load: async () => ({ status: "ok" }),
};
