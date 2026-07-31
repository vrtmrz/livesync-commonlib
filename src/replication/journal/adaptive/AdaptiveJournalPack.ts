import { bytesToHex, concatBytes, fixedLength } from "./AdaptiveJournalBinary.ts";
import { AdaptiveJournalError, sha256, type AdaptiveJournalKeySetV1 } from "./AdaptiveJournalManifest.ts";
import { AdaptiveRecordKindV1, decodeRecordFrameV1 } from "./AdaptiveJournalRecord.ts";

export interface AdaptiveJournalPackLimitsV1 {
    maxEntries: number;
    maxPackBytes: number;
}

export const DEFAULT_ADAPTIVE_JOURNAL_PACK_LIMITS_V1: Readonly<AdaptiveJournalPackLimitsV1> = {
    maxEntries: 16_384,
    maxPackBytes: 256 * 1024 * 1024,
};

export interface AdaptiveJournalPackChunkV1 {
    frame: Uint8Array;
    key: Uint8Array;
}

export interface AdaptiveJournalPackEntryV1 {
    frameDigest: Uint8Array;
    frameLength: number;
    key: Uint8Array;
    offset: number;
}

export interface BuildAdaptiveJournalPackV1Options {
    chunks: readonly AdaptiveJournalPackChunkV1[];
    keys: AdaptiveJournalKeySetV1;
    limits?: Partial<AdaptiveJournalPackLimitsV1>;
}

export interface BuiltAdaptiveJournalPackV1 {
    entries: readonly AdaptiveJournalPackEntryV1[];
    packBytes: Uint8Array;
    packId: Uint8Array;
}

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
    return new AdaptiveJournalError("invalid-pack", message, cause === undefined ? undefined : { cause });
}

function packLimit(message: string, cause?: unknown): AdaptiveJournalError {
    return new AdaptiveJournalError("pack-limit-exceeded", message, cause === undefined ? undefined : { cause });
}

function requireSafePackInteger(value: number, label: string, minimum = 0): number {
    if (!Number.isSafeInteger(value) || value < minimum) {
        throw invalidPack(`${label} must be a safe integer of at least ${minimum}`);
    }
    return value;
}

function validateEntryShape(entry: AdaptiveJournalPackEntryV1): AdaptiveJournalPackEntryV1 {
    return {
        frameDigest: fixedLength(entry.frameDigest, 32, "frameDigest").slice(),
        frameLength: requireSafePackInteger(entry.frameLength, "frameLength", 1),
        key: fixedLength(entry.key, 32, "remote Chunk key").slice(),
        offset: requireSafePackInteger(entry.offset, "offset"),
    };
}

export async function buildAdaptiveJournalPackV1(
    options: BuildAdaptiveJournalPackV1Options
): Promise<BuiltAdaptiveJournalPackV1> {
    const limits = limitsWithDefaults(options.limits);
    if (options.chunks.length < 1) throw invalidPack("A Pack must contain at least one Chunk frame");
    if (options.chunks.length > limits.maxEntries) throw packLimit("Pack entry count exceeds its configured limit");

    const seen = new Set<string>();
    const decoded: { frame: Uint8Array; frameDigest: Uint8Array; key: Uint8Array }[] = [];
    for (const source of options.chunks) {
        const key = fixedLength(source.key, 32, "remote Chunk key").slice();
        const keyHex = bytesToHex(key);
        if (seen.has(keyHex)) throw invalidPack("A Pack cannot contain a duplicate remote Chunk key");
        seen.add(keyHex);
        const record = await decodeRecordFrameV1({
            bytes: source.frame,
            expectedKind: AdaptiveRecordKindV1.Chunk,
            keys: options.keys,
            logicalKey: key,
        });
        decoded.push({
            frame: source.frame.slice(),
            frameDigest: record.frameDigest,
            key,
        });
    }
    decoded.sort((left, right) => compareBytes(left.key, right.key));

    const entries: AdaptiveJournalPackEntryV1[] = [];
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
        });
        offset = nextOffset;
    }
    const packBytes = concatBytes(...decoded.map(({ frame }) => frame));
    const packId = await sha256(packBytes);
    return {
        entries,
        packBytes,
        packId,
    };
}

export function frameFromAdaptiveJournalPackV1(
    packBytes: Uint8Array,
    sourceEntry: AdaptiveJournalPackEntryV1
): Uint8Array {
    const entry = validateEntryShape(sourceEntry);
    const end = entry.offset + entry.frameLength;
    if (!Number.isSafeInteger(end) || end > packBytes.byteLength) {
        throw invalidPack("Pack entry extends beyond the available Pack bytes");
    }
    return packBytes.slice(entry.offset, end);
}
