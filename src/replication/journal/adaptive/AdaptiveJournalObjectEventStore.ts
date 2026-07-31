import {
    AdaptiveJournalCatalogueV1,
    ADAPTIVE_JOURNAL_WRITER_OBJECT_PREFIX_V1,
    adaptiveJournalCommitObjectPrefixV1,
    adaptiveJournalCommitObjectKeyV1,
    adaptiveJournalMetadataObjectKeyV1,
    adaptiveJournalPackObjectKeyV1,
    adaptiveJournalWriterObjectKeyV1,
    decodeAdaptiveJournalCatalogueDeltaV1,
} from "./AdaptiveJournalCatalogue.ts";
import { base64UrlToBytes, bytesEqual, bytesToHex, fixedLength } from "./AdaptiveJournalBinary.ts";
import { decodeCommitEnvelopeV1, type DecodedCommitEnvelopeV1 } from "./AdaptiveJournalCommit.ts";
import { decodeAdaptiveJournalCommitRecordV1 } from "./AdaptiveJournalControl.ts";
import type {
    AdaptiveImmutableRecordResultV1,
    AdaptiveImmutableRecordStatusV1,
    AdaptiveJournalEventStoreV1,
} from "./AdaptiveJournalEventStore.ts";
import type { AdaptiveJournalDiscoveryStoreV1 } from "./AdaptiveJournalDiscoveryStore.ts";
import { sha256, type AdaptiveJournalKeySetV1 } from "./AdaptiveJournalManifest.ts";
import type { AdaptiveJournalObjectPublicationCacheV1 } from "./AdaptiveJournalObjectPublicationCache.ts";
import type { AdaptiveJournalObjectRemoteV1 } from "./AdaptiveJournalObjectStore.ts";
import { decodeAdaptiveJournalPackV1, type AdaptiveJournalPackIndexEntryV1 } from "./AdaptiveJournalPack.ts";
import type { RemoteFailure } from "./AdaptiveJournalRepository.ts";

export interface CreateAdaptiveJournalObjectEventStoreV1Options {
    catalogue: AdaptiveJournalCatalogueV1;
    keys: AdaptiveJournalKeySetV1;
    publicationCache?: AdaptiveJournalObjectPublicationCacheV1;
    remote: AdaptiveJournalObjectRemoteV1;
}

type DecodedCommitControl = Awaited<ReturnType<typeof decodeAdaptiveJournalCommitRecordV1>>;

type VerifiedPackAddition = {
    entries: readonly AdaptiveJournalPackIndexEntryV1[];
    packId: Uint8Array;
};

type DependencyVerification =
    | { additions: readonly VerifiedPackAddition[]; status: "verified" }
    | { failure: RemoteFailure; status: "failed" };

type ControlVerification =
    | { control: DecodedCommitControl; status: "verified" }
    | { failure: RemoteFailure; status: "failed" };

const INVALID_REMOTE: RemoteFailure = { category: "invalid-response", retry: "never" };
const MISSING_REMOTE: RemoteFailure = { category: "unavailable", retry: "later" };

function failed(failure: RemoteFailure): { failure: RemoteFailure; status: "failed" } {
    return { status: "failed", failure };
}

async function readRequiredObject(
    remote: AdaptiveJournalObjectRemoteV1,
    key: string
): Promise<{ bytes: Uint8Array; status: "found" } | { failure: RemoteFailure; status: "failed" }> {
    const read = await remote.readAdaptiveObject(key);
    if (read.status === "found") return { status: "found", bytes: read.value };
    return read.status === "failed" ? read : failed(MISSING_REMOTE);
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
        return created.status === "failed"
            ? created
            : failed({ category: "invalid-response", retry: "later" });
    }
    let result: AdaptiveImmutableRecordStatusV1;
    if (!bytesEqual(read.value, intended)) result = "validate-existing";
    else result = "exact-existing";
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
        bytesEqual(digestFromText(payload.metadata.digest, "metadataDigest"), envelope.metadataDigest) &&
        bytesEqual(
            digestFromText(payload.requiredChunkKeysDigest, "requiredChunkKeysDigest"),
            envelope.requiredChunkKeysDigest
        )
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
        if (!bytesEqual(control.digest, envelope.commitFrameDigest) || !commitControlMatchesEnvelope(envelope, control.payload)) {
            return failed(INVALID_REMOTE);
        }
        return { status: "verified", control };
    } catch {
        return failed(INVALID_REMOTE);
    }
}

function verifyRequiredChunkKeys(
    options: CreateAdaptiveJournalObjectEventStoreV1Options,
    envelope: DecodedCommitEnvelopeV1,
    additions: readonly VerifiedPackAddition[]
): DependencyVerification {
    const newlyAvailable = new Set(
        additions.flatMap(({ entries }) => entries.map(({ key }) => bytesToHex(key)))
    );
    for (const key of envelope.requiredChunkKeys) {
        const text = bytesToHex(key);
        if (options.catalogue.locations(key).length === 0 && !newlyAvailable.has(text)) {
            return failed(MISSING_REMOTE);
        }
    }
    return { status: "verified", additions };
}

function verifyCachedCommitDependencies(
    options: CreateAdaptiveJournalObjectEventStoreV1Options,
    envelope: DecodedCommitEnvelopeV1,
    control: DecodedCommitControl
): DependencyVerification | undefined {
    const cache = options.publicationCache;
    if (!cache) return undefined;
    try {
        const metadata = control.payload.metadata;
        if (metadata.key !== adaptiveJournalMetadataObjectKeyV1(envelope.writerStreamId, envelope.sequence)) {
            return failed(INVALID_REMOTE);
        }
        if (!cache.hasMetadata(metadata.key, envelope.metadataDigest, metadata.bytes)) return undefined;

        const additions: VerifiedPackAddition[] = [];
        for (const dependency of control.payload.catalogueDeltas) {
            const publication = cache.packForDelta(
                dependency.key,
                digestFromText(dependency.digest, "deltaDigest")
            );
            if (!publication) return undefined;
            additions.push({ entries: publication.entries, packId: publication.packId });
        }
        return verifyRequiredChunkKeys(options, envelope, additions);
    } catch {
        return failed(INVALID_REMOTE);
    }
}

async function verifyObjectCommitDependencies(
    options: CreateAdaptiveJournalObjectEventStoreV1Options,
    envelope: DecodedCommitEnvelopeV1,
    control: DecodedCommitControl
): Promise<DependencyVerification> {
    try {
        const metadata = await readRequiredObject(options.remote, control.payload.metadata.key);
        if (metadata.status === "failed") return metadata;
        if (
            metadata.bytes.byteLength !== control.payload.metadata.bytes ||
            !bytesEqual(await sha256(metadata.bytes), envelope.metadataDigest) ||
            control.payload.metadata.key !== adaptiveJournalMetadataObjectKeyV1(envelope.writerStreamId, envelope.sequence)
        ) {
            return failed(INVALID_REMOTE);
        }

        const additions: VerifiedPackAddition[] = [];
        for (const dependency of control.payload.catalogueDeltas) {
            const deltaFrame = await readRequiredObject(options.remote, dependency.key);
            if (deltaFrame.status === "failed") return deltaFrame;
            if (!bytesEqual(await sha256(deltaFrame.bytes), digestFromText(dependency.digest, "deltaDigest"))) {
                return failed(INVALID_REMOTE);
            }
            const delta = await decodeAdaptiveJournalCatalogueDeltaV1({
                bytes: deltaFrame.bytes,
                keys: options.keys,
                sequence: envelope.sequence,
                writerStreamId: envelope.writerStreamId,
            });
            const packId = digestFromText(delta.payload.add.packId, "packId");
            const pack = await readRequiredObject(options.remote, adaptiveJournalPackObjectKeyV1(packId));
            if (pack.status === "failed") return pack;
            if (pack.bytes.byteLength !== delta.payload.add.packBytes) return failed(INVALID_REMOTE);
            const index = await readRequiredObject(options.remote, delta.payload.add.indexKey);
            if (index.status === "failed") return index;
            if (!bytesEqual(await sha256(index.bytes), digestFromText(delta.payload.add.indexDigest, "indexDigest"))) {
                return failed(INVALID_REMOTE);
            }
            const decodedPack = await decodeAdaptiveJournalPackV1({
                expectedPackId: packId,
                indexFrame: index.bytes,
                keys: options.keys,
                packBytes: pack.bytes,
            });
            additions.push({ entries: decodedPack.entries, packId });
        }

        return verifyRequiredChunkKeys(options, envelope, additions);
    } catch {
        return failed(INVALID_REMOTE);
    }
}

export function createAdaptiveJournalObjectEventStoreV1(
    options: CreateAdaptiveJournalObjectEventStoreV1Options
): AdaptiveJournalDiscoveryStoreV1 {
    options.publicationCache?.requireRemote(options.remote);
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
                    if (!match) throw new Error("Invalid Adaptive Journal Commit object key");
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
            return await ensureImmutableRecord(
                options.remote,
                adaptiveJournalWriterObjectKeyV1(record.writerStreamId),
                record.descriptorFrame,
                "application/octet-stream"
            );
        },
        putMetadataBatch: async (record) => {
            if (!bytesEqual(await sha256(record.metadataFrame), record.metadataDigest)) {
                return failed(INVALID_REMOTE);
            }
            const key = adaptiveJournalMetadataObjectKeyV1(record.writerStreamId, record.sequence);
            const result = await ensureImmutableRecord(
                options.remote,
                key,
                record.metadataFrame,
                "application/octet-stream"
            );
            if (result.status === "ok" && result.result !== "validate-existing") {
                options.publicationCache?.rememberMetadata(
                    key,
                    record.metadataDigest,
                    record.metadataFrame.byteLength
                );
            }
            return result;
        },
        readCommit: async (writerStreamId, sequence) =>
            await options.remote.readAdaptiveObject(adaptiveJournalCommitObjectKeyV1(writerStreamId, sequence)),
        readMetadata: async (writerStreamId, sequence) =>
            await options.remote.readAdaptiveObject(adaptiveJournalMetadataObjectKeyV1(writerStreamId, sequence)),
        readWriter: async (writerStreamId) =>
            await options.remote.readAdaptiveObject(adaptiveJournalWriterObjectKeyV1(writerStreamId)),
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
            const verified =
                verifyCachedCommitDependencies(options, envelope, control.control) ??
                (await verifyObjectCommitDependencies(options, envelope, control.control));
            if (verified.status === "failed") return verified;
            const created = await ensureImmutableRecord(
                options.remote,
                adaptiveJournalCommitObjectKeyV1(envelope.writerStreamId, envelope.sequence),
                envelope.commitFrame,
                "application/octet-stream"
            );
            if (created.status === "failed") return created;
            if (created.result !== "validate-existing") {
                for (const addition of verified.additions) {
                    options.catalogue.applyCommittedPack(addition.packId, addition.entries);
                }
                options.publicationCache?.acceptCommit(
                    control.control.payload.metadata.key,
                    control.control.payload.catalogueDeltas.map(({ key }) => key)
                );
            }
            return { ...created, commitDigest: envelope.commitFrameDigest };
        },
    };
}
