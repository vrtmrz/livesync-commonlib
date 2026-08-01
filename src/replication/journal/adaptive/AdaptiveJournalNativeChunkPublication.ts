import type { DocumentID } from "@lib/common/types.ts";

import { bytesEqual, bytesToBase64Url } from "./AdaptiveJournalBinary.ts";
import type { AdaptiveJournalChunkStoreV1, StoredChunkRecordV1 } from "./AdaptiveJournalChunkStore.ts";
import type { AdaptiveJournalKeySetV1 } from "./AdaptiveJournalManifest.ts";
import {
    decodeAdaptiveJournalChunkRecordV1,
    type EncodedAdaptiveJournalChunkRecordV1,
} from "./AdaptiveJournalPayload.ts";
import type { RemoteFailure } from "./AdaptiveJournalRepository.ts";

export interface AdaptiveJournalChunkPublicationItemV1 {
    localChunkId: DocumentID;
    record: EncodedAdaptiveJournalChunkRecordV1;
}

export type AdaptiveJournalNativeChunkPublicationItemV1 = AdaptiveJournalChunkPublicationItemV1;

export type AdaptiveJournalNativeChunkPublicationOutcomeV1 =
    | { status: "accepted" }
    | { key: Uint8Array; status: "collision" }
    | { failure: RemoteFailure; status: "pending" };

interface PreparedChunkV1 {
    data: string;
    localChunkId: DocumentID;
    stored: StoredChunkRecordV1;
}

const INVALID_RESPONSE: RemoteFailure = { category: "invalid-response", retry: "later" };

async function prepareChunks(
    keys: AdaptiveJournalKeySetV1,
    items: readonly AdaptiveJournalChunkPublicationItemV1[]
): Promise<readonly PreparedChunkV1[]> {
    const seen = new Set<string>();
    const prepared: PreparedChunkV1[] = [];
    for (const { localChunkId, record } of items) {
        const decoded = await decodeAdaptiveJournalChunkRecordV1({
            bytes: record.bytes,
            keys,
            localChunkId,
        });
        if (
            !bytesEqual(decoded.remoteChunkKey, record.remoteChunkKey) ||
            !bytesEqual(decoded.frameDigest, record.digest)
        ) {
            throw new TypeError("Adaptive Journal Chunk frame does not match its publication metadata");
        }
        const keyText = bytesToBase64Url(record.remoteChunkKey);
        if (seen.has(keyText)) throw new TypeError("Adaptive Journal Chunk publication contains a duplicate key");
        seen.add(keyText);
        prepared.push({
            data: decoded.data,
            localChunkId,
            stored: {
                frame: record.bytes,
                frameDigest: record.digest,
                key: record.remoteChunkKey,
            },
        });
    }
    return prepared;
}

async function validateExistingChunks(
    store: AdaptiveJournalChunkStoreV1,
    keys: AdaptiveJournalKeySetV1,
    chunks: readonly PreparedChunkV1[],
    precedingFailure?: RemoteFailure
): Promise<AdaptiveJournalNativeChunkPublicationOutcomeV1> {
    if (chunks.length === 0) return { status: "accepted" };
    const read = await store.getMany(chunks.map(({ stored }) => stored.key));
    if (read.status === "failed") return { status: "pending", failure: read.failure };
    if (read.chunks.length !== chunks.length) return { status: "pending", failure: INVALID_RESPONSE };
    for (let index = 0; index < chunks.length; index++) {
        const intended = chunks[index];
        const existing = read.chunks[index];
        if (!existing) {
            return { status: "pending", failure: precedingFailure ?? INVALID_RESPONSE };
        }
        try {
            const decoded = await decodeAdaptiveJournalChunkRecordV1({
                bytes: existing.frame,
                keys,
                localChunkId: intended.localChunkId,
            });
            if (
                !bytesEqual(existing.key, intended.stored.key) ||
                !bytesEqual(existing.frameDigest, decoded.frameDigest) ||
                !bytesEqual(decoded.remoteChunkKey, intended.stored.key) ||
                decoded.data !== intended.data
            ) {
                return { status: "collision", key: intended.stored.key.slice() };
            }
        } catch {
            return { status: "collision", key: intended.stored.key.slice() };
        }
    }
    return { status: "accepted" };
}

export async function publishAdaptiveJournalNativeChunksV1(
    store: AdaptiveJournalChunkStoreV1,
    keys: AdaptiveJournalKeySetV1,
    items: readonly AdaptiveJournalChunkPublicationItemV1[]
): Promise<AdaptiveJournalNativeChunkPublicationOutcomeV1> {
    const chunks = await prepareChunks(keys, items);
    if (chunks.length === 0) return { status: "accepted" };
    let publicationChunks = chunks;
    if (store.capabilities.nativeMultiKeyLookup) {
        const availability = await store.hasMany(chunks.map(({ stored }) => stored.key));
        if (availability.status === "failed") return { status: "pending", failure: availability.failure };
        if (
            availability.availability.length !== chunks.length ||
            !availability.availability.every((present) => typeof present === "boolean")
        ) {
            return { status: "pending", failure: INVALID_RESPONSE };
        }
        publicationChunks = chunks.filter((_, index) => !availability.availability[index]);
        if (publicationChunks.length === 0) return { status: "accepted" };
    }
    const publication = await store.putMany(publicationChunks.map(({ stored }) => stored));
    if (publication.status === "failed") {
        if (publication.failure.retry !== "verify-first") {
            return { status: "pending", failure: publication.failure };
        }
        return await validateExistingChunks(store, keys, publicationChunks, publication.failure);
    }
    if (publication.results.length !== publicationChunks.length) {
        return { status: "pending", failure: INVALID_RESPONSE };
    }
    const validation: PreparedChunkV1[] = [];
    for (let index = 0; index < publication.results.length; index++) {
        if (publication.results[index] === "validate-existing") validation.push(publicationChunks[index]);
    }
    return await validateExistingChunks(store, keys, validation);
}
