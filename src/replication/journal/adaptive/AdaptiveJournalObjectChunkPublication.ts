import { bytesToBase64Url } from "./AdaptiveJournalBinary.ts";
import { adaptiveJournalCommitObjectKeyV1, type AdaptiveJournalCatalogueV1 } from "./AdaptiveJournalCatalogue.ts";
import { DEFAULT_ADAPTIVE_COMMIT_LIMITS_V1 } from "./AdaptiveJournalCommit.ts";
import {
    MAX_ADAPTIVE_JOURNAL_COMMIT_PACK_ENTRIES_V1,
    MAX_ADAPTIVE_JOURNAL_COMMIT_PACKS_V1,
    type AdaptiveJournalCommitPackV1,
} from "./AdaptiveJournalControl.ts";
import { AdaptiveJournalError, type AdaptiveJournalKeySetV1 } from "./AdaptiveJournalManifest.ts";
import type { AdaptiveJournalChunkPublicationItemV1 } from "./AdaptiveJournalNativeChunkPublication.ts";
import type { AdaptiveJournalObjectPublicationCacheV1 } from "./AdaptiveJournalObjectPublicationCache.ts";
import {
    publishAdaptiveJournalPackV1,
    type AdaptiveJournalPackPublicationResultV1,
} from "./AdaptiveJournalObjectRepository.ts";
import type { AdaptiveJournalObjectRemoteV1 } from "./AdaptiveJournalObjectStore.ts";
import {
    buildAdaptiveJournalPackV1,
    DEFAULT_ADAPTIVE_JOURNAL_PACK_LIMITS_V1,
    type BuiltAdaptiveJournalPackV1,
} from "./AdaptiveJournalPack.ts";

export type AdaptiveJournalCommittedPackCandidateV1 = AdaptiveJournalCommitPackV1;

export type AdaptiveJournalObjectChunkPublicationOutcomeV1 =
    | {
          chunkPacks: readonly AdaptiveJournalCommitPackV1[];
          committedPackCandidates: readonly AdaptiveJournalCommittedPackCandidateV1[];
          inlinePack?: Uint8Array;
          requiredChunkKeys: readonly Uint8Array[];
          status: "ok";
      }
    | Exclude<AdaptiveJournalPackPublicationResultV1, { status: "ok" }>;

export interface PublishAdaptiveJournalObjectChunksV1Options {
    catalogue: AdaptiveJournalCatalogueV1;
    inlinePackMaxBytes?: number;
    items: readonly AdaptiveJournalChunkPublicationItemV1[];
    keys: AdaptiveJournalKeySetV1;
    packMaxBytes?: number;
    publicationCache?: AdaptiveJournalObjectPublicationCacheV1;
    remote: AdaptiveJournalObjectRemoteV1;
    sequence: bigint;
    writerStreamId: Uint8Array;
}

function packByteLimit(value: number | undefined): number {
    const limit = value ?? DEFAULT_ADAPTIVE_JOURNAL_PACK_LIMITS_V1.maxPackBytes;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > DEFAULT_ADAPTIVE_JOURNAL_PACK_LIMITS_V1.maxPackBytes) {
        throw new RangeError(
            `Adaptive Journal Pack limit must be between 1 and ${DEFAULT_ADAPTIVE_JOURNAL_PACK_LIMITS_V1.maxPackBytes}`
        );
    }
    return limit;
}

function partitionPackItems(
    items: readonly AdaptiveJournalChunkPublicationItemV1[],
    maxPackBytes: number
): readonly AdaptiveJournalChunkPublicationItemV1[][] {
    const sorted = [...items].sort((left, right) => {
        const leftKey = bytesToBase64Url(left.record.remoteChunkKey);
        const rightKey = bytesToBase64Url(right.record.remoteChunkKey);
        return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
    });
    const groups: AdaptiveJournalChunkPublicationItemV1[][] = [];
    let current: AdaptiveJournalChunkPublicationItemV1[] = [];
    let currentBytes = 0;
    for (const item of sorted) {
        const frameBytes = item.record.bytes.byteLength;
        if (frameBytes > maxPackBytes) {
            throw new AdaptiveJournalError("pack-limit-exceeded", "One Chunk frame exceeds the Pack byte limit");
        }
        if (current.length > 0 && currentBytes + frameBytes > maxPackBytes) {
            groups.push(current);
            current = [];
            currentBytes = 0;
        }
        current.push(item);
        currentBytes += frameBytes;
    }
    if (current.length > 0) groups.push(current);
    return groups;
}

function inlinePackLimit(value: number | undefined): number {
    const limit = value ?? DEFAULT_ADAPTIVE_COMMIT_LIMITS_V1.maxInlinePackBytes;
    if (!Number.isSafeInteger(limit) || limit < 0 || limit > DEFAULT_ADAPTIVE_COMMIT_LIMITS_V1.maxInlinePackBytes) {
        throw new RangeError(
            `Adaptive Journal inline Pack limit must be between 0 and ${DEFAULT_ADAPTIVE_COMMIT_LIMITS_V1.maxInlinePackBytes}`
        );
    }
    return limit;
}

export async function publishAdaptiveJournalObjectChunksV1(
    options: PublishAdaptiveJournalObjectChunksV1Options
): Promise<AdaptiveJournalObjectChunkPublicationOutcomeV1> {
    const maxInlinePackBytes = inlinePackLimit(options.inlinePackMaxBytes);
    const maxPackBytes = packByteLimit(options.packMaxBytes);
    const byKey = new Map<string, AdaptiveJournalChunkPublicationItemV1>();
    for (const item of options.items) {
        const key = bytesToBase64Url(item.record.remoteChunkKey);
        if (byKey.has(key)) throw new TypeError("Adaptive Journal Chunk publication contains a duplicate key");
        byKey.set(key, item);
    }
    if (byKey.size > MAX_ADAPTIVE_JOURNAL_COMMIT_PACK_ENTRIES_V1) {
        throw new AdaptiveJournalError("commit-limit-exceeded", "Commit required Chunk count exceeds the v1 limit");
    }
    const requiredChunkKeys = [...byKey.values()].map(({ record }) => record.remoteChunkKey.slice());
    const reusedKeys: Uint8Array[] = [];
    let missing: AdaptiveJournalChunkPublicationItemV1[] = [];
    for (const item of byKey.values()) {
        if (options.catalogue.locations(item.record.remoteChunkKey).length > 0) {
            reusedKeys.push(item.record.remoteChunkKey);
        } else {
            missing.push(item);
        }
    }
    let chunkPacks = options.catalogue.routes(reusedKeys) ?? [];
    let groups = partitionPackItems(missing, maxPackBytes);
    if (chunkPacks.length + groups.length > MAX_ADAPTIVE_JOURNAL_COMMIT_PACKS_V1) {
        chunkPacks = [];
        missing = [...byKey.values()];
        groups = partitionPackItems(missing, maxPackBytes);
    }
    if (groups.length > MAX_ADAPTIVE_JOURNAL_COMMIT_PACKS_V1) {
        throw new AdaptiveJournalError("commit-limit-exceeded", "Commit Chunk Pack count exceeds the v1 limit");
    }
    if (missing.length === 0) {
        return {
            chunkPacks,
            committedPackCandidates: [],
            requiredChunkKeys,
            status: "ok",
        };
    }

    const packs: BuiltAdaptiveJournalPackV1[] = [];
    for (const group of groups) {
        packs.push(
            await buildAdaptiveJournalPackV1({
                chunks: group.map(({ record }) => ({ frame: record.bytes, key: record.remoteChunkKey })),
                keys: options.keys,
                limits: { maxPackBytes },
            })
        );
    }
    const inline = packs.length === 1 && packs[0].packBytes.byteLength <= maxInlinePackBytes;
    if (inline) {
        const pack = packs[0];
        const route: AdaptiveJournalCommitPackV1 = {
            container: "bundle",
            entries: pack.entries,
            objectKey: adaptiveJournalCommitObjectKeyV1(options.writerStreamId, options.sequence),
            packBytes: pack.packBytes.byteLength,
            packId: pack.packId,
        };
        return {
            chunkPacks: [...chunkPacks, route],
            committedPackCandidates: [route],
            inlinePack: pack.packBytes,
            requiredChunkKeys,
            status: "ok",
        };
    }

    const routes: AdaptiveJournalCommitPackV1[] = [];
    for (const pack of packs) {
        const published = await publishAdaptiveJournalPackV1({
            pack,
            publicationCache: options.publicationCache,
            remote: options.remote,
        });
        if (published.status !== "ok") return published;
        routes.push({
            container: "pack",
            entries: published.entries,
            objectKey: published.packKey,
            packBytes: pack.packBytes.byteLength,
            packId: pack.packId,
        });
    }
    return {
        chunkPacks: [...chunkPacks, ...routes],
        committedPackCandidates: routes,
        requiredChunkKeys,
        status: "ok",
    };
}
