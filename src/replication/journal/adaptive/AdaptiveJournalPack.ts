import {
    BinaryReader,
    boundedU64ToNumber,
    bytesEqual,
    bytesToBase64Url,
    bytesToHex,
    concatBytes,
    fixedLength,
    u32be,
    u64be,
} from "./AdaptiveJournalBinary.ts";
import {
    AdaptiveJournalError,
    sha256,
    type AdaptiveJournalKeySetV1,
} from "./AdaptiveJournalManifest.ts";
import {
    AdaptiveRecordKindV1,
    decodeRecordFrameV1,
    encodeRecordFrameV1,
    type AdaptiveRecordCodecPreferenceV1,
} from "./AdaptiveJournalRecord.ts";

export interface AdaptiveJournalPackLimitsV1 {
    maxEntries: number;
    maxIndexPayloadBytes: number;
    maxPackBytes: number;
}

export const DEFAULT_ADAPTIVE_JOURNAL_PACK_LIMITS_V1: Readonly<AdaptiveJournalPackLimitsV1> = {
    maxEntries: 16_384,
    maxIndexPayloadBytes: 4 + 16_384 * 88,
    maxPackBytes: 256 * 1024 * 1024,
};

export interface AdaptiveJournalPackChunkV1 {
    frame: Uint8Array;
    key: Uint8Array;
}

export interface AdaptiveJournalPackIndexEntryV1 {
    frameDigest: Uint8Array;
    frameLength: number;
    key: Uint8Array;
    offset: number;
    plaintextLength: number;
}

export interface BuildAdaptiveJournalPackV1Options {
    chunks: readonly AdaptiveJournalPackChunkV1[];
    indexCodec?: AdaptiveRecordCodecPreferenceV1;
    indexIv?: Uint8Array;
    indexRecordSalt?: Uint8Array;
    keys: AdaptiveJournalKeySetV1;
    limits?: Partial<AdaptiveJournalPackLimitsV1>;
}

export interface BuiltAdaptiveJournalPackV1 {
    entries: readonly AdaptiveJournalPackIndexEntryV1[];
    indexFrame: Uint8Array;
    indexFrameDigest: Uint8Array;
    packBytes: Uint8Array;
    packId: Uint8Array;
    packIdText: string;
}

export interface DecodeAdaptiveJournalPackV1Options {
    expectedPackId?: Uint8Array;
    indexFrame: Uint8Array;
    keys: AdaptiveJournalKeySetV1;
    limits?: Partial<AdaptiveJournalPackLimitsV1>;
    packBytes: Uint8Array;
}

export interface DecodeAdaptiveJournalPackIndexFrameV1Options {
    expectedPackId: Uint8Array;
    indexFrame: Uint8Array;
    keys: AdaptiveJournalKeySetV1;
    limits?: Partial<AdaptiveJournalPackLimitsV1>;
    packBytes: number;
}

const PACK_INDEX_ENTRY_LENGTH = 88;
const PACK_INDEX_PREFIX_LENGTH = 4;

function limitsWithDefaults(overrides?: Partial<AdaptiveJournalPackLimitsV1>): AdaptiveJournalPackLimitsV1 {
    const limits = { ...DEFAULT_ADAPTIVE_JOURNAL_PACK_LIMITS_V1, ...overrides };
    for (const [name, value] of Object.entries(limits)) {
        if (!Number.isSafeInteger(value) || value < 1) {
            throw new RangeError(`${name} must be a positive safe integer`);
        }
    }
    return limits;
}

function compareBytes(left: Uint8Array, right: Uint8Array): number {
    for (let index = 0; index < Math.min(left.byteLength, right.byteLength); index += 1) {
        if (left[index] !== right[index]) return left[index] - right[index];
    }
    return left.byteLength - right.byteLength;
}

function invalidPack(message: string, cause?: unknown): AdaptiveJournalError {
    return new AdaptiveJournalError("invalid-pack-index", message, cause === undefined ? undefined : { cause });
}

function packLimit(message: string, cause?: unknown): AdaptiveJournalError {
    return new AdaptiveJournalError("pack-limit-exceeded", message, cause === undefined ? undefined : { cause });
}

function requireSafePackInteger(value: number, label: string): number {
    if (!Number.isSafeInteger(value) || value < 0) throw invalidPack(`${label} must be a non-negative safe integer`);
    return value;
}

function validateEntryShape(entry: AdaptiveJournalPackIndexEntryV1): AdaptiveJournalPackIndexEntryV1 {
    return {
        frameDigest: fixedLength(entry.frameDigest, 32, "frameDigest").slice(),
        frameLength: requireSafePackInteger(entry.frameLength, "frameLength"),
        key: fixedLength(entry.key, 32, "remote Chunk key").slice(),
        offset: requireSafePackInteger(entry.offset, "offset"),
        plaintextLength: requireSafePackInteger(entry.plaintextLength, "plaintextLength"),
    };
}

export function encodeAdaptiveJournalPackIndexPayloadV1(
    sourceEntries: readonly AdaptiveJournalPackIndexEntryV1[]
): Uint8Array {
    if (sourceEntries.length > 0xffffffff) throw packLimit("Pack index entry count does not fit v1");
    const entries = sourceEntries.map(validateEntryShape);
    for (let index = 1; index < entries.length; index += 1) {
        if (compareBytes(entries[index - 1].key, entries[index].key) >= 0) {
            throw invalidPack("Pack index keys must be strictly increasing and unique");
        }
    }
    return concatBytes(
        u32be(entries.length),
        ...entries.map((entry) =>
            concatBytes(
                entry.key,
                u64be(entry.offset),
                u64be(entry.frameLength),
                u64be(entry.plaintextLength),
                entry.frameDigest
            )
        )
    );
}

export function decodeAdaptiveJournalPackIndexPayloadV1(
    bytes: Uint8Array,
    packLength: number,
    limitOverrides?: Partial<AdaptiveJournalPackLimitsV1>
): readonly AdaptiveJournalPackIndexEntryV1[] {
    const limits = limitsWithDefaults(limitOverrides);
    requireSafePackInteger(packLength, "packLength");
    if (packLength > limits.maxPackBytes) throw packLimit("Pack exceeds its configured byte limit");
    if (bytes.byteLength > limits.maxIndexPayloadBytes) {
        throw packLimit("Pack index payload exceeds its configured byte limit");
    }
    const reader = new BinaryReader(bytes);
    try {
        const count = reader.readU32();
        if (count > limits.maxEntries) throw packLimit("Pack index entry count exceeds its configured limit");
        const expectedLength = PACK_INDEX_PREFIX_LENGTH + count * PACK_INDEX_ENTRY_LENGTH;
        if (bytes.byteLength !== expectedLength) throw invalidPack("Pack index payload length does not match its entries");
        const entries: AdaptiveJournalPackIndexEntryV1[] = [];
        let expectedOffset = 0;
        for (let index = 0; index < count; index += 1) {
            const entry = {
                key: reader.readBytes(32),
                offset: boundedU64ToNumber(reader.readU64(), limits.maxPackBytes),
                frameLength: boundedU64ToNumber(reader.readU64(), limits.maxPackBytes),
                plaintextLength: boundedU64ToNumber(reader.readU64(), limits.maxPackBytes),
                frameDigest: reader.readBytes(32),
            };
            if (entry.frameLength < 1) throw invalidPack("Pack index frame length must be positive");
            if (entries.length > 0 && compareBytes(entries.at(-1)!.key, entry.key) >= 0) {
                throw invalidPack("Pack index keys must be strictly increasing and unique");
            }
            if (entry.offset !== expectedOffset) {
                throw invalidPack("Pack index entries must cover the pack without gaps or overlaps");
            }
            expectedOffset = entry.offset + entry.frameLength;
            if (!Number.isSafeInteger(expectedOffset) || expectedOffset > packLength) {
                throw invalidPack("Pack index entry extends beyond the pack");
            }
            entries.push(entry);
        }
        if (expectedOffset !== packLength) {
            throw invalidPack("Pack index entries do not cover the complete pack");
        }
        return entries;
    } catch (error) {
        if (error instanceof AdaptiveJournalError) throw error;
        if (error instanceof RangeError && error.message.includes("configured limit")) {
            throw packLimit("Pack index field exceeds its configured limit", error);
        }
        throw invalidPack("Pack index payload is malformed or truncated", error);
    }
}

export async function buildAdaptiveJournalPackV1(
    options: BuildAdaptiveJournalPackV1Options
): Promise<BuiltAdaptiveJournalPackV1> {
    const limits = limitsWithDefaults(options.limits);
    if (options.chunks.length < 1) throw invalidPack("A pack must contain at least one Chunk frame");
    if (options.chunks.length > limits.maxEntries) throw packLimit("Pack entry count exceeds its configured limit");

    const seen = new Set<string>();
    const decoded = await Promise.all(
        options.chunks.map(async (source) => {
            const key = fixedLength(source.key, 32, "remote Chunk key").slice();
            const keyHex = bytesToHex(key);
            if (seen.has(keyHex)) throw invalidPack("A pack cannot contain a duplicate remote Chunk key");
            seen.add(keyHex);
            const record = await decodeRecordFrameV1({
                bytes: source.frame,
                expectedKind: AdaptiveRecordKindV1.Chunk,
                keys: options.keys,
                logicalKey: key,
            });
            return {
                frame: source.frame.slice(),
                frameDigest: record.frameDigest,
                key,
                plaintextLength: record.plaintext.byteLength,
            };
        })
    );
    decoded.sort((left, right) => compareBytes(left.key, right.key));

    const entries: AdaptiveJournalPackIndexEntryV1[] = [];
    let offset = 0;
    for (const chunk of decoded) {
        const frameLength = chunk.frame.byteLength;
        const nextOffset = offset + frameLength;
        if (!Number.isSafeInteger(nextOffset) || nextOffset > limits.maxPackBytes) {
            throw packLimit("Pack exceeds its configured byte limit");
        }
        entries.push({
            frameDigest: chunk.frameDigest,
            frameLength,
            key: chunk.key,
            offset,
            plaintextLength: chunk.plaintextLength,
        });
        offset = nextOffset;
    }
    const packBytes = concatBytes(...decoded.map(({ frame }) => frame));
    const packId = await sha256(packBytes);
    const indexPayload = encodeAdaptiveJournalPackIndexPayloadV1(entries);
    if (indexPayload.byteLength > limits.maxIndexPayloadBytes) {
        throw packLimit("Pack index payload exceeds its configured byte limit");
    }
    const index = await encodeRecordFrameV1({
        codec: options.indexCodec,
        iv: options.indexIv,
        keys: options.keys,
        kind: AdaptiveRecordKindV1.PackIndex,
        logicalKey: packId,
        plaintext: indexPayload,
        recordSalt: options.indexRecordSalt,
    });
    return {
        entries,
        indexFrame: index.bytes,
        indexFrameDigest: index.digest,
        packBytes,
        packId,
        packIdText: bytesToBase64Url(packId),
    };
}

export function frameFromAdaptiveJournalPackV1(
    packBytes: Uint8Array,
    sourceEntry: AdaptiveJournalPackIndexEntryV1
): Uint8Array {
    const entry = validateEntryShape(sourceEntry);
    const end = entry.offset + entry.frameLength;
    if (!Number.isSafeInteger(end) || end > packBytes.byteLength) {
        throw invalidPack("Pack index entry extends beyond the available pack bytes");
    }
    return packBytes.slice(entry.offset, end);
}

export async function decodeAdaptiveJournalPackV1(
    options: DecodeAdaptiveJournalPackV1Options
): Promise<{
    entries: readonly AdaptiveJournalPackIndexEntryV1[];
    indexFrameDigest: Uint8Array;
    packId: Uint8Array;
    packIdText: string;
}> {
    const limits = limitsWithDefaults(options.limits);
    if (options.packBytes.byteLength > limits.maxPackBytes) throw packLimit("Pack exceeds its configured byte limit");
    const packId = await sha256(options.packBytes);
    if (options.expectedPackId && !bytesEqual(fixedLength(options.expectedPackId, 32, "expectedPackId"), packId)) {
        throw new AdaptiveJournalError("pack-integrity-failed", "Pack bytes do not match the expected content digest");
    }
    let index;
    try {
        index = await decodeRecordFrameV1({
            bytes: options.indexFrame,
            expectedKind: AdaptiveRecordKindV1.PackIndex,
            keys: options.keys,
            logicalKey: packId,
        });
    } catch (error) {
        throw new AdaptiveJournalError("pack-integrity-failed", "Pack index does not authenticate for this pack", {
            cause: error,
        });
    }
    const entries = decodeAdaptiveJournalPackIndexPayloadV1(index.plaintext, options.packBytes.byteLength, limits);
    for (const entry of entries) {
        const frame = frameFromAdaptiveJournalPackV1(options.packBytes, entry);
        if (!bytesEqual(await sha256(frame), entry.frameDigest)) {
            throw new AdaptiveJournalError("pack-integrity-failed", "Indexed Chunk frame digest does not match the pack");
        }
        let decoded;
        try {
            decoded = await decodeRecordFrameV1({
                bytes: frame,
                expectedKind: AdaptiveRecordKindV1.Chunk,
                keys: options.keys,
                logicalKey: entry.key,
            });
        } catch (error) {
            throw new AdaptiveJournalError("pack-integrity-failed", "Indexed Chunk frame is invalid", { cause: error });
        }
        if (decoded.plaintext.byteLength !== entry.plaintextLength) {
            throw new AdaptiveJournalError(
                "pack-integrity-failed",
                "Indexed Chunk plaintext length does not match its frame"
            );
        }
    }
    return {
        entries,
        indexFrameDigest: index.frameDigest,
        packId,
        packIdText: bytesToBase64Url(packId),
    };
}

export async function decodeAdaptiveJournalPackIndexFrameV1(
    options: DecodeAdaptiveJournalPackIndexFrameV1Options
): Promise<{
    entries: readonly AdaptiveJournalPackIndexEntryV1[];
    indexFrameDigest: Uint8Array;
    packId: Uint8Array;
}> {
    const limits = limitsWithDefaults(options.limits);
    if (!Number.isSafeInteger(options.packBytes) || options.packBytes < 1 || options.packBytes > limits.maxPackBytes) {
        throw packLimit("Pack byte length is outside its configured limit");
    }
    const packId = fixedLength(options.expectedPackId, 32, "expectedPackId");
    let index;
    try {
        index = await decodeRecordFrameV1({
            bytes: options.indexFrame,
            expectedKind: AdaptiveRecordKindV1.PackIndex,
            keys: options.keys,
            logicalKey: packId,
        });
    } catch (error) {
        throw new AdaptiveJournalError("pack-integrity-failed", "Pack index does not authenticate for this pack", {
            cause: error,
        });
    }
    return {
        entries: decodeAdaptiveJournalPackIndexPayloadV1(index.plaintext, options.packBytes, limits),
        indexFrameDigest: index.frameDigest,
        packId: packId.slice(),
    };
}
