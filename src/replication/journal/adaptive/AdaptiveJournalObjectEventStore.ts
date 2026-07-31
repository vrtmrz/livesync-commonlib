import {
    ADAPTIVE_JOURNAL_WRITER_OBJECT_PREFIX_V1,
    adaptiveJournalCommitObjectKeyV1,
    adaptiveJournalCommitObjectPrefixV1,
    adaptiveJournalWriterObjectKeyV1,
    parseAdaptiveJournalCommitObjectKeyV1,
} from "./AdaptiveJournalCatalogue.ts";
import type { AdaptiveJournalCatalogueV1 } from "./AdaptiveJournalCatalogue.ts";
import { base64UrlToBytes, bytesEqual, bytesToHex, fixedLength } from "./AdaptiveJournalBinary.ts";
import {
    AdaptiveJournalCommitBundleCacheV1,
    decodeCommitEnvelopeV1,
    type DecodedCommitEnvelopeV1,
} from "./AdaptiveJournalCommit.ts";
import {
    decodeAdaptiveJournalCommitPacksV1,
    decodeAdaptiveJournalCommitRecordV1,
    type AdaptiveJournalCommitPackV1,
} from "./AdaptiveJournalControl.ts";
import type { AdaptiveImmutableRecordResultV1, AdaptiveImmutableRecordStatusV1 } from "./AdaptiveJournalEventStore.ts";
import type { AdaptiveJournalDiscoveryStoreV1 } from "./AdaptiveJournalDiscoveryStore.ts";
import { sha256, type AdaptiveJournalKeySetV1 } from "./AdaptiveJournalManifest.ts";
import type { AdaptiveJournalObjectPublicationCacheV1 } from "./AdaptiveJournalObjectPublicationCache.ts";
import type { AdaptiveJournalObjectRemoteV1 } from "./AdaptiveJournalObjectStore.ts";
import { decodeAdaptiveJournalMetadataRecordV1 } from "./AdaptiveJournalPayload.ts";
import type { RemoteFailure, RemoteRead } from "./AdaptiveJournalRepository.ts";

export interface CreateAdaptiveJournalObjectEventStoreV1Options {
    bundleCache?: AdaptiveJournalCommitBundleCacheV1;
    catalogue: AdaptiveJournalCatalogueV1;
    keys: AdaptiveJournalKeySetV1;
    publicationCache?: AdaptiveJournalObjectPublicationCacheV1;
    remote: AdaptiveJournalObjectRemoteV1;
}

type DecodedCommitControl = Awaited<ReturnType<typeof decodeAdaptiveJournalCommitRecordV1>>;

type ControlVerification =
    | { control: DecodedCommitControl; routes: readonly AdaptiveJournalCommitPackV1[]; status: "verified" }
    | { failure: RemoteFailure; status: "failed" };

type BundleRead = { status: "found" | "missing" } | { failure: RemoteFailure; status: "failed" };

const INVALID_REMOTE: RemoteFailure = { category: "invalid-response", retry: "never" };
const MISSING_REMOTE: RemoteFailure = { category: "unavailable", retry: "later" };

function failed(failure: RemoteFailure): { failure: RemoteFailure; status: "failed" } {
    return { status: "failed", failure };
}

async function ensureImmutableRecord(
    remote: AdaptiveJournalObjectRemoteV1,
    key: string,
    intended: Uint8Array,
    mime: string
): Promise<AdaptiveImmutableRecordResultV1> {
    const created = await remote.createAdaptiveObject(key, intended, mime);
    if (created.status === "created") return { status: "ok", result: "inserted" };
    if (created.status === "failed" && created.failure.retry !== "verify-first") return created;
    const read = await remote.readAdaptiveObject(key);
    if (read.status === "failed") return read;
    if (read.status === "missing") {
        return created.status === "failed" ? created : failed({ category: "invalid-response", retry: "later" });
    }
    const result: AdaptiveImmutableRecordStatusV1 = bytesEqual(read.value, intended)
        ? "exact-existing"
        : "validate-existing";
    return { status: "ok", result };
}

function digestFromText(value: string, label: string): Uint8Array {
    return fixedLength(base64UrlToBytes(value), 32, label);
}

function commitControlMatchesEnvelope(
    envelope: DecodedCommitEnvelopeV1,
    payload: DecodedCommitControl["payload"]
): boolean {
    const previous =
        payload.previousCommitDigest === null
            ? null
            : digestFromText(payload.previousCommitDigest, "previousCommitDigest");
    const previousMatches =
        previous === null
            ? envelope.previousCommitDigest === null
            : envelope.previousCommitDigest !== null && bytesEqual(previous, envelope.previousCommitDigest);
    return (
        previousMatches &&
        payload.metadata.bytes === envelope.metadataFrame.byteLength &&
        bytesEqual(digestFromText(payload.metadata.digest, "metadataDigest"), envelope.metadataDigest) &&
        bytesEqual(
            digestFromText(payload.requiredChunkKeysDigest, "requiredChunkKeysDigest"),
            envelope.requiredChunkKeysDigest
        )
    );
}

function routesCoverRequiredChunks(
    envelope: DecodedCommitEnvelopeV1,
    routes: readonly AdaptiveJournalCommitPackV1[]
): boolean {
    const routed = new Set(routes.flatMap(({ entries }) => entries.map(({ key }) => bytesToHex(key))));
    return (
        routed.size === envelope.requiredChunkKeys.length &&
        envelope.requiredChunkKeys.every((key) => routed.has(bytesToHex(key)))
    );
}

async function verifyCommitControl(
    options: CreateAdaptiveJournalObjectEventStoreV1Options,
    envelope: DecodedCommitEnvelopeV1
): Promise<ControlVerification> {
    try {
        const control = await decodeAdaptiveJournalCommitRecordV1({
            bytes: envelope.commitFrame,
            keys: options.keys,
            sequence: envelope.sequence,
            writerStreamId: envelope.writerStreamId,
        });
        const routes = decodeAdaptiveJournalCommitPacksV1(control.payload);
        if (
            !bytesEqual(control.digest, envelope.commitFrameDigest) ||
            !commitControlMatchesEnvelope(envelope, control.payload) ||
            !routesCoverRequiredChunks(envelope, routes)
        ) {
            return failed(INVALID_REMOTE);
        }
        await decodeAdaptiveJournalMetadataRecordV1({
            bytes: envelope.metadataFrame,
            keys: options.keys,
            sequence: envelope.sequence,
            writerStreamId: envelope.writerStreamId,
        });
        return { status: "verified", control, routes };
    } catch {
        return failed(INVALID_REMOTE);
    }
}

function routeIsInCatalogue(catalogue: AdaptiveJournalCatalogueV1, route: AdaptiveJournalCommitPackV1): boolean {
    return route.entries.every((entry) =>
        catalogue
            .locations(entry.key)
            .some(
                (location) =>
                    location.objectKey === route.objectKey &&
                    location.container === route.container &&
                    location.packBytes === route.packBytes &&
                    bytesEqual(location.packId, route.packId) &&
                    location.offset === entry.offset &&
                    location.frameLength === entry.frameLength &&
                    bytesEqual(location.frameDigest, entry.frameDigest)
            )
    );
}

function bundlePackMatches(envelope: DecodedCommitEnvelopeV1, route: AdaptiveJournalCommitPackV1): boolean {
    return (
        envelope.inlinePack !== undefined &&
        envelope.inlinePackDigest !== undefined &&
        envelope.inlinePack.byteLength === route.packBytes &&
        bytesEqual(envelope.inlinePackDigest, route.packId)
    );
}

function currentBundleRouteMatches(
    envelope: DecodedCommitEnvelopeV1,
    routes: readonly AdaptiveJournalCommitPackV1[]
): boolean {
    const currentKey = adaptiveJournalCommitObjectKeyV1(envelope.writerStreamId, envelope.sequence);
    const currentBundleRoutes = routes.filter(
        ({ container, objectKey }) => container === "bundle" && objectKey === currentKey
    );
    return (
        (envelope.inlinePack === undefined) === (currentBundleRoutes.length === 0) &&
        currentBundleRoutes.length <= 1 &&
        (currentBundleRoutes.length === 0 || bundlePackMatches(envelope, currentBundleRoutes[0]))
    );
}

function remoteReadFailure(read: RemoteRead<Uint8Array>): { failure: RemoteFailure; status: "failed" } | undefined {
    if (read.status === "failed") return read;
    if (read.status === "missing") return failed(MISSING_REMOTE);
    return undefined;
}

export function createAdaptiveJournalObjectEventStoreV1(
    options: CreateAdaptiveJournalObjectEventStoreV1Options
): AdaptiveJournalDiscoveryStoreV1 {
    options.publicationCache?.requireRemote(options.remote);
    const bundleCache = options.bundleCache ?? new AdaptiveJournalCommitBundleCacheV1();
    const bundleReads = new Map<string, Promise<RemoteRead<Uint8Array>>>();
    const writerReads = new Map<string, Promise<RemoteRead<Uint8Array>>>();

    const readBundle = async (writerStreamId: Uint8Array, sequence: bigint): Promise<BundleRead> => {
        const key = adaptiveJournalCommitObjectKeyV1(writerStreamId, sequence);
        let pending = bundleReads.get(key);
        if (!pending) {
            pending = options.remote.readAdaptiveObject(key);
            bundleReads.set(key, pending);
        }
        try {
            const read = await pending;
            if (read.status !== "found") {
                if (bundleReads.get(key) === pending) bundleReads.delete(key);
                return read;
            }
            const envelope = await decodeCommitEnvelopeV1(read.value);
            if (
                !bytesEqual(envelope.repositoryId, options.keys.repositoryId) ||
                !bytesEqual(envelope.writerStreamId, writerStreamId) ||
                envelope.sequence !== sequence
            ) {
                if (bundleReads.get(key) === pending) bundleReads.delete(key);
                return failed(INVALID_REMOTE);
            }
            bundleCache.set(key, read.value, envelope);
            if (bundleReads.get(key) === pending) bundleReads.delete(key);
            return { status: "found" };
        } catch {
            if (bundleReads.get(key) === pending) bundleReads.delete(key);
            return failed(INVALID_REMOTE);
        }
    };

    const decodedBundle = async (
        writerStreamId: Uint8Array,
        sequence: bigint
    ): Promise<
        { envelope: DecodedCommitEnvelopeV1; status: "found" } | { failure: RemoteFailure; status: "failed" }
    > => {
        const key = adaptiveJournalCommitObjectKeyV1(writerStreamId, sequence);
        let cached = bundleCache.get(key);
        if (!cached) {
            const read = await readBundle(writerStreamId, sequence);
            if (read.status === "failed") return read;
            if (read.status === "missing") return failed(MISSING_REMOTE);
            cached = bundleCache.get(key);
        }
        return cached ? { envelope: cached.envelope, status: "found" } : failed(INVALID_REMOTE);
    };

    const verifyRouteObject = async (
        currentKey: string,
        currentEnvelope: DecodedCommitEnvelopeV1,
        route: AdaptiveJournalCommitPackV1
    ): Promise<{ status: "verified" } | { failure: RemoteFailure; status: "failed" }> => {
        if (route.container === "bundle") {
            if (route.objectKey === currentKey) {
                return bundlePackMatches(currentEnvelope, route) ? { status: "verified" } : failed(INVALID_REMOTE);
            }
            const cached = bundleCache.get(route.objectKey);
            let envelope = cached?.envelope;
            if (!envelope) {
                let routeIdentity;
                try {
                    routeIdentity = parseAdaptiveJournalCommitObjectKeyV1(route.objectKey);
                } catch {
                    return failed(INVALID_REMOTE);
                }
                const read = await decodedBundle(routeIdentity.writerStreamId, routeIdentity.sequence);
                if (read.status === "failed") return read;
                envelope = read.envelope;
            }
            return bundlePackMatches(envelope, route) ? { status: "verified" } : failed(INVALID_REMOTE);
        }
        const read = await options.remote.readAdaptiveObject(route.objectKey);
        const failure = remoteReadFailure(read);
        if (failure) return failure;
        if (
            read.status !== "found" ||
            read.value.byteLength !== route.packBytes ||
            !bytesEqual(await sha256(read.value), route.packId)
        ) {
            return failed(INVALID_REMOTE);
        }
        return { status: "verified" };
    };

    const verifyRouteObjects = async (
        envelope: DecodedCommitEnvelopeV1,
        routes: readonly AdaptiveJournalCommitPackV1[]
    ): Promise<{ status: "verified" } | { failure: RemoteFailure; status: "failed" }> => {
        const currentKey = adaptiveJournalCommitObjectKeyV1(envelope.writerStreamId, envelope.sequence);
        if (!currentBundleRouteMatches(envelope, routes)) return failed(INVALID_REMOTE);
        for (const route of routes) {
            if (
                routeIsInCatalogue(options.catalogue, route) ||
                (route.container === "pack" && options.publicationCache?.hasPack(route))
            ) {
                continue;
            }
            const verified = await verifyRouteObject(currentKey, envelope, route);
            if (verified.status === "failed") return verified;
        }
        return { status: "verified" };
    };

    const readWriter = async (writerStreamId: Uint8Array): Promise<RemoteRead<Uint8Array>> => {
        const key = adaptiveJournalWriterObjectKeyV1(writerStreamId);
        let pending = writerReads.get(key);
        if (!pending) {
            pending = options.remote.readAdaptiveObject(key);
            writerReads.set(key, pending);
        }
        try {
            const result = await pending;
            if (result.status !== "found") {
                if (writerReads.get(key) === pending) writerReads.delete(key);
                return result;
            }
            return { ...result, value: result.value.slice() };
        } catch (error) {
            if (writerReads.get(key) === pending) writerReads.delete(key);
            throw error;
        }
    };

    return {
        listWriterStreamIds: async () => {
            const listed = await options.remote.listAdaptiveObjects(ADAPTIVE_JOURNAL_WRITER_OBJECT_PREFIX_V1);
            if (listed.status === "failed") return listed;
            try {
                const writerStreamIds = listed.keys.map((key) => {
                    const match = /^a1~writer~([A-Za-z0-9_-]{43})\.writer$/u.exec(key);
                    if (!match) throw new Error("Invalid Adaptive Journal Writer object key");
                    return fixedLength(base64UrlToBytes(match[1]), 32, "writerStreamId");
                });
                return { status: "ok" as const, writerStreamIds };
            } catch {
                return failed(INVALID_REMOTE);
            }
        },
        listCommitSequences: async (writerStreamId, afterSequence) => {
            if (afterSequence < 0n || afterSequence > 0x7fffffffffffffffn) return failed(INVALID_REMOTE);
            const prefix = adaptiveJournalCommitObjectPrefixV1(writerStreamId);
            const listed = await options.remote.listAdaptiveObjects(prefix);
            if (listed.status === "failed") return listed;
            try {
                const sequences = listed.keys.map((key) => {
                    const suffix = key.slice(prefix.length);
                    const match = /^([0-9]{20})\.commit$/u.exec(suffix);
                    if (!match) throw new Error("Invalid Adaptive Journal Commit Bundle object key");
                    const sequence = BigInt(match[1]);
                    if (sequence < 1n || sequence > 0x7fffffffffffffffn) {
                        throw new Error("Invalid Adaptive Journal Commit sequence");
                    }
                    return sequence;
                });
                const unique = [...new Set(sequences)].filter((sequence) => sequence > afterSequence);
                unique.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
                return { sequences: unique, status: "ok" as const };
            } catch {
                return failed(INVALID_REMOTE);
            }
        },
        registerWriter: async (record) => {
            if (!bytesEqual(await sha256(record.descriptorFrame), record.descriptorDigest)) {
                return failed(INVALID_REMOTE);
            }
            const key = adaptiveJournalWriterObjectKeyV1(record.writerStreamId);
            const result = await ensureImmutableRecord(
                options.remote,
                key,
                record.descriptorFrame,
                "application/octet-stream"
            );
            if (result.status === "ok" && result.result !== "validate-existing") {
                writerReads.set(
                    key,
                    Promise.resolve({ status: "found" as const, value: record.descriptorFrame.slice() })
                );
            } else if (result.status === "ok") {
                writerReads.delete(key);
            }
            return result;
        },
        putMetadataBatch: async (record) => {
            try {
                if (!bytesEqual(await sha256(record.metadataFrame), record.metadataDigest)) {
                    return failed(INVALID_REMOTE);
                }
                await decodeAdaptiveJournalMetadataRecordV1({
                    bytes: record.metadataFrame,
                    keys: options.keys,
                    sequence: record.sequence,
                    writerStreamId: record.writerStreamId,
                });
                return { result: "inserted", status: "ok" };
            } catch {
                return failed(INVALID_REMOTE);
            }
        },
        readCommit: async (writerStreamId, sequence) => {
            const read = await decodedBundle(writerStreamId, sequence);
            if (read.status === "failed") return read;
            const control = await verifyCommitControl(options, read.envelope);
            if (control.status === "failed" || !currentBundleRouteMatches(read.envelope, control.routes)) {
                return failed(INVALID_REMOTE);
            }
            return { status: "found", value: read.envelope.commitFrame.slice() };
        },
        readMetadata: async (writerStreamId, sequence) => {
            const read = await decodedBundle(writerStreamId, sequence);
            return read.status === "failed" ? read : { status: "found", value: read.envelope.metadataFrame.slice() };
        },
        readWriter,
        commitMetadataBatch: async (bytes) => {
            let envelope: DecodedCommitEnvelopeV1;
            try {
                envelope = await decodeCommitEnvelopeV1(bytes);
            } catch {
                return failed(INVALID_REMOTE);
            }
            if (!bytesEqual(envelope.repositoryId, options.keys.repositoryId)) return failed(INVALID_REMOTE);
            const control = await verifyCommitControl(options, envelope);
            if (control.status === "failed") return control;
            const verified = await verifyRouteObjects(envelope, control.routes);
            if (verified.status === "failed") return verified;
            const key = adaptiveJournalCommitObjectKeyV1(envelope.writerStreamId, envelope.sequence);
            const created = await ensureImmutableRecord(options.remote, key, bytes, "application/octet-stream");
            if (created.status === "failed") return created;
            if (created.result === "validate-existing") {
                bundleCache.delete(key);
                bundleReads.delete(key);
            } else {
                bundleCache.set(key, bytes, envelope);
                try {
                    options.catalogue.applyCommittedPacks(control.routes);
                } catch {
                    bundleCache.delete(key);
                    return failed(INVALID_REMOTE);
                }
                options.publicationCache?.acceptCommit(control.routes);
            }
            return { ...created, commitDigest: envelope.commitFrameDigest };
        },
    };
}
