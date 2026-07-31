import {
    base64UrlToBytes,
    bytesEqual,
    bytesToBase64Url,
    canonicalJsonBytes,
    concatBytes,
    decodeUtf8,
    fixedLength,
    u64be,
} from "./AdaptiveJournalBinary.ts";
import {
    adaptiveJournalMetadataObjectKeyV1,
    parseAdaptiveJournalDeltaObjectKeyV1,
} from "./AdaptiveJournalCatalogue.ts";
import { AdaptiveJournalError, type AdaptiveJournalKeySetV1 } from "./AdaptiveJournalManifest.ts";
import {
    AdaptiveRecordKindV1,
    decodeRecordFrameV1,
    encodeRecordFrameV1,
    type AdaptiveRecordCodecPreferenceV1,
} from "./AdaptiveJournalRecord.ts";

const MAX_WRITER_SEQUENCE = 0x7fffffffffffffffn;
export const MAX_ADAPTIVE_JOURNAL_CATALOGUE_DELTAS_V1 = 64;

function sequenceText(sequence: bigint): string {
    if (sequence < 1n || sequence > MAX_WRITER_SEQUENCE) {
        throw new RangeError("Adaptive Journal sequence must be a positive 63-bit integer");
    }
    return sequence.toString(10).padStart(20, "0");
}

function invalidCommitRecord(message: string, cause?: unknown): AdaptiveJournalError {
    return new AdaptiveJournalError("invalid-commit-record", message, cause === undefined ? undefined : { cause });
}

function logicalKey(writerStreamId: Uint8Array, sequence: bigint): Uint8Array {
    sequenceText(sequence);
    return concatBytes(fixedLength(writerStreamId, 32, "writerStreamId"), u64be(sequence));
}

export interface AdaptiveJournalCommitDependencyV1 {
    digest: Uint8Array;
    key: string;
}

export interface AdaptiveJournalCommitMetadataV1 extends AdaptiveJournalCommitDependencyV1 {
    bytes: number;
}

export interface AdaptiveJournalCommitPayloadV1 {
    catalogueDeltas: readonly { digest: string; key: string }[];
    formatVersion: 1;
    metadata: { bytes: number; digest: string; key: string };
    previousCommitDigest: string | null;
    repositoryId: string;
    requiredChunkKeysDigest: string;
    sequence: string;
    writerStreamId: string;
}

export interface EncodeAdaptiveJournalCommitRecordV1Options {
    catalogueDeltas: readonly AdaptiveJournalCommitDependencyV1[];
    codec?: AdaptiveRecordCodecPreferenceV1;
    keys: AdaptiveJournalKeySetV1;
    metadata: AdaptiveJournalCommitMetadataV1;
    previousCommitDigest: Uint8Array | null;
    recordIv?: Uint8Array;
    recordSalt?: Uint8Array;
    requiredChunkKeysDigest: Uint8Array;
    sequence: bigint;
    writerStreamId: Uint8Array;
}

export interface DecodeAdaptiveJournalCommitRecordV1Options {
    bytes: Uint8Array;
    keys: AdaptiveJournalKeySetV1;
    sequence: bigint;
    writerStreamId: Uint8Array;
}

export interface EncodedAdaptiveJournalCommitRecordV1 {
    bytes: Uint8Array;
    digest: Uint8Array;
    payload: AdaptiveJournalCommitPayloadV1;
}

function validateCommitSemantics(
    sequence: bigint,
    previousCommitDigest: Uint8Array | null,
    metadataKey: string,
    writerStreamId: Uint8Array
): void {
    if ((sequence === 1n) !== (previousCommitDigest === null)) {
        throw invalidCommitRecord("Commit predecessor presence does not match its sequence");
    }
    if (metadataKey !== adaptiveJournalMetadataObjectKeyV1(writerStreamId, sequence)) {
        throw invalidCommitRecord("Commit Metadata key does not match its writer sequence");
    }
}

function canonicalDependencies(
    dependencies: readonly AdaptiveJournalCommitDependencyV1[]
): Array<{ digest: string; key: string }> {
    if (dependencies.length > MAX_ADAPTIVE_JOURNAL_CATALOGUE_DELTAS_V1) {
        throw invalidCommitRecord("Commit catalogue dependency count exceeds the v1 limit");
    }
    const byKey = new Map<string, string>();
    for (const dependency of dependencies) {
        fixedLength(dependency.digest, 32, "catalogue delta digest");
        try {
            parseAdaptiveJournalDeltaObjectKeyV1(dependency.key);
        } catch (error) {
            throw invalidCommitRecord("Commit catalogue dependency key is invalid", error);
        }
        const digest = bytesToBase64Url(dependency.digest);
        const existing = byKey.get(dependency.key);
        if (existing !== undefined && existing !== digest) {
            throw invalidCommitRecord("Commit repeats a catalogue key with a different digest");
        }
        byKey.set(dependency.key, digest);
    }
    return [...byKey.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, digest]) => ({ digest, key }));
}

export async function encodeAdaptiveJournalCommitRecordV1(
    options: EncodeAdaptiveJournalCommitRecordV1Options
): Promise<EncodedAdaptiveJournalCommitRecordV1> {
    const writerStreamId = fixedLength(options.writerStreamId, 32, "writerStreamId");
    const previousCommitDigest =
        options.previousCommitDigest === null
            ? null
            : fixedLength(options.previousCommitDigest, 32, "previousCommitDigest");
    const metadataDigest = fixedLength(options.metadata.digest, 32, "metadata digest");
    const requiredChunkKeysDigest = fixedLength(options.requiredChunkKeysDigest, 32, "required Chunk key digest");
    sequenceText(options.sequence);
    validateCommitSemantics(options.sequence, previousCommitDigest, options.metadata.key, writerStreamId);
    if (!Number.isSafeInteger(options.metadata.bytes) || options.metadata.bytes < 1) {
        throw invalidCommitRecord("Commit Metadata byte length must be a positive safe integer");
    }
    const payload: AdaptiveJournalCommitPayloadV1 = {
        catalogueDeltas: canonicalDependencies(options.catalogueDeltas),
        formatVersion: 1,
        metadata: {
            bytes: options.metadata.bytes,
            digest: bytesToBase64Url(metadataDigest),
            key: options.metadata.key,
        },
        previousCommitDigest: previousCommitDigest === null ? null : bytesToBase64Url(previousCommitDigest),
        repositoryId: bytesToBase64Url(options.keys.repositoryId),
        requiredChunkKeysDigest: bytesToBase64Url(requiredChunkKeysDigest),
        sequence: sequenceText(options.sequence),
        writerStreamId: bytesToBase64Url(writerStreamId),
    };
    const encoded = await encodeRecordFrameV1({
        codec: options.codec,
        iv: options.recordIv,
        keys: options.keys,
        kind: AdaptiveRecordKindV1.Commit,
        logicalKey: logicalKey(writerStreamId, options.sequence),
        plaintext: canonicalJsonBytes(payload),
        recordSalt: options.recordSalt,
    });
    return { bytes: encoded.bytes, digest: encoded.digest, payload };
}

function exactObjectKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
    return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
}

function decodeDigest(value: unknown, label: string): Uint8Array {
    if (typeof value !== "string") throw invalidCommitRecord(`${label} must be a base64url string`);
    try {
        return fixedLength(base64UrlToBytes(value), 32, label);
    } catch (error) {
        throw invalidCommitRecord(`${label} is not a 32-byte base64url value`, error);
    }
}

function parseCommitPayload(bytes: Uint8Array): AdaptiveJournalCommitPayloadV1 {
    let parsed: unknown;
    try {
        parsed = JSON.parse(decodeUtf8(bytes));
    } catch (error) {
        throw invalidCommitRecord("Commit payload is not valid UTF-8 JSON", error);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw invalidCommitRecord("Commit payload must be an object");
    }
    const payload = parsed as Record<string, unknown>;
    if (
        !exactObjectKeys(payload, [
            "catalogueDeltas",
            "formatVersion",
            "metadata",
            "previousCommitDigest",
            "repositoryId",
            "requiredChunkKeysDigest",
            "sequence",
            "writerStreamId",
        ]) ||
        payload.formatVersion !== 1 ||
        typeof payload.repositoryId !== "string" ||
        typeof payload.sequence !== "string" ||
        typeof payload.writerStreamId !== "string" ||
        !Array.isArray(payload.catalogueDeltas) ||
        payload.catalogueDeltas.length > MAX_ADAPTIVE_JOURNAL_CATALOGUE_DELTAS_V1 ||
        !payload.metadata ||
        typeof payload.metadata !== "object" ||
        Array.isArray(payload.metadata)
    ) {
        throw invalidCommitRecord("Commit payload fields do not match v1");
    }
    const metadata = payload.metadata as Record<string, unknown>;
    if (
        !exactObjectKeys(metadata, ["bytes", "digest", "key"]) ||
        typeof metadata.bytes !== "number" ||
        !Number.isSafeInteger(metadata.bytes) ||
        metadata.bytes < 1 ||
        typeof metadata.key !== "string"
    ) {
        throw invalidCommitRecord("Commit Metadata fields do not match v1");
    }
    decodeDigest(metadata.digest, "Metadata digest");
    decodeDigest(payload.requiredChunkKeysDigest, "required Chunk key digest");
    if (payload.previousCommitDigest !== null) decodeDigest(payload.previousCommitDigest, "previous Commit digest");
    let previousKey = "";
    for (const dependencyValue of payload.catalogueDeltas) {
        if (!dependencyValue || typeof dependencyValue !== "object" || Array.isArray(dependencyValue)) {
            throw invalidCommitRecord("Commit catalogue dependency must be an object");
        }
        const dependency = dependencyValue as Record<string, unknown>;
        if (
            !exactObjectKeys(dependency, ["digest", "key"]) ||
            typeof dependency.key !== "string" ||
            dependency.key <= previousKey
        ) {
            throw invalidCommitRecord("Commit catalogue dependencies must be sorted and unique");
        }
        decodeDigest(dependency.digest, "catalogue delta digest");
        try {
            parseAdaptiveJournalDeltaObjectKeyV1(dependency.key);
        } catch (error) {
            throw invalidCommitRecord("Commit catalogue dependency key is invalid", error);
        }
        previousKey = dependency.key;
    }
    if (!bytesEqual(bytes, canonicalJsonBytes(parsed))) {
        throw invalidCommitRecord("Commit payload is not canonical JSON");
    }
    return parsed as AdaptiveJournalCommitPayloadV1;
}

export async function decodeAdaptiveJournalCommitRecordV1(
    options: DecodeAdaptiveJournalCommitRecordV1Options
): Promise<{ digest: Uint8Array; payload: AdaptiveJournalCommitPayloadV1 }> {
    const writerStreamId = fixedLength(options.writerStreamId, 32, "writerStreamId");
    const decoded = await decodeRecordFrameV1({
        bytes: options.bytes,
        expectedKind: AdaptiveRecordKindV1.Commit,
        keys: options.keys,
        logicalKey: logicalKey(writerStreamId, options.sequence),
    });
    const payload = parseCommitPayload(decoded.plaintext);
    if (
        payload.repositoryId !== bytesToBase64Url(options.keys.repositoryId) ||
        payload.writerStreamId !== bytesToBase64Url(writerStreamId) ||
        payload.sequence !== sequenceText(options.sequence) ||
        payload.metadata.key !== adaptiveJournalMetadataObjectKeyV1(writerStreamId, options.sequence)
    ) {
        throw invalidCommitRecord("Commit payload identity does not match its logical route");
    }
    const previousCommitDigest =
        payload.previousCommitDigest === null
            ? null
            : decodeDigest(payload.previousCommitDigest, "previous Commit digest");
    validateCommitSemantics(options.sequence, previousCommitDigest, payload.metadata.key, writerStreamId);
    return { digest: decoded.frameDigest, payload };
}
