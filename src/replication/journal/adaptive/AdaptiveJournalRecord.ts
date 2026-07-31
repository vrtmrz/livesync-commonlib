import { deflateSync, inflateSync } from "fflate";

import { getWebCrypto } from "@lib/mods.ts";

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
import {
    AdaptiveJournalError,
    adaptiveJournalRoleKeyV1,
    hkdfSha256,
    sha256,
    type AdaptiveJournalKeySetV1,
    type AdaptiveJournalRoleV1,
} from "./AdaptiveJournalManifest.ts";

export enum AdaptiveRecordKindV1 {
    Chunk = 0x01,
    MetadataBatch = 0x03,
    WriterDescriptor = 0x06,
    Commit = 0x07,
}

export type AdaptiveRecordCodecPreferenceV1 = "auto" | "deflate" | "none";
export type AdaptiveRecordCodecV1 = Exclude<AdaptiveRecordCodecPreferenceV1, "auto">;

export interface AdaptiveRecordLimitsV1 {
    maxFrameBytes: number;
    maxPayloadBytes: number;
    maxPlaintextBytes: number;
}

export const DEFAULT_ADAPTIVE_RECORD_LIMITS_V1: Readonly<AdaptiveRecordLimitsV1> = {
    maxFrameBytes: 64 * 1024 * 1024 + 92,
    maxPayloadBytes: 64 * 1024 * 1024 + 16,
    maxPlaintextBytes: 64 * 1024 * 1024,
};

export interface EncodeRecordFrameV1Options {
    codec?: AdaptiveRecordCodecPreferenceV1;
    iv?: Uint8Array;
    keys: AdaptiveJournalKeySetV1;
    kind: AdaptiveRecordKindV1;
    limits?: Partial<AdaptiveRecordLimitsV1>;
    logicalKey: Uint8Array;
    plaintext: Uint8Array;
    recordSalt?: Uint8Array;
}

export interface DecodeRecordFrameV1Options {
    bytes: Uint8Array;
    expectedKind: AdaptiveRecordKindV1;
    keys: AdaptiveJournalKeySetV1;
    limits?: Partial<AdaptiveRecordLimitsV1>;
    logicalKey: Uint8Array;
}

export interface EncodedRecordFrameV1 {
    bytes: Uint8Array;
    codec: AdaptiveRecordCodecV1;
    digest: Uint8Array;
}

export interface DecodedRecordFrameV1 {
    codec: AdaptiveRecordCodecV1;
    frameDigest: Uint8Array;
    kind: AdaptiveRecordKindV1;
    plaintext: Uint8Array;
}

const RECORD_MAGIC = utf8Bytes("LSAR");
const RECORD_PREFIX_LENGTH = 20;
const ENCRYPTED_HEADER_LENGTH = 56;
const UNENCRYPTED_HEADER_LENGTH = 44;
const ENCRYPTED_FLAG = 0x0001;
const GCM_TAG_BYTES = 16;
const RECORD_AAD_DOMAIN = utf8Bytes("livesync/adaptive-journal/record-aad/v1");
const RECORD_KDF_DOMAIN = utf8Bytes("livesync/adaptive-journal/record/v1");

const recordRoles = new Map<AdaptiveRecordKindV1, AdaptiveJournalRoleV1>([
    [AdaptiveRecordKindV1.Chunk, "chunk-record"],
    [AdaptiveRecordKindV1.MetadataBatch, "metadata-record"],
    [AdaptiveRecordKindV1.WriterDescriptor, "writer-record"],
    [AdaptiveRecordKindV1.Commit, "commit-record"],
]);

const logicalKeyLengths = new Map<AdaptiveRecordKindV1, number>([
    [AdaptiveRecordKindV1.Chunk, 32],
    [AdaptiveRecordKindV1.MetadataBatch, 40],
    [AdaptiveRecordKindV1.WriterDescriptor, 32],
    [AdaptiveRecordKindV1.Commit, 40],
]);

function limitsWithDefaults(overrides?: Partial<AdaptiveRecordLimitsV1>): AdaptiveRecordLimitsV1 {
    const limits = { ...DEFAULT_ADAPTIVE_RECORD_LIMITS_V1, ...overrides };
    for (const [name, value] of Object.entries(limits)) {
        if (!Number.isSafeInteger(value) || value < 1) {
            throw new RangeError(`${name} must be a positive safe integer`);
        }
    }
    return limits;
}

function validateKindAndLogicalKey(kind: AdaptiveRecordKindV1, logicalKey: Uint8Array): AdaptiveJournalRoleV1 {
    const role = recordRoles.get(kind);
    const expectedLength = logicalKeyLengths.get(kind);
    if (!role || expectedLength === undefined) {
        throw new AdaptiveJournalError("unsupported-record-kind", `Unsupported Adaptive Journal record kind ${kind}`);
    }
    if (logicalKey.byteLength !== expectedLength) {
        throw new AdaptiveJournalError(
            "invalid-record-frame",
            `Logical key for record kind ${kind} must be ${expectedLength} bytes`
        );
    }
    return role;
}

function codecByte(codec: AdaptiveRecordCodecV1): number {
    return codec === "none" ? 0x00 : 0x01;
}

function codecFromByte(value: number): AdaptiveRecordCodecV1 {
    if (value === 0x00) return "none";
    if (value === 0x01) return "deflate";
    throw new AdaptiveJournalError("unsupported-record-codec", `Unsupported Adaptive Journal record codec ${value}`);
}

function selectStoredPayload(
    plaintext: Uint8Array,
    preference: AdaptiveRecordCodecPreferenceV1
): { codec: AdaptiveRecordCodecV1; stored: Uint8Array } {
    if (preference === "none") return { codec: "none", stored: plaintext.slice() };
    const compressed = deflateSync(plaintext);
    if (preference === "deflate" || compressed.byteLength < plaintext.byteLength) {
        return { codec: "deflate", stored: compressed };
    }
    return { codec: "none", stored: plaintext.slice() };
}

function createPrefix(
    kind: AdaptiveRecordKindV1,
    flags: number,
    publicHeaderLength: number,
    payloadLength: number
): Uint8Array {
    return concatBytes(
        RECORD_MAGIC,
        Uint8Array.of(1, kind),
        u16be(flags),
        u32be(publicHeaderLength),
        u64be(payloadLength)
    );
}

function recordAad(
    repositoryId: Uint8Array,
    logicalKey: Uint8Array,
    prefix: Uint8Array,
    publicHeader: Uint8Array
): Uint8Array {
    return concatBytes(
        RECORD_AAD_DOMAIN,
        fixedLength(repositoryId, 32, "repositoryId"),
        u16be(logicalKey.byteLength),
        logicalKey,
        fixedLength(prefix, RECORD_PREFIX_LENGTH, "record prefix"),
        publicHeader
    );
}

async function recordKey(
    keys: AdaptiveJournalKeySetV1,
    role: AdaptiveJournalRoleV1,
    kind: AdaptiveRecordKindV1,
    logicalKey: Uint8Array,
    recordSalt: Uint8Array
): Promise<Uint8Array> {
    return await hkdfSha256(
        adaptiveJournalRoleKeyV1(keys, role),
        recordSalt,
        concatBytes(RECORD_KDF_DOMAIN, Uint8Array.of(kind), u16be(logicalKey.byteLength), logicalKey)
    );
}

async function secureRandom(length: number): Promise<Uint8Array> {
    const crypto = await getWebCrypto();
    const bytes = new Uint8Array(length);
    crypto.getRandomValues(bytes);
    return bytes;
}

function owned(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
    return new Uint8Array(bytes);
}

async function encryptPayload(
    keyBytes: Uint8Array,
    iv: Uint8Array,
    aad: Uint8Array,
    plaintext: Uint8Array
): Promise<Uint8Array> {
    const crypto = await getWebCrypto();
    const key = await crypto.subtle.importKey("raw", owned(keyBytes), "AES-GCM", false, ["encrypt"]);
    return new Uint8Array(
        await crypto.subtle.encrypt(
            { additionalData: owned(aad), iv: owned(iv), name: "AES-GCM", tagLength: 128 },
            key,
            owned(plaintext)
        )
    );
}

async function decryptPayload(
    keyBytes: Uint8Array,
    iv: Uint8Array,
    aad: Uint8Array,
    payload: Uint8Array
): Promise<Uint8Array> {
    const crypto = await getWebCrypto();
    const key = await crypto.subtle.importKey("raw", owned(keyBytes), "AES-GCM", false, ["decrypt"]);
    try {
        return new Uint8Array(
            await crypto.subtle.decrypt(
                { additionalData: owned(aad), iv: owned(iv), name: "AES-GCM", tagLength: 128 },
                key,
                owned(payload)
            )
        );
    } catch (error) {
        throw new AdaptiveJournalError("record-integrity-failed", "Encrypted record authentication failed", {
            cause: error,
        });
    }
}

function decodeStoredPayload(
    codec: AdaptiveRecordCodecV1,
    stored: Uint8Array,
    expectedPlaintextLength: number
): Uint8Array {
    let plaintext: Uint8Array;
    try {
        plaintext = codec === "none" ? stored.slice() : inflateSync(stored);
    } catch (error) {
        throw new AdaptiveJournalError("record-decompression-failed", "Record payload could not be decompressed", {
            cause: error,
        });
    }
    if (plaintext.byteLength !== expectedPlaintextLength) {
        throw new AdaptiveJournalError("invalid-record-frame", "Decoded record length does not match its header");
    }
    return plaintext;
}

export async function encodeRecordFrameV1(options: EncodeRecordFrameV1Options): Promise<EncodedRecordFrameV1> {
    const role = validateKindAndLogicalKey(options.kind, options.logicalKey);
    const limits = limitsWithDefaults(options.limits);
    if (options.plaintext.byteLength > limits.maxPlaintextBytes) {
        throw new AdaptiveJournalError("record-limit-exceeded", "Record plaintext exceeds its configured limit");
    }
    const { codec, stored } = selectStoredPayload(options.plaintext, options.codec ?? "auto");
    let publicHeader: Uint8Array;
    let payload: Uint8Array;
    let prefix: Uint8Array;
    if (options.keys.encryption === "encrypted") {
        const recordSalt = fixedLength(options.recordSalt?.slice() ?? (await secureRandom(32)), 32, "recordSalt");
        const iv = fixedLength(options.iv?.slice() ?? (await secureRandom(12)), 12, "iv");
        publicHeader = concatBytes(
            Uint8Array.of(codecByte(codec), 0, 0, 0),
            u64be(options.plaintext.byteLength),
            recordSalt,
            iv
        );
        prefix = createPrefix(options.kind, ENCRYPTED_FLAG, ENCRYPTED_HEADER_LENGTH, stored.byteLength + GCM_TAG_BYTES);
        const key = await recordKey(options.keys, role, options.kind, options.logicalKey, recordSalt);
        payload = await encryptPayload(
            key,
            iv,
            recordAad(options.keys.repositoryId, options.logicalKey, prefix, publicHeader),
            stored
        );
        key.fill(0);
    } else {
        const payloadDigest = await sha256(stored);
        publicHeader = concatBytes(
            Uint8Array.of(codecByte(codec), 0, 0, 0),
            u64be(options.plaintext.byteLength),
            payloadDigest
        );
        payload = stored;
        prefix = createPrefix(options.kind, 0, UNENCRYPTED_HEADER_LENGTH, payload.byteLength);
    }
    if (payload.byteLength > limits.maxPayloadBytes) {
        throw new AdaptiveJournalError("record-limit-exceeded", "Record payload exceeds its configured limit");
    }
    const bytes = concatBytes(prefix, publicHeader, payload);
    if (bytes.byteLength > limits.maxFrameBytes) {
        throw new AdaptiveJournalError("record-limit-exceeded", "Record frame exceeds its configured limit");
    }
    return { bytes, codec, digest: await sha256(bytes) };
}

function invalidFrame(message: string, cause?: unknown): AdaptiveJournalError {
    return new AdaptiveJournalError("invalid-record-frame", message, cause === undefined ? undefined : { cause });
}

export async function decodeRecordFrameV1(options: DecodeRecordFrameV1Options): Promise<DecodedRecordFrameV1> {
    const limits = limitsWithDefaults(options.limits);
    if (options.bytes.byteLength > limits.maxFrameBytes) {
        throw new AdaptiveJournalError("record-limit-exceeded", "Record frame exceeds its configured limit");
    }
    if (options.bytes.byteLength < RECORD_PREFIX_LENGTH) throw invalidFrame("Record frame is truncated");
    const reader = new BinaryReader(options.bytes);
    let version: number;
    let kind: AdaptiveRecordKindV1;
    let flags: number;
    let publicHeaderLength: number;
    let payloadLength: number;
    try {
        if (!bytesEqual(reader.readBytes(4), RECORD_MAGIC)) throw invalidFrame("Record magic does not match");
        version = reader.readU8();
        kind = reader.readU8() as AdaptiveRecordKindV1;
        flags = reader.readU16();
        publicHeaderLength = reader.readU32();
        payloadLength = boundedU64ToNumber(reader.readU64(), limits.maxPayloadBytes);
    } catch (error) {
        if (error instanceof AdaptiveJournalError) throw error;
        if (error instanceof RangeError && error.message.includes("configured limit")) {
            throw new AdaptiveJournalError("record-limit-exceeded", "Record payload exceeds its configured limit", {
                cause: error,
            });
        }
        throw invalidFrame("Record prefix is invalid or truncated", error);
    }
    if (version !== 1) {
        throw new AdaptiveJournalError(
            "unsupported-record-version",
            `Unsupported Adaptive Journal record version ${version}`
        );
    }
    validateKindAndLogicalKey(kind, options.logicalKey);
    if (kind !== options.expectedKind) throw invalidFrame("Record kind does not match the expected logical route");
    if ((flags & ~ENCRYPTED_FLAG) !== 0) throw invalidFrame("Record frame contains unsupported flags");
    const encrypted = (flags & ENCRYPTED_FLAG) !== 0;
    if (encrypted !== (options.keys.encryption === "encrypted")) {
        throw new AdaptiveJournalError("encryption-mode-mismatch", "Record encryption does not match the repository");
    }
    const expectedHeaderLength = encrypted ? ENCRYPTED_HEADER_LENGTH : UNENCRYPTED_HEADER_LENGTH;
    if (publicHeaderLength !== expectedHeaderLength) throw invalidFrame("Record public header length is invalid");
    if (reader.remaining !== publicHeaderLength + payloadLength) {
        throw invalidFrame("Record frame length does not match its declared lengths");
    }
    const prefix = options.bytes.slice(0, RECORD_PREFIX_LENGTH);
    const publicHeader = reader.readBytes(publicHeaderLength);
    const payload = reader.readBytes(payloadLength);
    const headerReader = new BinaryReader(publicHeader);
    let codec: AdaptiveRecordCodecV1;
    let plaintextLength: number;
    try {
        codec = codecFromByte(headerReader.readU8());
        if (!bytesEqual(headerReader.readBytes(3), Uint8Array.of(0, 0, 0))) {
            throw invalidFrame("Record reserved header bytes are not zero");
        }
        plaintextLength = boundedU64ToNumber(headerReader.readU64(), limits.maxPlaintextBytes);
    } catch (error) {
        if (error instanceof AdaptiveJournalError) throw error;
        if (error instanceof RangeError && error.message.includes("configured limit")) {
            throw new AdaptiveJournalError("record-limit-exceeded", "Record plaintext exceeds its configured limit", {
                cause: error,
            });
        }
        throw invalidFrame("Record public header is invalid", error);
    }
    let stored: Uint8Array;
    if (encrypted) {
        const recordSalt = headerReader.readBytes(32);
        const iv = headerReader.readBytes(12);
        if (payload.byteLength < GCM_TAG_BYTES) throw invalidFrame("Encrypted record payload is too short");
        const role = validateKindAndLogicalKey(kind, options.logicalKey);
        const key = await recordKey(options.keys, role, kind, options.logicalKey, recordSalt);
        stored = await decryptPayload(
            key,
            iv,
            recordAad(options.keys.repositoryId, options.logicalKey, prefix, publicHeader),
            payload
        );
        key.fill(0);
    } else {
        const expectedPayloadDigest = headerReader.readBytes(32);
        if (!bytesEqual(expectedPayloadDigest, await sha256(payload))) {
            throw new AdaptiveJournalError("record-integrity-failed", "Public record payload digest does not match");
        }
        stored = payload;
    }
    if (headerReader.remaining !== 0) throw invalidFrame("Record public header contains trailing bytes");
    return {
        codec,
        frameDigest: await sha256(options.bytes),
        kind,
        plaintext: decodeStoredPayload(codec, stored, plaintextLength),
    };
}
