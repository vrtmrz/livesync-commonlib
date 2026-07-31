import {
    base64UrlToBytes,
    bytesEqual,
    bytesToBase64Url,
    canonicalJsonBytes,
    decodeUtf8,
    fixedLength,
    utf8Bytes,
} from "./AdaptiveJournalBinary.ts";
import {
    AdaptiveJournalError,
    type AdaptiveJournalKeySetV1,
    deriveWriterStreamIdV1,
} from "./AdaptiveJournalManifest.ts";
import {
    AdaptiveRecordKindV1,
    type AdaptiveRecordCodecPreferenceV1,
    decodeRecordFrameV1,
    encodeRecordFrameV1,
} from "./AdaptiveJournalRecord.ts";

const MAX_WRITER_IDENTITY_BYTES = 1024;

export interface AdaptiveJournalWriterDescriptorPayloadV1 {
    formatVersion: 1;
    hostId: string;
    repositoryId: string;
    writerEpoch: string;
    writerStreamId: string;
}

export interface EncodeAdaptiveJournalWriterDescriptorV1Options {
    codec?: AdaptiveRecordCodecPreferenceV1;
    hostId: string;
    iv?: Uint8Array;
    keys: AdaptiveJournalKeySetV1;
    recordSalt?: Uint8Array;
    writerEpoch: string;
}

export interface EncodedAdaptiveJournalWriterDescriptorV1 {
    bytes: Uint8Array;
    digest: Uint8Array;
    payload: AdaptiveJournalWriterDescriptorPayloadV1;
    writerStreamId: Uint8Array;
}

export interface DecodeAdaptiveJournalWriterDescriptorV1Options {
    bytes: Uint8Array;
    keys: AdaptiveJournalKeySetV1;
    writerStreamId: Uint8Array;
}

function invalidWriterDescriptor(message: string, cause?: unknown): AdaptiveJournalError {
    return new AdaptiveJournalError("invalid-writer-descriptor", message, cause === undefined ? undefined : { cause });
}

function requireIdentityPart(value: string, name: string): void {
    const byteLength = utf8Bytes(value).byteLength;
    if (byteLength === 0 || byteLength > MAX_WRITER_IDENTITY_BYTES) {
        throw invalidWriterDescriptor(`${name} must contain between 1 and ${MAX_WRITER_IDENTITY_BYTES} UTF-8 bytes`);
    }
}

function exactObjectKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
    const actual = Object.keys(value).sort();
    return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function decodeOpaqueId(value: unknown, name: string): Uint8Array {
    if (typeof value !== "string") throw invalidWriterDescriptor(`${name} must be Base64URL text`);
    try {
        return fixedLength(base64UrlToBytes(value), 32, name);
    } catch (error) {
        throw invalidWriterDescriptor(`${name} must encode exactly 32 bytes`, error);
    }
}

function parseWriterDescriptorPayload(bytes: Uint8Array): AdaptiveJournalWriterDescriptorPayloadV1 {
    let parsed: unknown;
    try {
        parsed = JSON.parse(decodeUtf8(bytes));
    } catch (error) {
        throw invalidWriterDescriptor("Writer descriptor payload is not valid UTF-8 JSON", error);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw invalidWriterDescriptor("Writer descriptor payload must be an object");
    }
    const payload = parsed as Record<string, unknown>;
    if (
        !exactObjectKeys(payload, ["formatVersion", "hostId", "repositoryId", "writerEpoch", "writerStreamId"]) ||
        payload.formatVersion !== 1 ||
        typeof payload.hostId !== "string" ||
        typeof payload.writerEpoch !== "string"
    ) {
        throw invalidWriterDescriptor("Writer descriptor payload fields do not match v1");
    }
    requireIdentityPart(payload.hostId, "hostId");
    requireIdentityPart(payload.writerEpoch, "writerEpoch");
    decodeOpaqueId(payload.repositoryId, "repositoryId");
    decodeOpaqueId(payload.writerStreamId, "writerStreamId");
    if (!bytesEqual(bytes, canonicalJsonBytes(parsed))) {
        throw invalidWriterDescriptor("Writer descriptor payload is not canonical JSON");
    }
    return parsed as AdaptiveJournalWriterDescriptorPayloadV1;
}

export async function encodeAdaptiveJournalWriterDescriptorV1(
    options: EncodeAdaptiveJournalWriterDescriptorV1Options
): Promise<EncodedAdaptiveJournalWriterDescriptorV1> {
    requireIdentityPart(options.hostId, "hostId");
    requireIdentityPart(options.writerEpoch, "writerEpoch");
    const writerStreamId = await deriveWriterStreamIdV1(options.keys, options.hostId, options.writerEpoch);
    const payload: AdaptiveJournalWriterDescriptorPayloadV1 = {
        formatVersion: 1,
        hostId: options.hostId,
        repositoryId: bytesToBase64Url(options.keys.repositoryId),
        writerEpoch: options.writerEpoch,
        writerStreamId: bytesToBase64Url(writerStreamId),
    };
    const encoded = await encodeRecordFrameV1({
        codec: options.codec,
        iv: options.iv,
        keys: options.keys,
        kind: AdaptiveRecordKindV1.WriterDescriptor,
        logicalKey: writerStreamId,
        plaintext: canonicalJsonBytes(payload),
        recordSalt: options.recordSalt,
    });
    return {
        bytes: encoded.bytes,
        digest: encoded.digest,
        payload,
        writerStreamId,
    };
}

export async function decodeAdaptiveJournalWriterDescriptorV1(
    options: DecodeAdaptiveJournalWriterDescriptorV1Options
): Promise<{ digest: Uint8Array; payload: AdaptiveJournalWriterDescriptorPayloadV1 }> {
    const writerStreamId = fixedLength(options.writerStreamId, 32, "writerStreamId");
    const decoded = await decodeRecordFrameV1({
        bytes: options.bytes,
        expectedKind: AdaptiveRecordKindV1.WriterDescriptor,
        keys: options.keys,
        logicalKey: writerStreamId,
    });
    const payload = parseWriterDescriptorPayload(decoded.plaintext);
    const payloadRepositoryId = decodeOpaqueId(payload.repositoryId, "repositoryId");
    const payloadWriterStreamId = decodeOpaqueId(payload.writerStreamId, "writerStreamId");
    const derivedWriterStreamId = await deriveWriterStreamIdV1(options.keys, payload.hostId, payload.writerEpoch);
    if (
        !bytesEqual(payloadRepositoryId, options.keys.repositoryId) ||
        !bytesEqual(payloadWriterStreamId, writerStreamId) ||
        !bytesEqual(derivedWriterStreamId, writerStreamId)
    ) {
        throw invalidWriterDescriptor("Writer descriptor identity does not match its logical route");
    }
    return { digest: decoded.frameDigest, payload };
}
