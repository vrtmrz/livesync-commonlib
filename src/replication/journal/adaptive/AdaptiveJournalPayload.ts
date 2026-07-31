import type { DocumentID, EntryDoc, EntryLeaf } from "@lib/common/types.ts";

import {
    BinaryReader,
    boundedU64ToNumber,
    bytesEqual,
    concatBytes,
    decodeUtf8,
    u16be,
    u32be,
    u64be,
    utf8Bytes,
} from "./AdaptiveJournalBinary.ts";
import { AdaptiveJournalError, deriveRemoteChunkKeyV1, type AdaptiveJournalKeySetV1 } from "./AdaptiveJournalManifest.ts";
import {
    AdaptiveRecordKindV1,
    decodeRecordFrameV1,
    encodeRecordFrameV1,
    type AdaptiveRecordCodecPreferenceV1,
    type EncodedRecordFrameV1,
} from "./AdaptiveJournalRecord.ts";

export interface AdaptiveJournalMetadataPayloadLimitsV1 {
    maxBytes: number;
    maxDocuments: number;
    maxDocumentBytes: number;
}

export const DEFAULT_ADAPTIVE_METADATA_PAYLOAD_LIMITS_V1: Readonly<AdaptiveJournalMetadataPayloadLimitsV1> = {
    maxBytes: 16 * 1024 * 1024,
    maxDocuments: 4096,
    maxDocumentBytes: 4 * 1024 * 1024,
};

export interface AdaptiveJournalMetadataPayloadV1 {
    bytes: Uint8Array;
    documents: readonly EntryDoc[];
    localChunkIds: readonly DocumentID[];
}

export interface EncodeAdaptiveJournalMetadataRecordV1Options {
    codec?: AdaptiveRecordCodecPreferenceV1;
    documents: readonly EntryDoc[];
    iv?: Uint8Array;
    keys: AdaptiveJournalKeySetV1;
    limits?: Partial<AdaptiveJournalMetadataPayloadLimitsV1>;
    recordSalt?: Uint8Array;
    sequence: bigint;
    writerStreamId: Uint8Array;
}

export interface EncodedAdaptiveJournalMetadataRecordV1 extends EncodedRecordFrameV1 {
    documents: readonly EntryDoc[];
    localChunkIds: readonly DocumentID[];
}

export interface EncodeAdaptiveJournalChunkRecordV1Options {
    codec?: AdaptiveRecordCodecPreferenceV1;
    data: string;
    iv?: Uint8Array;
    keys: AdaptiveJournalKeySetV1;
    localChunkId: DocumentID | string;
    recordSalt?: Uint8Array;
}

export interface EncodedAdaptiveJournalChunkRecordV1 extends EncodedRecordFrameV1 {
    remoteChunkKey: Uint8Array;
}

const METADATA_MAGIC = utf8Bytes("LSAM");
const METADATA_HEADER_LENGTH = 20;

function limitsWithDefaults(
    overrides?: Partial<AdaptiveJournalMetadataPayloadLimitsV1>
): AdaptiveJournalMetadataPayloadLimitsV1 {
    const limits = { ...DEFAULT_ADAPTIVE_METADATA_PAYLOAD_LIMITS_V1, ...overrides };
    if (!Number.isSafeInteger(limits.maxBytes) || limits.maxBytes < METADATA_HEADER_LENGTH) {
        throw new RangeError(`maxBytes must be at least ${METADATA_HEADER_LENGTH}`);
    }
    if (!Number.isSafeInteger(limits.maxDocuments) || limits.maxDocuments < 0) {
        throw new RangeError("maxDocuments must be a non-negative safe integer");
    }
    if (!Number.isSafeInteger(limits.maxDocumentBytes) || limits.maxDocumentBytes < 1) {
        throw new RangeError("maxDocumentBytes must be a positive safe integer");
    }
    return limits;
}

function invalidMetadata(message: string, cause?: unknown): AdaptiveJournalError {
    return new AdaptiveJournalError(
        "invalid-metadata-payload",
        message,
        cause === undefined ? undefined : { cause }
    );
}

function requireMetadataDocument(value: unknown): EntryDoc {
    if (!value || typeof value !== "object") throw invalidMetadata("Metadata batch entry must be an object");
    const document = value as Partial<EntryDoc>;
    if (typeof document._id !== "string" || document._id.startsWith("h:")) {
        throw invalidMetadata("Metadata batch entry must have a non-Chunk document ID");
    }
    if (typeof document._rev !== "string" || document._rev.length === 0) {
        throw invalidMetadata("Metadata batch entry must preserve its PouchDB revision");
    }
    return document as EntryDoc;
}

function collectLocalChunkIds(documents: readonly EntryDoc[]): DocumentID[] {
    const ids = new Set<DocumentID>();
    for (const document of documents) {
        const candidate = document as EntryDoc & { children?: unknown };
        if (candidate.children === undefined) continue;
        if (!Array.isArray(candidate.children) || !candidate.children.every((id) => typeof id === "string")) {
            throw invalidMetadata("Metadata document children must be an array of Chunk IDs");
        }
        for (const id of candidate.children) {
            if (!id.startsWith("h:")) throw invalidMetadata("Metadata document child is not a Chunk ID");
            ids.add(id as DocumentID);
        }
    }
    return [...ids].sort((left, right) => left.localeCompare(right));
}

function validateDocumentSet(documents: readonly EntryDoc[]): readonly EntryDoc[] {
    const revisions = new Set<string>();
    return documents.map((source) => {
        const document = requireMetadataDocument(source);
        const revisionKey = `${document._id}\u0000${document._rev}`;
        if (revisions.has(revisionKey)) throw invalidMetadata("Metadata batch contains a duplicate document revision");
        revisions.add(revisionKey);
        return document;
    });
}

export function encodeAdaptiveJournalMetadataPayloadV1(
    sourceDocuments: readonly EntryDoc[],
    limitOverrides?: Partial<AdaptiveJournalMetadataPayloadLimitsV1>
): AdaptiveJournalMetadataPayloadV1 {
    const limits = limitsWithDefaults(limitOverrides);
    if (sourceDocuments.length > limits.maxDocuments) {
        throw new AdaptiveJournalError(
            "metadata-payload-limit-exceeded",
            "Metadata document count exceeds its configured limit"
        );
    }
    const documents = validateDocumentSet(sourceDocuments);
    const parts: Uint8Array[] = [];
    for (const document of documents) {
        const bytes = utf8Bytes(JSON.stringify(document));
        if (bytes.byteLength > limits.maxDocumentBytes) {
            throw new AdaptiveJournalError(
                "metadata-payload-limit-exceeded",
                "Metadata document exceeds its configured byte limit"
            );
        }
        parts.push(u32be(bytes.byteLength), bytes);
    }
    const totalLength = METADATA_HEADER_LENGTH + parts.reduce((total, part) => total + part.byteLength, 0);
    if (!Number.isSafeInteger(totalLength) || totalLength > limits.maxBytes) {
        throw new AdaptiveJournalError(
            "metadata-payload-limit-exceeded",
            "Metadata payload exceeds its configured byte limit"
        );
    }
    const header = concatBytes(
        METADATA_MAGIC,
        Uint8Array.of(1, 0),
        u16be(0),
        u32be(documents.length),
        u64be(totalLength)
    );
    return {
        bytes: concatBytes(header, ...parts),
        documents,
        localChunkIds: collectLocalChunkIds(documents),
    };
}

export function decodeAdaptiveJournalMetadataPayloadV1(
    bytes: Uint8Array,
    limitOverrides?: Partial<AdaptiveJournalMetadataPayloadLimitsV1>
): AdaptiveJournalMetadataPayloadV1 {
    const limits = limitsWithDefaults(limitOverrides);
    if (bytes.byteLength > limits.maxBytes) {
        throw new AdaptiveJournalError(
            "metadata-payload-limit-exceeded",
            "Metadata payload exceeds its configured byte limit"
        );
    }
    if (bytes.byteLength < METADATA_HEADER_LENGTH) throw invalidMetadata("Metadata payload is truncated");
    const reader = new BinaryReader(bytes);
    try {
        if (!bytesEqual(reader.readBytes(4), METADATA_MAGIC)) throw invalidMetadata("Metadata payload magic does not match");
        if (reader.readU8() !== 1) throw invalidMetadata("Metadata payload version is unsupported");
        if (reader.readU8() !== 0 || reader.readU16() !== 0) {
            throw invalidMetadata("Metadata payload flags and reserved fields must be zero");
        }
        const count = reader.readU32();
        if (count > limits.maxDocuments) {
            throw new AdaptiveJournalError(
                "metadata-payload-limit-exceeded",
                "Metadata document count exceeds its configured limit"
            );
        }
        if (reader.readU64() !== BigInt(bytes.byteLength)) {
            throw invalidMetadata("Metadata payload total length does not match its bytes");
        }
        const documents: EntryDoc[] = [];
        for (let index = 0; index < count; index += 1) {
            const length = boundedU64ToNumber(BigInt(reader.readU32()), limits.maxDocumentBytes);
            const parsed = JSON.parse(decodeUtf8(reader.readBytes(length))) as unknown;
            documents.push(requireMetadataDocument(parsed));
        }
        if (reader.remaining !== 0) throw invalidMetadata("Metadata payload contains trailing bytes");
        const validated = validateDocumentSet(documents);
        return {
            bytes: bytes.slice(),
            documents: validated,
            localChunkIds: collectLocalChunkIds(validated),
        };
    } catch (error) {
        if (error instanceof AdaptiveJournalError) throw error;
        throw invalidMetadata("Metadata payload is malformed or truncated", error);
    }
}

export async function encodeAdaptiveJournalMetadataRecordV1(
    options: EncodeAdaptiveJournalMetadataRecordV1Options
): Promise<EncodedAdaptiveJournalMetadataRecordV1> {
    const payload = encodeAdaptiveJournalMetadataPayloadV1(options.documents, options.limits);
    const frame = await encodeRecordFrameV1({
        codec: options.codec,
        iv: options.iv,
        keys: options.keys,
        kind: AdaptiveRecordKindV1.MetadataBatch,
        logicalKey: concatBytes(options.writerStreamId, u64be(options.sequence)),
        plaintext: payload.bytes,
        recordSalt: options.recordSalt,
    });
    return { ...frame, documents: payload.documents, localChunkIds: payload.localChunkIds };
}

export async function decodeAdaptiveJournalMetadataRecordV1(options: {
    bytes: Uint8Array;
    keys: AdaptiveJournalKeySetV1;
    limits?: Partial<AdaptiveJournalMetadataPayloadLimitsV1>;
    sequence: bigint;
    writerStreamId: Uint8Array;
}): Promise<AdaptiveJournalMetadataPayloadV1 & { frameDigest: Uint8Array }> {
    const frame = await decodeRecordFrameV1({
        bytes: options.bytes,
        expectedKind: AdaptiveRecordKindV1.MetadataBatch,
        keys: options.keys,
        logicalKey: concatBytes(options.writerStreamId, u64be(options.sequence)),
    });
    return { ...decodeAdaptiveJournalMetadataPayloadV1(frame.plaintext, options.limits), frameDigest: frame.frameDigest };
}

export async function encodeAdaptiveJournalChunkRecordV1(
    options: EncodeAdaptiveJournalChunkRecordV1Options
): Promise<EncodedAdaptiveJournalChunkRecordV1> {
    if (!options.localChunkId.startsWith("h:")) throw new TypeError("Adaptive Journal local Chunk ID is invalid");
    const remoteChunkKey = await deriveRemoteChunkKeyV1(options.keys, options.localChunkId);
    const frame = await encodeRecordFrameV1({
        codec: options.codec,
        iv: options.iv,
        keys: options.keys,
        kind: AdaptiveRecordKindV1.Chunk,
        logicalKey: remoteChunkKey,
        plaintext: utf8Bytes(options.data),
        recordSalt: options.recordSalt,
    });
    return { ...frame, remoteChunkKey };
}

export async function decodeAdaptiveJournalChunkRecordV1(options: {
    bytes: Uint8Array;
    keys: AdaptiveJournalKeySetV1;
    localChunkId: DocumentID | string;
}): Promise<EntryLeaf & { frameDigest: Uint8Array; remoteChunkKey: Uint8Array }> {
    if (!options.localChunkId.startsWith("h:")) throw new TypeError("Adaptive Journal local Chunk ID is invalid");
    const remoteChunkKey = await deriveRemoteChunkKeyV1(options.keys, options.localChunkId);
    const frame = await decodeRecordFrameV1({
        bytes: options.bytes,
        expectedKind: AdaptiveRecordKindV1.Chunk,
        keys: options.keys,
        logicalKey: remoteChunkKey,
    });
    return {
        _id: options.localChunkId as DocumentID,
        data: decodeUtf8(frame.plaintext),
        frameDigest: frame.frameDigest,
        remoteChunkKey,
        type: "leaf",
    };
}
