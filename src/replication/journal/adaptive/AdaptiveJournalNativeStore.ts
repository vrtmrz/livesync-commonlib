import { adaptiveJournalCommitObjectKeyV1 } from "./AdaptiveJournalCatalogue.ts";
import { bytesEqual, bytesToHex, fixedLength } from "./AdaptiveJournalBinary.ts";
import {
    AdaptiveJournalCommitBundleCacheV1,
    decodeCommitEnvelopeV1,
    type DecodedCommitEnvelopeV1,
} from "./AdaptiveJournalCommit.ts";
import { verifyAdaptiveJournalCommitEnvelopeV1 } from "./AdaptiveJournalCommitValidation.ts";
import type { AdaptiveJournalChunkStoreV1 } from "./AdaptiveJournalChunkStore.ts";
import type {
    AdaptiveJournalCommitSequenceListResultV1,
    AdaptiveJournalDiscoveryStoreV1,
    AdaptiveJournalWriterListResultV1,
} from "./AdaptiveJournalDiscoveryStore.ts";
import type { AdaptiveImmutableRecordResultV1, AdaptiveWriterDescriptorRecordV1 } from "./AdaptiveJournalEventStore.ts";
import { sha256, type AdaptiveJournalKeySetV1 } from "./AdaptiveJournalManifest.ts";
import { decodeAdaptiveJournalMetadataRecordV1 } from "./AdaptiveJournalPayload.ts";
import type { RemoteFailure, RemoteRead } from "./AdaptiveJournalRepository.ts";
import { decodeAdaptiveJournalWriterDescriptorV1 } from "./AdaptiveJournalWriterDescriptor.ts";

export interface AdaptiveJournalNativeEventRemoteV1 {
    commitMetadataBatch(envelope: Uint8Array): Promise<AdaptiveImmutableRecordResultV1>;
    listCommitSequences(
        writerStreamId: Uint8Array,
        afterSequence: bigint
    ): Promise<AdaptiveJournalCommitSequenceListResultV1>;
    listWriterStreamIds(): Promise<AdaptiveJournalWriterListResultV1>;
    readCommitBundle(writerStreamId: Uint8Array, sequence: bigint): Promise<RemoteRead<Uint8Array>>;
    readWriter(writerStreamId: Uint8Array): Promise<RemoteRead<Uint8Array>>;
    registerWriter(record: AdaptiveWriterDescriptorRecordV1): Promise<AdaptiveImmutableRecordResultV1>;
}

export interface AdaptiveJournalNativeStoresV1 {
    readonly chunks: AdaptiveJournalChunkStoreV1;
    readonly events: AdaptiveJournalNativeEventRemoteV1;
}

/** Optional storage capability used by providers with native immutable rows and batched Chunk operations. */
export interface AdaptiveJournalNativeStorageV1 {
    readonly adaptiveJournalStorageStrategy: "native";
    createAdaptiveJournalNativeStores(repositoryId: Uint8Array): AdaptiveJournalNativeStoresV1;
}

export function isAdaptiveJournalNativeStorageV1(storage: unknown): storage is AdaptiveJournalNativeStorageV1 {
    const candidate = storage as Partial<AdaptiveJournalNativeStorageV1> | undefined;
    return (
        candidate?.adaptiveJournalStorageStrategy === "native" &&
        typeof candidate.createAdaptiveJournalNativeStores === "function"
    );
}

const INVALID_REMOTE: RemoteFailure = { category: "invalid-response", retry: "never" };

function failed(): { failure: RemoteFailure; status: "failed" } {
    return { failure: INVALID_REMOTE, status: "failed" };
}

function validWriterList(result: AdaptiveJournalWriterListResultV1): AdaptiveJournalWriterListResultV1 {
    if (result.status === "failed") return result;
    try {
        const seen = new Set<string>();
        const writerStreamIds = result.writerStreamIds.map((value) => {
            const id = fixedLength(value, 32, "writerStreamId");
            const key = bytesToHex(id);
            if (seen.has(key)) throw new Error("Duplicate Writer stream ID");
            seen.add(key);
            return id.slice();
        });
        return { status: "ok", writerStreamIds };
    } catch {
        return failed();
    }
}

function validSequenceList(
    result: AdaptiveJournalCommitSequenceListResultV1,
    afterSequence: bigint
): AdaptiveJournalCommitSequenceListResultV1 {
    if (result.status === "failed") return result;
    let previous = afterSequence;
    for (const sequence of result.sequences) {
        if (sequence <= previous || sequence > 0x7fffffffffffffffn) return failed();
        previous = sequence;
    }
    return { sequences: [...result.sequences], status: "ok" };
}

/** Adds client-side cryptographic validation around a native transactional remote. */
export function createAdaptiveJournalNativeEventStoreV1(options: {
    bundleCache?: AdaptiveJournalCommitBundleCacheV1;
    keys: AdaptiveJournalKeySetV1;
    remote: AdaptiveJournalNativeEventRemoteV1;
}): AdaptiveJournalDiscoveryStoreV1 {
    const bundleCache = options.bundleCache ?? new AdaptiveJournalCommitBundleCacheV1();
    const bundleReads = new Map<string, Promise<RemoteRead<Uint8Array>>>();
    const writerReads = new Map<string, Promise<RemoteRead<Uint8Array>>>();

    const readBundle = async (
        writerStreamId: Uint8Array,
        sequence: bigint
    ): Promise<RemoteRead<DecodedCommitEnvelopeV1>> => {
        let id: Uint8Array;
        let key: string;
        try {
            id = fixedLength(writerStreamId, 32, "writerStreamId");
            key = adaptiveJournalCommitObjectKeyV1(id, sequence);
        } catch {
            return failed();
        }
        const cached = bundleCache.get(key);
        if (cached) return { status: "found", value: cached.envelope };
        let pending = bundleReads.get(key);
        if (!pending) {
            pending = options.remote.readCommitBundle(id, sequence);
            bundleReads.set(key, pending);
        }
        try {
            const read = await pending;
            if (read.status !== "found") return read;
            const envelope = await decodeCommitEnvelopeV1(read.value);
            if (
                !bytesEqual(envelope.repositoryId, options.keys.repositoryId) ||
                !bytesEqual(envelope.writerStreamId, id) ||
                envelope.sequence !== sequence
            ) {
                return failed();
            }
            const verified = await verifyAdaptiveJournalCommitEnvelopeV1({
                envelope,
                keys: options.keys,
                routePolicy: "native",
            });
            if (verified.status === "failed") return verified;
            bundleCache.set(key, read.value, envelope);
            return { status: "found", value: envelope };
        } catch {
            return failed();
        } finally {
            if (bundleReads.get(key) === pending) bundleReads.delete(key);
        }
    };

    return {
        commitMetadataBatch: async (bytes) => {
            let envelope: DecodedCommitEnvelopeV1;
            try {
                envelope = await decodeCommitEnvelopeV1(bytes);
            } catch {
                return failed();
            }
            if (!bytesEqual(envelope.repositoryId, options.keys.repositoryId)) return failed();
            const verified = await verifyAdaptiveJournalCommitEnvelopeV1({
                envelope,
                keys: options.keys,
                routePolicy: "native",
            });
            if (verified.status === "failed") return verified;
            const result = await options.remote.commitMetadataBatch(bytes);
            if (result.status === "failed") return result;
            const key = adaptiveJournalCommitObjectKeyV1(envelope.writerStreamId, envelope.sequence);
            if (result.result === "validate-existing") bundleCache.delete(key);
            else bundleCache.set(key, bytes, envelope);
            return { ...result, commitDigest: envelope.commitFrameDigest.slice() };
        },
        listCommitSequences: async (writerStreamId, afterSequence) => {
            if (afterSequence < 0n || afterSequence > 0x7fffffffffffffffn) return failed();
            try {
                const id = fixedLength(writerStreamId, 32, "writerStreamId");
                return validSequenceList(await options.remote.listCommitSequences(id, afterSequence), afterSequence);
            } catch {
                return failed();
            }
        },
        listWriterStreamIds: async () => validWriterList(await options.remote.listWriterStreamIds()),
        putMetadataBatch: async (record) => {
            try {
                if (!bytesEqual(await sha256(record.metadataFrame), record.metadataDigest)) return failed();
                await decodeAdaptiveJournalMetadataRecordV1({
                    bytes: record.metadataFrame,
                    keys: options.keys,
                    sequence: record.sequence,
                    writerStreamId: record.writerStreamId,
                });
                return { result: "inserted", status: "ok" };
            } catch {
                return failed();
            }
        },
        readCommit: async (writerStreamId, sequence) => {
            const read = await readBundle(writerStreamId, sequence);
            return read.status === "found" ? { status: "found", value: read.value.commitFrame.slice() } : read;
        },
        readMetadata: async (writerStreamId, sequence) => {
            const read = await readBundle(writerStreamId, sequence);
            return read.status === "found" ? { status: "found", value: read.value.metadataFrame.slice() } : read;
        },
        readWriter: async (writerStreamId) => {
            let key: string | undefined;
            try {
                const id = fixedLength(writerStreamId, 32, "writerStreamId");
                key = bytesToHex(id);
                let pending = writerReads.get(key);
                if (!pending) {
                    pending = options.remote.readWriter(id);
                    writerReads.set(key, pending);
                }
                const result = await pending;
                if (result.status !== "found") {
                    if (writerReads.get(key) === pending) writerReads.delete(key);
                    return result;
                }
                return { status: "found", value: result.value.slice() };
            } catch {
                if (key !== undefined) writerReads.delete(key);
                return failed();
            }
        },
        registerWriter: async (record) => {
            try {
                if (!bytesEqual(await sha256(record.descriptorFrame), record.descriptorDigest)) return failed();
                await decodeAdaptiveJournalWriterDescriptorV1({
                    bytes: record.descriptorFrame,
                    keys: options.keys,
                    writerStreamId: record.writerStreamId,
                });
                const result = await options.remote.registerWriter(record);
                const key = bytesToHex(fixedLength(record.writerStreamId, 32, "writerStreamId"));
                if (result.status === "ok" && result.result !== "validate-existing") {
                    writerReads.set(key, Promise.resolve({ status: "found", value: record.descriptorFrame.slice() }));
                } else if (result.status === "ok") {
                    writerReads.delete(key);
                }
                return result;
            } catch {
                return failed();
            }
        },
    };
}
