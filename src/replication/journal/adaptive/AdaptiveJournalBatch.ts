import {
    BinaryReader,
    boundedU64ToNumber,
    bytesEqual,
    concatBytes,
    fixedLength,
    u16be,
    u32be,
    u64be,
    utf8Bytes,
} from "./AdaptiveJournalBinary.ts";
import { AdaptiveJournalError } from "./AdaptiveJournalManifest.ts";

export enum AdaptiveBatchOperationV1 {
    Has = 0x01,
    Get = 0x02,
    Put = 0x03,
}

export interface AdaptiveBatchLimitsV1 {
    maxBytes: number;
    maxEntries: number;
}

export const DEFAULT_ADAPTIVE_BATCH_LIMITS_V1: Readonly<AdaptiveBatchLimitsV1> = {
    maxBytes: 64 * 1024 * 1024,
    maxEntries: 4096,
};

export type AdaptiveHasRequestV1 = {
    entries: readonly { key: Uint8Array }[];
    operation: AdaptiveBatchOperationV1.Has;
};

export type AdaptiveGetRequestV1 = {
    entries: readonly { key: Uint8Array }[];
    operation: AdaptiveBatchOperationV1.Get;
};

export type AdaptivePutRequestV1 = {
    entries: readonly { frame: Uint8Array; frameDigest: Uint8Array; key: Uint8Array }[];
    operation: AdaptiveBatchOperationV1.Put;
};

export type AdaptiveBatchRequestV1 = AdaptiveHasRequestV1 | AdaptiveGetRequestV1 | AdaptivePutRequestV1;

export type AdaptiveHasResponseV1 = {
    entries: readonly { status: "missing" | "present" }[];
    operation: AdaptiveBatchOperationV1.Has;
};

export type AdaptiveGetResponseV1 = {
    entries: readonly (
        | { status: "missing" }
        | { frame: Uint8Array; frameDigest: Uint8Array; status: "found" }
    )[];
    operation: AdaptiveBatchOperationV1.Get;
};

export type AdaptivePutResponseV1 = {
    entries: readonly { status: "exact-existing" | "inserted" | "validate-existing" }[];
    operation: AdaptiveBatchOperationV1.Put;
};

export type AdaptiveBatchResponseV1 = AdaptiveHasResponseV1 | AdaptiveGetResponseV1 | AdaptivePutResponseV1;

const BATCH_MAGIC = utf8Bytes("LSAB");
const BATCH_HEADER_LENGTH = 20;
const RESPONSE_FLAG = 0x0001;

function limitsWithDefaults(overrides?: Partial<AdaptiveBatchLimitsV1>): AdaptiveBatchLimitsV1 {
    const limits = { ...DEFAULT_ADAPTIVE_BATCH_LIMITS_V1, ...overrides };
    if (!Number.isSafeInteger(limits.maxBytes) || limits.maxBytes < BATCH_HEADER_LENGTH) {
        throw new RangeError(`maxBytes must be at least ${BATCH_HEADER_LENGTH}`);
    }
    if (!Number.isSafeInteger(limits.maxEntries) || limits.maxEntries < 0) {
        throw new RangeError("maxEntries must be a non-negative safe integer");
    }
    return limits;
}

function validateOperation(operation: number): AdaptiveBatchOperationV1 {
    if (
        operation !== AdaptiveBatchOperationV1.Has &&
        operation !== AdaptiveBatchOperationV1.Get &&
        operation !== AdaptiveBatchOperationV1.Put
    ) {
        throw new AdaptiveJournalError(
            "unsupported-batch-operation",
            `Unsupported Adaptive Journal batch operation ${operation}`
        );
    }
    return operation;
}

function createEnvelope(
    operation: AdaptiveBatchOperationV1,
    response: boolean,
    entryCount: number,
    parts: readonly Uint8Array[],
    limits: AdaptiveBatchLimitsV1
): Uint8Array {
    if (entryCount > limits.maxEntries) {
        throw new AdaptiveJournalError("batch-limit-exceeded", "Batch entry count exceeds its configured limit");
    }
    const bodyLength = parts.reduce((total, part) => total + part.byteLength, 0);
    const totalLength = BATCH_HEADER_LENGTH + bodyLength;
    if (!Number.isSafeInteger(totalLength) || totalLength > limits.maxBytes) {
        throw new AdaptiveJournalError("batch-limit-exceeded", "Batch byte length exceeds its configured limit");
    }
    const header = concatBytes(
        BATCH_MAGIC,
        Uint8Array.of(1, operation),
        u16be(response ? RESPONSE_FLAG : 0),
        u32be(entryCount),
        u64be(totalLength)
    );
    return concatBytes(header, ...parts);
}

function keyBytes(bytes: Uint8Array): Uint8Array {
    return fixedLength(bytes, 32, "remote Chunk key");
}

function digestBytes(bytes: Uint8Array): Uint8Array {
    return fixedLength(bytes, 32, "frame digest");
}

export function encodeBatchRequestV1(
    request: AdaptiveBatchRequestV1,
    limitOverrides?: Partial<AdaptiveBatchLimitsV1>
): Uint8Array {
    const limits = limitsWithDefaults(limitOverrides);
    const parts: Uint8Array[] = [];
    if (request.operation === AdaptiveBatchOperationV1.Has || request.operation === AdaptiveBatchOperationV1.Get) {
        for (const entry of request.entries) parts.push(keyBytes(entry.key));
    } else {
        for (const entry of request.entries) {
            parts.push(keyBytes(entry.key), digestBytes(entry.frameDigest), u64be(entry.frame.byteLength), entry.frame);
        }
    }
    return createEnvelope(request.operation, false, request.entries.length, parts, limits);
}

export function encodeBatchResponseV1(
    response: AdaptiveBatchResponseV1,
    limitOverrides?: Partial<AdaptiveBatchLimitsV1>
): Uint8Array {
    const limits = limitsWithDefaults(limitOverrides);
    const parts: Uint8Array[] = [];
    if (response.operation === AdaptiveBatchOperationV1.Has) {
        for (const entry of response.entries) parts.push(Uint8Array.of(entry.status === "missing" ? 0 : 1));
    } else if (response.operation === AdaptiveBatchOperationV1.Get) {
        for (const entry of response.entries) {
            if (entry.status === "missing") {
                parts.push(Uint8Array.of(0));
            } else {
                parts.push(
                    Uint8Array.of(1),
                    digestBytes(entry.frameDigest),
                    u64be(entry.frame.byteLength),
                    entry.frame
                );
            }
        }
    } else {
        const statuses = {
            "exact-existing": 1,
            inserted: 0,
            "validate-existing": 2,
        } as const;
        for (const entry of response.entries) parts.push(Uint8Array.of(statuses[entry.status]));
    }
    return createEnvelope(response.operation, true, response.entries.length, parts, limits);
}

type ParsedBatchHeader = {
    entryCount: number;
    operation: AdaptiveBatchOperationV1;
    reader: BinaryReader;
};

function invalidEnvelope(message: string, cause?: unknown): AdaptiveJournalError {
    return new AdaptiveJournalError("invalid-batch-envelope", message, cause === undefined ? undefined : { cause });
}

function parseHeader(
    bytes: Uint8Array,
    expectedResponse: boolean,
    limitOverrides?: Partial<AdaptiveBatchLimitsV1>
): ParsedBatchHeader {
    const limits = limitsWithDefaults(limitOverrides);
    if (bytes.byteLength > limits.maxBytes) {
        throw new AdaptiveJournalError("batch-limit-exceeded", "Batch byte length exceeds its configured limit");
    }
    if (bytes.byteLength < BATCH_HEADER_LENGTH) throw invalidEnvelope("Batch envelope is truncated");
    const reader = new BinaryReader(bytes);
    try {
        if (!bytesEqual(reader.readBytes(4), BATCH_MAGIC)) throw invalidEnvelope("Batch magic does not match");
        const version = reader.readU8();
        if (version !== 1) {
            throw new AdaptiveJournalError(
                "unsupported-batch-version",
                `Unsupported Adaptive Journal batch version ${version}`
            );
        }
        const operation = validateOperation(reader.readU8());
        const flags = reader.readU16();
        if ((flags & ~RESPONSE_FLAG) !== 0) throw invalidEnvelope("Batch envelope contains unsupported flags");
        if (((flags & RESPONSE_FLAG) !== 0) !== expectedResponse) {
            throw new AdaptiveJournalError(
                "unexpected-batch-direction",
                expectedResponse ? "Expected a batch response" : "Expected a batch request"
            );
        }
        const entryCount = reader.readU32();
        if (entryCount > limits.maxEntries) {
            throw new AdaptiveJournalError("batch-limit-exceeded", "Batch entry count exceeds its configured limit");
        }
        const totalLength = reader.readU64();
        if (totalLength > BigInt(limits.maxBytes)) {
            throw new AdaptiveJournalError("batch-limit-exceeded", "Batch byte length exceeds its configured limit");
        }
        if (totalLength !== BigInt(bytes.byteLength)) {
            throw invalidEnvelope("Batch total length does not match the supplied bytes");
        }
        return { entryCount, operation, reader };
    } catch (error) {
        if (error instanceof AdaptiveJournalError) throw error;
        throw invalidEnvelope("Batch header is invalid or truncated", error);
    }
}

function readFrame(reader: BinaryReader, maximum: number): Uint8Array {
    let length: number;
    try {
        length = boundedU64ToNumber(reader.readU64(), maximum);
    } catch (error) {
        if (error instanceof RangeError && error.message.includes("configured limit")) {
            throw new AdaptiveJournalError("batch-limit-exceeded", "Batch frame exceeds its configured byte limit", {
                cause: error,
            });
        }
        throw error;
    }
    return reader.readBytes(length);
}

function requireComplete(reader: BinaryReader): void {
    if (reader.remaining !== 0) throw invalidEnvelope("Batch envelope contains trailing bytes");
}

export function decodeBatchRequestV1(
    bytes: Uint8Array,
    limitOverrides?: Partial<AdaptiveBatchLimitsV1>
): AdaptiveBatchRequestV1 {
    const limits = limitsWithDefaults(limitOverrides);
    const { entryCount, operation, reader } = parseHeader(bytes, false, limits);
    try {
        if (operation === AdaptiveBatchOperationV1.Has) {
            const entries = Array.from({ length: entryCount }, () => ({ key: reader.readBytes(32) }));
            requireComplete(reader);
            return { entries, operation };
        }
        if (operation === AdaptiveBatchOperationV1.Get) {
            const entries = Array.from({ length: entryCount }, () => ({ key: reader.readBytes(32) }));
            requireComplete(reader);
            return { entries, operation };
        }
        const entries = Array.from({ length: entryCount }, () => ({
            key: reader.readBytes(32),
            frameDigest: reader.readBytes(32),
            frame: readFrame(reader, limits.maxBytes),
        }));
        requireComplete(reader);
        return { entries, operation };
    } catch (error) {
        if (error instanceof AdaptiveJournalError) throw error;
        throw invalidEnvelope("Batch request entries are invalid or truncated", error);
    }
}

export function decodeBatchResponseV1(
    bytes: Uint8Array,
    limitOverrides?: Partial<AdaptiveBatchLimitsV1>
): AdaptiveBatchResponseV1 {
    const limits = limitsWithDefaults(limitOverrides);
    const { entryCount, operation, reader } = parseHeader(bytes, true, limits);
    try {
        if (operation === AdaptiveBatchOperationV1.Has) {
            const entries = Array.from({ length: entryCount }, () => {
                const status = reader.readU8();
                if (status === 0) return { status: "missing" as const };
                if (status === 1) return { status: "present" as const };
                throw invalidEnvelope(`Invalid HAS response status ${status}`);
            });
            requireComplete(reader);
            return { entries, operation };
        }
        if (operation === AdaptiveBatchOperationV1.Get) {
            const entries = Array.from({ length: entryCount }, () => {
                const status = reader.readU8();
                if (status === 0) return { status: "missing" as const };
                if (status === 1) {
                    return {
                        status: "found" as const,
                        frameDigest: reader.readBytes(32),
                        frame: readFrame(reader, limits.maxBytes),
                    };
                }
                throw invalidEnvelope(`Invalid GET response status ${status}`);
            });
            requireComplete(reader);
            return { entries, operation };
        }
        const statusNames = ["inserted", "exact-existing", "validate-existing"] as const;
        const entries = Array.from({ length: entryCount }, () => {
            const status = reader.readU8();
            const statusName = statusNames[status];
            if (!statusName) throw invalidEnvelope(`Invalid PUT response status ${status}`);
            return { status: statusName };
        });
        requireComplete(reader);
        return { entries, operation };
    } catch (error) {
        if (error instanceof AdaptiveJournalError) throw error;
        throw invalidEnvelope("Batch response entries are invalid or truncated", error);
    }
}
