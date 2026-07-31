import {
    BinaryReader,
    boundedU64ToNumber,
    bytesEqual,
    bytesToHex,
    concatBytes,
    fixedLength,
    u16be,
    u32be,
    u64be,
    utf8Bytes,
} from "./AdaptiveJournalBinary.ts";
import { AdaptiveJournalError, sha256 } from "./AdaptiveJournalManifest.ts";

export interface AdaptiveCommitLimitsV1 {
    maxBytes: number;
    maxCommitFrameBytes: number;
    maxRequiredChunkKeys: number;
}

export const DEFAULT_ADAPTIVE_COMMIT_LIMITS_V1: Readonly<AdaptiveCommitLimitsV1> = {
    maxBytes: 64 * 1024 * 1024,
    maxCommitFrameBytes: 8 * 1024 * 1024,
    maxRequiredChunkKeys: 4096,
};

export interface EncodeCommitEnvelopeV1Options {
    commitFrame: Uint8Array;
    limits?: Partial<AdaptiveCommitLimitsV1>;
    metadataDigest: Uint8Array;
    previousCommitDigest: Uint8Array | null;
    repositoryId: Uint8Array;
    requiredChunkKeys: readonly Uint8Array[];
    sequence: bigint;
    writerStreamId: Uint8Array;
}

export interface EncodedCommitEnvelopeV1 {
    bytes: Uint8Array;
    commitFrameDigest: Uint8Array;
    digest: Uint8Array;
    requiredChunkKeys: readonly Uint8Array[];
    requiredChunkKeysDigest: Uint8Array;
}

export interface DecodedCommitEnvelopeV1 {
    commitFrame: Uint8Array;
    commitFrameDigest: Uint8Array;
    digest: Uint8Array;
    metadataDigest: Uint8Array;
    metadataLogicalKey: Uint8Array;
    previousCommitDigest: Uint8Array | null;
    repositoryId: Uint8Array;
    requiredChunkKeys: readonly Uint8Array[];
    requiredChunkKeysDigest: Uint8Array;
    sequence: bigint;
    writerStreamId: Uint8Array;
}

const COMMIT_MAGIC = utf8Bytes("LSAC");
const COMMIT_FIXED_LENGTH = 244;
const MAX_WRITER_SEQUENCE = 0x7fffffffffffffffn;

function limitsWithDefaults(overrides?: Partial<AdaptiveCommitLimitsV1>): AdaptiveCommitLimitsV1 {
    const limits = { ...DEFAULT_ADAPTIVE_COMMIT_LIMITS_V1, ...overrides };
    if (!Number.isSafeInteger(limits.maxBytes) || limits.maxBytes < COMMIT_FIXED_LENGTH) {
        throw new RangeError(`maxBytes must be at least ${COMMIT_FIXED_LENGTH}`);
    }
    if (!Number.isSafeInteger(limits.maxCommitFrameBytes) || limits.maxCommitFrameBytes < 1) {
        throw new RangeError("maxCommitFrameBytes must be a positive safe integer");
    }
    if (!Number.isSafeInteger(limits.maxRequiredChunkKeys) || limits.maxRequiredChunkKeys < 0) {
        throw new RangeError("maxRequiredChunkKeys must be a non-negative safe integer");
    }
    return limits;
}

function validateSequence(sequence: bigint): void {
    if (sequence < 1n || sequence > MAX_WRITER_SEQUENCE) {
        throw new AdaptiveJournalError(
            "invalid-commit-envelope",
            "Adaptive Journal writer sequence must be a positive 63-bit integer"
        );
    }
}

function compareBytes(left: Uint8Array, right: Uint8Array): number {
    for (let index = 0; index < Math.min(left.byteLength, right.byteLength); index += 1) {
        if (left[index] !== right[index]) return left[index] - right[index];
    }
    return left.byteLength - right.byteLength;
}

function canonicalRequiredKeys(keys: readonly Uint8Array[]): Uint8Array[] {
    const byHex = new Map<string, Uint8Array>();
    for (const key of keys) {
        const validated = fixedLength(key, 32, "required remote Chunk key");
        byHex.set(bytesToHex(validated), validated.slice());
    }
    return [...byHex.values()].sort(compareBytes);
}

export async function digestAdaptiveJournalRequiredChunkKeysV1(
    keys: readonly Uint8Array[],
    maxRequiredChunkKeys = DEFAULT_ADAPTIVE_COMMIT_LIMITS_V1.maxRequiredChunkKeys
): Promise<{ digest: Uint8Array; keys: readonly Uint8Array[] }> {
    const canonical = canonicalRequiredKeys(keys);
    if (canonical.length > maxRequiredChunkKeys) {
        throw new AdaptiveJournalError(
            "commit-limit-exceeded",
            "Commit required Chunk key count exceeds its configured limit"
        );
    }
    return { digest: await sha256(concatBytes(...canonical)), keys: canonical };
}

function invalidCommit(message: string, cause?: unknown): AdaptiveJournalError {
    return new AdaptiveJournalError("invalid-commit-envelope", message, cause === undefined ? undefined : { cause });
}

export async function encodeCommitEnvelopeV1(
    options: EncodeCommitEnvelopeV1Options
): Promise<EncodedCommitEnvelopeV1> {
    const limits = limitsWithDefaults(options.limits);
    validateSequence(options.sequence);
    const repositoryId = fixedLength(options.repositoryId, 32, "repositoryId");
    const writerStreamId = fixedLength(options.writerStreamId, 32, "writerStreamId");
    const metadataDigest = fixedLength(options.metadataDigest, 32, "metadataDigest");
    const previousCommitDigest =
        options.previousCommitDigest === null
            ? null
            : fixedLength(options.previousCommitDigest, 32, "previousCommitDigest");
    const requiredChunkKeySet = await digestAdaptiveJournalRequiredChunkKeysV1(
        options.requiredChunkKeys,
        limits.maxRequiredChunkKeys
    );
    const requiredChunkKeys = requiredChunkKeySet.keys;
    if (options.commitFrame.byteLength > limits.maxCommitFrameBytes) {
        throw new AdaptiveJournalError("commit-limit-exceeded", "Commit frame exceeds its configured limit");
    }
    const requiredChunkKeyBytes = concatBytes(...requiredChunkKeys);
    const requiredChunkKeysDigest = requiredChunkKeySet.digest;
    const metadataLogicalKey = concatBytes(writerStreamId, u64be(options.sequence));
    const totalLength = COMMIT_FIXED_LENGTH + requiredChunkKeyBytes.byteLength + options.commitFrame.byteLength;
    if (!Number.isSafeInteger(totalLength) || totalLength > limits.maxBytes) {
        throw new AdaptiveJournalError("commit-limit-exceeded", "Commit envelope exceeds its configured byte limit");
    }
    const previousSection = concatBytes(
        Uint8Array.of(previousCommitDigest === null ? 0 : 1),
        new Uint8Array(7),
        previousCommitDigest ?? new Uint8Array(32)
    );
    const bytes = concatBytes(
        COMMIT_MAGIC,
        Uint8Array.of(1, 0),
        u16be(0),
        u64be(totalLength),
        repositoryId,
        writerStreamId,
        u64be(options.sequence),
        previousSection,
        u32be(requiredChunkKeys.length),
        requiredChunkKeysDigest,
        metadataLogicalKey,
        metadataDigest,
        u64be(options.commitFrame.byteLength),
        requiredChunkKeyBytes,
        options.commitFrame
    );
    return {
        bytes,
        commitFrameDigest: await sha256(options.commitFrame),
        digest: await sha256(bytes),
        requiredChunkKeys,
        requiredChunkKeysDigest,
    };
}

export async function decodeCommitEnvelopeV1(
    bytes: Uint8Array,
    limitOverrides?: Partial<AdaptiveCommitLimitsV1>
): Promise<DecodedCommitEnvelopeV1> {
    const limits = limitsWithDefaults(limitOverrides);
    if (bytes.byteLength > limits.maxBytes) {
        throw new AdaptiveJournalError("commit-limit-exceeded", "Commit envelope exceeds its configured byte limit");
    }
    if (bytes.byteLength < COMMIT_FIXED_LENGTH) throw invalidCommit("Commit envelope is truncated");
    const reader = new BinaryReader(bytes);
    try {
        if (!bytesEqual(reader.readBytes(4), COMMIT_MAGIC)) throw invalidCommit("Commit envelope magic does not match");
        const version = reader.readU8();
        if (version !== 1) {
            throw new AdaptiveJournalError(
                "unsupported-commit-version",
                `Unsupported Adaptive Journal commit envelope version ${version}`
            );
        }
        if (reader.readU8() !== 0 || reader.readU16() !== 0) {
            throw invalidCommit("Commit envelope flags and reserved fields must be zero");
        }
        const totalLength = reader.readU64();
        if (totalLength !== BigInt(bytes.byteLength)) {
            throw invalidCommit("Commit envelope total length does not match its bytes");
        }
        const repositoryId = reader.readBytes(32);
        const writerStreamId = reader.readBytes(32);
        const sequence = reader.readU64();
        validateSequence(sequence);
        const previousPresent = reader.readU8();
        if (!bytesEqual(reader.readBytes(7), new Uint8Array(7))) {
            throw invalidCommit("Commit predecessor reserved bytes must be zero");
        }
        const previousBytes = reader.readBytes(32);
        let previousCommitDigest: Uint8Array | null;
        if (previousPresent === 0) {
            if (!bytesEqual(previousBytes, new Uint8Array(32))) {
                throw invalidCommit("Absent commit predecessor digest must be zero");
            }
            previousCommitDigest = null;
        } else if (previousPresent === 1) {
            previousCommitDigest = previousBytes;
        } else {
            throw invalidCommit("Commit predecessor presence flag is invalid");
        }
        const requiredKeyCount = reader.readU32();
        if (requiredKeyCount > limits.maxRequiredChunkKeys) {
            throw new AdaptiveJournalError(
                "commit-limit-exceeded",
                "Commit required Chunk key count exceeds its configured limit"
            );
        }
        const requiredChunkKeysDigest = reader.readBytes(32);
        const metadataLogicalKey = reader.readBytes(40);
        const expectedMetadataLogicalKey = concatBytes(writerStreamId, u64be(sequence));
        if (!bytesEqual(metadataLogicalKey, expectedMetadataLogicalKey)) {
            throw invalidCommit("Commit metadata logical key does not match its writer and sequence");
        }
        const metadataDigest = reader.readBytes(32);
        const commitFrameLength = boundedU64ToNumber(reader.readU64(), limits.maxCommitFrameBytes);
        const requiredChunkKeys: Uint8Array[] = [];
        for (let index = 0; index < requiredKeyCount; index += 1) {
            const key = reader.readBytes(32);
            if (requiredChunkKeys.length > 0 && compareBytes(requiredChunkKeys.at(-1)!, key) >= 0) {
                throw invalidCommit("Commit required Chunk keys must be strictly increasing and unique");
            }
            requiredChunkKeys.push(key);
        }
        const commitFrame = reader.readBytes(commitFrameLength);
        if (reader.remaining !== 0) throw invalidCommit("Commit envelope contains trailing bytes");
        if (!bytesEqual(requiredChunkKeysDigest, await sha256(concatBytes(...requiredChunkKeys)))) {
            throw invalidCommit("Commit required Chunk key digest does not match its key set");
        }
        return {
            commitFrame,
            commitFrameDigest: await sha256(commitFrame),
            digest: await sha256(bytes),
            metadataDigest,
            metadataLogicalKey,
            previousCommitDigest,
            repositoryId,
            requiredChunkKeys,
            requiredChunkKeysDigest,
            sequence,
            writerStreamId,
        };
    } catch (error) {
        if (error instanceof AdaptiveJournalError) throw error;
        if (error instanceof RangeError && error.message.includes("configured limit")) {
            throw new AdaptiveJournalError("commit-limit-exceeded", "Commit envelope field exceeds its configured limit", {
                cause: error,
            });
        }
        throw invalidCommit("Commit envelope is malformed or truncated", error);
    }
}
