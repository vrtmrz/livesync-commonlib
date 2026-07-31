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
import { adaptiveJournalPackObjectKeyV1, parseAdaptiveJournalCommitObjectKeyV1 } from "./AdaptiveJournalCatalogue.ts";
import { AdaptiveJournalError, type AdaptiveJournalKeySetV1 } from "./AdaptiveJournalManifest.ts";
import type { AdaptiveJournalPackEntryV1 } from "./AdaptiveJournalPack.ts";
import {
    AdaptiveRecordKindV1,
    decodeRecordFrameV1,
    encodeRecordFrameV1,
    type AdaptiveRecordCodecPreferenceV1,
} from "./AdaptiveJournalRecord.ts";

const MAX_WRITER_SEQUENCE = 0x7fffffffffffffffn;
const MAX_PACK_BYTES_V1 = 256 * 1024 * 1024;
export const MAX_ADAPTIVE_JOURNAL_COMMIT_PACKS_V1 = 64;
export const MAX_ADAPTIVE_JOURNAL_COMMIT_PACK_ENTRIES_V1 = 4096;

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

export type AdaptiveJournalPackContainerV1 = "bundle" | "pack";

/**
 * Authenticated routing information for one raw Chunk Pack.
 *
 * A bundle container stores the raw Pack in the fixed inline section of a Commit Bundle. A pack
 * container stores the same raw bytes in a content-addressed object. Entries may be a subset of
 * the complete Pack when a later Commit reuses only some of its Chunks.
 */
export interface AdaptiveJournalCommitPackV1 {
    container: AdaptiveJournalPackContainerV1;
    entries: readonly AdaptiveJournalPackEntryV1[];
    objectKey: string;
    packBytes: number;
    packId: Uint8Array;
}

export interface AdaptiveJournalCommitMetadataV1 {
    bytes: number;
    digest: Uint8Array;
}

interface AdaptiveJournalCommitPackPayloadV1 {
    container: AdaptiveJournalPackContainerV1;
    entries: readonly {
        frameDigest: string;
        frameLength: number;
        key: string;
        offset: number;
    }[];
    objectKey: string;
    packBytes: number;
    packId: string;
}

export interface AdaptiveJournalCommitPayloadV1 {
    chunkPacks: readonly AdaptiveJournalCommitPackPayloadV1[];
    formatVersion: 1;
    metadata: { bytes: number; digest: string };
    previousCommitDigest: string | null;
    repositoryId: string;
    requiredChunkKeysDigest: string;
    sequence: string;
    writerStreamId: string;
}

export interface EncodeAdaptiveJournalCommitRecordV1Options {
    chunkPacks: readonly AdaptiveJournalCommitPackV1[];
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

function validateCommitSemantics(sequence: bigint, previousCommitDigest: Uint8Array | null): void {
    if ((sequence === 1n) !== (previousCommitDigest === null)) {
        throw invalidCommitRecord("Commit predecessor presence does not match its sequence");
    }
}

function compareBytes(left: Uint8Array, right: Uint8Array): number {
    for (let index = 0; index < Math.min(left.byteLength, right.byteLength); index += 1) {
        if (left[index] !== right[index]) return left[index] - right[index];
    }
    return left.byteLength - right.byteLength;
}

function safeInteger(value: unknown, label: string, minimum = 0): number {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) {
        throw invalidCommitRecord(`${label} must be a safe integer of at least ${minimum}`);
    }
    return value;
}

function validatePackObjectRoute(
    container: AdaptiveJournalPackContainerV1,
    objectKey: string,
    packId: Uint8Array
): void {
    try {
        if (container === "pack") {
            if (objectKey !== adaptiveJournalPackObjectKeyV1(packId)) {
                throw invalidCommitRecord("External Pack object key does not match its content digest");
            }
        } else {
            parseAdaptiveJournalCommitObjectKeyV1(objectKey);
        }
    } catch (error) {
        if (error instanceof AdaptiveJournalError && error.code === "invalid-commit-record") throw error;
        throw invalidCommitRecord("Commit Pack object key is invalid", error);
    }
}

function canonicalChunkPacks(packs: readonly AdaptiveJournalCommitPackV1[]): AdaptiveJournalCommitPackPayloadV1[] {
    if (packs.length > MAX_ADAPTIVE_JOURNAL_COMMIT_PACKS_V1) {
        throw invalidCommitRecord("Commit Chunk Pack count exceeds the v1 limit");
    }
    const objectKeys = new Set<string>();
    const chunkKeys = new Set<string>();
    let entryCount = 0;
    const canonical = packs.map((source) => {
        if (source.container !== "bundle" && source.container !== "pack") {
            throw invalidCommitRecord("Commit Pack container is invalid");
        }
        if (objectKeys.has(source.objectKey)) {
            throw invalidCommitRecord("Commit repeats a Pack object route");
        }
        objectKeys.add(source.objectKey);
        const packId = fixedLength(source.packId, 32, "packId");
        const packBytes = safeInteger(source.packBytes, "Pack byte length", 1);
        if (packBytes > MAX_PACK_BYTES_V1) throw invalidCommitRecord("Commit Pack exceeds the v1 byte limit");
        validatePackObjectRoute(source.container, source.objectKey, packId);
        if (source.entries.length === 0) throw invalidCommitRecord("Commit Pack route must contain an entry");
        entryCount += source.entries.length;
        if (entryCount > MAX_ADAPTIVE_JOURNAL_COMMIT_PACK_ENTRIES_V1) {
            throw invalidCommitRecord("Commit Chunk Pack entry count exceeds the v1 limit");
        }
        const entries = source.entries
            .map((entry) => {
                const key = fixedLength(entry.key, 32, "remote Chunk key");
                const keyText = bytesToBase64Url(key);
                if (chunkKeys.has(keyText)) throw invalidCommitRecord("Commit repeats a remote Chunk key route");
                chunkKeys.add(keyText);
                const offset = safeInteger(entry.offset, "Pack entry offset");
                const frameLength = safeInteger(entry.frameLength, "Pack entry frame length", 1);
                const end = offset + frameLength;
                if (!Number.isSafeInteger(end) || end > packBytes) {
                    throw invalidCommitRecord("Commit Pack entry extends beyond the Pack");
                }
                return {
                    frameDigest: bytesToBase64Url(fixedLength(entry.frameDigest, 32, "frameDigest")),
                    frameLength,
                    key: keyText,
                    offset,
                };
            })
            .sort((left, right) => compareBytes(base64UrlToBytes(left.key), base64UrlToBytes(right.key)));
        return {
            container: source.container,
            entries,
            objectKey: source.objectKey,
            packBytes,
            packId: bytesToBase64Url(packId),
        };
    });
    canonical.sort((left, right) => (left.objectKey < right.objectKey ? -1 : left.objectKey > right.objectKey ? 1 : 0));
    return canonical;
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
    validateCommitSemantics(options.sequence, previousCommitDigest);
    const metadataBytes = safeInteger(options.metadata.bytes, "Commit Metadata byte length", 1);
    const payload: AdaptiveJournalCommitPayloadV1 = {
        chunkPacks: canonicalChunkPacks(options.chunkPacks),
        formatVersion: 1,
        metadata: {
            bytes: metadataBytes,
            digest: bytesToBase64Url(metadataDigest),
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

function decodeChunkPacks(value: unknown): readonly AdaptiveJournalCommitPackV1[] {
    if (!Array.isArray(value) || value.length > MAX_ADAPTIVE_JOURNAL_COMMIT_PACKS_V1) {
        throw invalidCommitRecord("Commit Chunk Packs do not match v1");
    }
    const decoded: AdaptiveJournalCommitPackV1[] = [];
    let previousObjectKey = "";
    for (const packValue of value) {
        if (!packValue || typeof packValue !== "object" || Array.isArray(packValue)) {
            throw invalidCommitRecord("Commit Chunk Pack must be an object");
        }
        const pack = packValue as Record<string, unknown>;
        if (
            !exactObjectKeys(pack, ["container", "entries", "objectKey", "packBytes", "packId"]) ||
            (pack.container !== "bundle" && pack.container !== "pack") ||
            typeof pack.objectKey !== "string" ||
            pack.objectKey <= previousObjectKey ||
            !Array.isArray(pack.entries) ||
            pack.entries.length === 0
        ) {
            throw invalidCommitRecord("Commit Chunk Pack fields do not match v1");
        }
        const packId = decodeDigest(pack.packId, "Pack ID");
        const packBytes = safeInteger(pack.packBytes, "Pack byte length", 1);
        if (packBytes > MAX_PACK_BYTES_V1) throw invalidCommitRecord("Commit Pack exceeds the v1 byte limit");
        validatePackObjectRoute(pack.container, pack.objectKey, packId);
        const entries: AdaptiveJournalPackEntryV1[] = [];
        let previousKey: Uint8Array | undefined;
        for (const entryValue of pack.entries) {
            if (!entryValue || typeof entryValue !== "object" || Array.isArray(entryValue)) {
                throw invalidCommitRecord("Commit Pack entry must be an object");
            }
            const entry = entryValue as Record<string, unknown>;
            if (!exactObjectKeys(entry, ["frameDigest", "frameLength", "key", "offset"])) {
                throw invalidCommitRecord("Commit Pack entry fields do not match v1");
            }
            const key = decodeDigest(entry.key, "remote Chunk key");
            if (previousKey && compareBytes(previousKey, key) >= 0) {
                throw invalidCommitRecord("Commit Pack entries must be sorted and unique");
            }
            const offset = safeInteger(entry.offset, "Pack entry offset");
            const frameLength = safeInteger(entry.frameLength, "Pack entry frame length", 1);
            const end = offset + frameLength;
            if (!Number.isSafeInteger(end) || end > packBytes) {
                throw invalidCommitRecord("Commit Pack entry extends beyond the Pack");
            }
            entries.push({
                frameDigest: decodeDigest(entry.frameDigest, "frame digest"),
                frameLength,
                key,
                offset,
            });
            previousKey = key;
        }
        decoded.push({
            container: pack.container,
            entries,
            objectKey: pack.objectKey,
            packBytes,
            packId,
        });
        previousObjectKey = pack.objectKey;
    }
    const allKeys = decoded.flatMap(({ entries }) => entries.map(({ key }) => bytesToBase64Url(key)));
    if (allKeys.length > MAX_ADAPTIVE_JOURNAL_COMMIT_PACK_ENTRIES_V1 || new Set(allKeys).size !== allKeys.length) {
        throw invalidCommitRecord("Commit Chunk Pack routes repeat a key or exceed the v1 limit");
    }
    return decoded;
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
            "chunkPacks",
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
        !payload.metadata ||
        typeof payload.metadata !== "object" ||
        Array.isArray(payload.metadata)
    ) {
        throw invalidCommitRecord("Commit payload fields do not match v1");
    }
    const metadata = payload.metadata as Record<string, unknown>;
    if (!exactObjectKeys(metadata, ["bytes", "digest"])) {
        throw invalidCommitRecord("Commit Metadata fields do not match v1");
    }
    safeInteger(metadata.bytes, "Commit Metadata byte length", 1);
    decodeDigest(metadata.digest, "Metadata digest");
    decodeDigest(payload.requiredChunkKeysDigest, "required Chunk key digest");
    if (payload.previousCommitDigest !== null) decodeDigest(payload.previousCommitDigest, "previous Commit digest");
    decodeChunkPacks(payload.chunkPacks);
    if (!bytesEqual(bytes, canonicalJsonBytes(parsed))) {
        throw invalidCommitRecord("Commit payload is not canonical JSON");
    }
    return parsed as AdaptiveJournalCommitPayloadV1;
}

export function decodeAdaptiveJournalCommitPacksV1(
    payload: AdaptiveJournalCommitPayloadV1
): readonly AdaptiveJournalCommitPackV1[] {
    return decodeChunkPacks(payload.chunkPacks);
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
        payload.sequence !== sequenceText(options.sequence)
    ) {
        throw invalidCommitRecord("Commit payload identity does not match its logical route");
    }
    const previousCommitDigest =
        payload.previousCommitDigest === null
            ? null
            : decodeDigest(payload.previousCommitDigest, "previous Commit digest");
    validateCommitSemantics(options.sequence, previousCommitDigest);
    return { digest: decoded.frameDigest, payload };
}
