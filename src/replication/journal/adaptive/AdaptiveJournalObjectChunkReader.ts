import {
    AdaptiveJournalCatalogueV1,
    adaptiveJournalPackObjectKeyV1,
    type AdaptiveJournalPackLocationV1,
} from "./AdaptiveJournalCatalogue.ts";
import type { AdaptiveJournalChunkReaderV1, StoredChunkRecordV1 } from "./AdaptiveJournalChunkStore.ts";
import { bytesEqual, bytesToBase64Url } from "./AdaptiveJournalBinary.ts";
import { sha256 } from "./AdaptiveJournalManifest.ts";
import type { AdaptiveJournalObjectRemoteV1 } from "./AdaptiveJournalObjectStore.ts";
import { frameFromAdaptiveJournalPackV1 } from "./AdaptiveJournalPack.ts";
import type { RemoteFailure } from "./AdaptiveJournalRepository.ts";

export type AdaptiveJournalObjectRetrievalV1 = "range" | "whole-pack";

export interface AdaptiveJournalPackCacheV1 {
    get(packId: string): Promise<Uint8Array | undefined>;
    set(packId: string, bytes: Uint8Array): Promise<void>;
}

export interface CreateAdaptiveJournalObjectChunkReaderV1Options {
    cache?: AdaptiveJournalPackCacheV1;
    catalogue: AdaptiveJournalCatalogueV1;
    remote: AdaptiveJournalObjectRemoteV1;
    retrieval: AdaptiveJournalObjectRetrievalV1;
}

const INTEGRITY_FAILURE: RemoteFailure = { category: "invalid-response", retry: "never" };
const MISSING_DEPENDENCY: RemoteFailure = { category: "unavailable", retry: "later" };

type RequestedLocation = {
    key: Uint8Array;
    location: AdaptiveJournalPackLocationV1;
    requestIndex: number;
};

async function verifiedCompletePack(
    options: CreateAdaptiveJournalObjectChunkReaderV1Options,
    location: AdaptiveJournalPackLocationV1
): Promise<{ bytes: Uint8Array; status: "ok" } | { failure: RemoteFailure; status: "failed" }> {
    const packIdText = bytesToBase64Url(location.packId);
    const cached = await options.cache?.get(packIdText);
    let bytes: Uint8Array;
    if (cached) {
        bytes = cached;
    } else {
        const read = await options.remote.readAdaptiveObject(adaptiveJournalPackObjectKeyV1(location.packId));
        if (read.status === "failed") return read;
        if (read.status === "missing") return { status: "failed", failure: MISSING_DEPENDENCY };
        bytes = read.value;
    }
    if (!bytesEqual(await sha256(bytes), location.packId)) {
        return { status: "failed", failure: INTEGRITY_FAILURE };
    }
    if (!cached) await options.cache?.set(packIdText, bytes);
    return { status: "ok", bytes };
}

async function readWholePacks(
    options: CreateAdaptiveJournalObjectChunkReaderV1Options,
    requested: readonly RequestedLocation[],
    chunks: Array<StoredChunkRecordV1 | undefined>
): Promise<RemoteFailure | undefined> {
    const groups = new Map<string, RequestedLocation[]>();
    for (const request of requested) {
        const id = bytesToBase64Url(request.location.packId);
        const group = groups.get(id) ?? [];
        group.push(request);
        groups.set(id, group);
    }
    for (const group of groups.values()) {
        const pack = await verifiedCompletePack(options, group[0].location);
        if (pack.status === "failed") return pack.failure;
        for (const request of group) {
            let frame: Uint8Array;
            try {
                frame = frameFromAdaptiveJournalPackV1(pack.bytes, request.location);
            } catch {
                return INTEGRITY_FAILURE;
            }
            if (!bytesEqual(await sha256(frame), request.location.frameDigest)) return INTEGRITY_FAILURE;
            chunks[request.requestIndex] = {
                frame,
                frameDigest: request.location.frameDigest.slice(),
                key: request.key.slice(),
            };
        }
    }
    return undefined;
}

async function readRanges(
    options: CreateAdaptiveJournalObjectChunkReaderV1Options,
    requested: readonly RequestedLocation[],
    chunks: Array<StoredChunkRecordV1 | undefined>
): Promise<RemoteFailure | undefined> {
    for (const request of requested) {
        const read = await options.remote.readAdaptiveObject(adaptiveJournalPackObjectKeyV1(request.location.packId), {
            length: request.location.frameLength,
            offset: request.location.offset,
        });
        if (read.status === "failed") return read.failure;
        if (read.status === "missing") return MISSING_DEPENDENCY;
        if (
            read.value.byteLength !== request.location.frameLength ||
            !bytesEqual(await sha256(read.value), request.location.frameDigest)
        ) {
            return INTEGRITY_FAILURE;
        }
        chunks[request.requestIndex] = {
            frame: read.value,
            frameDigest: request.location.frameDigest.slice(),
            key: request.key.slice(),
        };
    }
    return undefined;
}

export function createAdaptiveJournalObjectChunkReaderV1(
    options: CreateAdaptiveJournalObjectChunkReaderV1Options
): AdaptiveJournalChunkReaderV1 {
    return {
        capabilities: {
            atomicBatchWrite: false,
            nativeMultiKeyLookup: false,
            serverSideImmutableCreate: true,
        },
        hasMany: async (keys) => ({
            status: "ok",
            availability: keys.map((key) => options.catalogue.locations(key).length > 0),
        }),
        getMany: async (keys) => {
            const chunks: Array<StoredChunkRecordV1 | undefined> = new Array(keys.length).fill(undefined);
            const requested: RequestedLocation[] = [];
            keys.forEach((key, requestIndex) => {
                const location = options.catalogue.locations(key)[0];
                if (location) requested.push({ key, location, requestIndex });
            });
            const failure =
                options.retrieval === "whole-pack"
                    ? await readWholePacks(options, requested, chunks)
                    : await readRanges(options, requested, chunks);
            return failure ? { status: "failed", failure } : { status: "ok", chunks };
        },
    };
}
