import {
    base64UrlToBytes,
    bytesEqual,
    bytesToBase64Url,
    bytesToHex,
    canonicalJsonBytes,
    concatBytes,
    decodeUtf8,
    fixedLength,
    u64be,
} from "./AdaptiveJournalBinary.ts";
import { AdaptiveJournalError, type AdaptiveJournalKeySetV1 } from "./AdaptiveJournalManifest.ts";
import type { AdaptiveJournalCommitDependencyV1 } from "./AdaptiveJournalControl.ts";
import type { AdaptiveJournalPackIndexEntryV1 } from "./AdaptiveJournalPack.ts";
import {
    AdaptiveRecordKindV1,
    decodeRecordFrameV1,
    encodeRecordFrameV1,
    type AdaptiveRecordCodecPreferenceV1,
} from "./AdaptiveJournalRecord.ts";

const MAX_WRITER_SEQUENCE = 0x7fffffffffffffffn;
const MAX_PACK_BYTES_V1 = 256 * 1024 * 1024;

function sequenceText(sequence: bigint): string {
    if (sequence < 1n || sequence > MAX_WRITER_SEQUENCE) {
        throw new RangeError("Adaptive Journal sequence must be a positive 63-bit integer");
    }
    return sequence.toString(10).padStart(20, "0");
}

function opaqueId(value: Uint8Array, label: string): string {
    return bytesToBase64Url(fixedLength(value, 32, label));
}

export const ADAPTIVE_JOURNAL_WRITER_OBJECT_PREFIX_V1 = "a1~writer~";

export function adaptiveJournalWriterObjectKeyV1(writerStreamId: Uint8Array): string {
    return `${ADAPTIVE_JOURNAL_WRITER_OBJECT_PREFIX_V1}${opaqueId(writerStreamId, "writerStreamId")}.writer`;
}

export function adaptiveJournalPackObjectKeyV1(packId: Uint8Array): string {
    return `a1~pack~${opaqueId(packId, "packId")}.bin`;
}

export function adaptiveJournalIndexObjectKeyV1(packId: Uint8Array): string {
    return `a1~index~${opaqueId(packId, "packId")}.idx`;
}

function sequencedObjectKey(
    kind: "commit" | "delta" | "metadata",
    writerStreamId: Uint8Array,
    sequence: bigint,
    extension: "batch" | "commit" | "delta"
): string {
    return `a1~${kind}~${opaqueId(writerStreamId, "writerStreamId")}~${sequenceText(sequence)}.${extension}`;
}

export function adaptiveJournalDeltaObjectKeyV1(writerStreamId: Uint8Array, sequence: bigint): string {
    return sequencedObjectKey("delta", writerStreamId, sequence, "delta");
}

export function adaptiveJournalMetadataObjectKeyV1(writerStreamId: Uint8Array, sequence: bigint): string {
    return sequencedObjectKey("metadata", writerStreamId, sequence, "batch");
}

export function adaptiveJournalCommitObjectKeyV1(writerStreamId: Uint8Array, sequence: bigint): string {
    return sequencedObjectKey("commit", writerStreamId, sequence, "commit");
}

export function adaptiveJournalCommitObjectPrefixV1(writerStreamId: Uint8Array): string {
    return `a1~commit~${opaqueId(writerStreamId, "writerStreamId")}~`;
}

export interface AdaptiveJournalCatalogueDeltaPayloadV1 {
    add: {
        indexDigest: string;
        indexKey: string;
        packBytes: number;
        packId: string;
    };
    formatVersion: 1;
    repositoryId: string;
    sequence: string;
    writerStreamId: string;
}

export interface EncodeAdaptiveJournalCatalogueDeltaV1Options {
    codec?: AdaptiveRecordCodecPreferenceV1;
    indexDigest: Uint8Array;
    indexKey: string;
    keys: AdaptiveJournalKeySetV1;
    packBytes: number;
    packId: Uint8Array;
    recordIv?: Uint8Array;
    recordSalt?: Uint8Array;
    sequence: bigint;
    writerStreamId: Uint8Array;
}

export interface EncodedAdaptiveJournalCatalogueDeltaV1 {
    bytes: Uint8Array;
    digest: Uint8Array;
    key: string;
    payload: AdaptiveJournalCatalogueDeltaPayloadV1;
}

export interface DecodeAdaptiveJournalCatalogueDeltaV1Options {
    bytes: Uint8Array;
    keys: AdaptiveJournalKeySetV1;
    sequence: bigint;
    writerStreamId: Uint8Array;
}

function logicalKey(writerStreamId: Uint8Array, sequence: bigint): Uint8Array {
    sequenceText(sequence);
    return concatBytes(fixedLength(writerStreamId, 32, "writerStreamId"), u64be(sequence));
}

function invalidCatalogue(message: string, cause?: unknown): AdaptiveJournalError {
    return new AdaptiveJournalError("invalid-catalogue-record", message, cause === undefined ? undefined : { cause });
}

export interface AdaptiveJournalDeltaObjectRouteV1 {
    sequence: bigint;
    writerStreamId: Uint8Array;
}

export function parseAdaptiveJournalDeltaObjectKeyV1(key: string): AdaptiveJournalDeltaObjectRouteV1 {
    const match = /^a1~delta~([A-Za-z0-9_-]{43})~([0-9]{20})\.delta$/u.exec(key);
    if (!match) throw invalidCatalogue("Catalogue delta object key is invalid");
    try {
        const writerStreamId = fixedLength(base64UrlToBytes(match[1]), 32, "writerStreamId");
        const sequence = BigInt(match[2]);
        if (key !== adaptiveJournalDeltaObjectKeyV1(writerStreamId, sequence)) {
            throw invalidCatalogue("Catalogue delta object key is not canonical");
        }
        return { sequence, writerStreamId };
    } catch (error) {
        if (error instanceof AdaptiveJournalError) throw error;
        throw invalidCatalogue("Catalogue delta object key is invalid", error);
    }
}

function parseDeltaPayload(bytes: Uint8Array): AdaptiveJournalCatalogueDeltaPayloadV1 {
    let parsed: unknown;
    try {
        parsed = JSON.parse(decodeUtf8(bytes));
    } catch (error) {
        throw invalidCatalogue("Catalogue delta payload is not valid UTF-8 JSON", error);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw invalidCatalogue("Catalogue delta payload must be an object");
    }
    const payload = parsed as Record<string, unknown>;
    if (
        JSON.stringify(Object.keys(payload).sort()) !==
        JSON.stringify(["add", "formatVersion", "repositoryId", "sequence", "writerStreamId"])
    ) {
        throw invalidCatalogue("Catalogue delta fields do not match v1");
    }
    if (!payload.add || typeof payload.add !== "object" || Array.isArray(payload.add)) {
        throw invalidCatalogue("Catalogue delta add field must be an object");
    }
    const add = payload.add as Record<string, unknown>;
    if (
        JSON.stringify(Object.keys(add).sort()) !== JSON.stringify(["indexDigest", "indexKey", "packBytes", "packId"])
    ) {
        throw invalidCatalogue("Catalogue delta add fields do not match v1");
    }
    if (
        payload.formatVersion !== 1 ||
        typeof payload.repositoryId !== "string" ||
        typeof payload.sequence !== "string" ||
        typeof payload.writerStreamId !== "string" ||
        typeof add.indexDigest !== "string" ||
        typeof add.indexKey !== "string" ||
        typeof add.packId !== "string" ||
        typeof add.packBytes !== "number" ||
        !Number.isSafeInteger(add.packBytes) ||
        add.packBytes < 1 ||
        add.packBytes > MAX_PACK_BYTES_V1
    ) {
        throw invalidCatalogue("Catalogue delta contains invalid v1 field values");
    }
    if (!bytesEqual(bytes, canonicalJsonBytes(parsed))) {
        throw invalidCatalogue("Catalogue delta payload is not canonical JSON");
    }
    return parsed as AdaptiveJournalCatalogueDeltaPayloadV1;
}

function validateDeltaRoute(
    payload: AdaptiveJournalCatalogueDeltaPayloadV1,
    keys: AdaptiveJournalKeySetV1,
    writerStreamId: Uint8Array,
    sequence: bigint
): void {
    let packId: Uint8Array;
    let indexDigest: Uint8Array;
    try {
        packId = fixedLength(base64UrlToBytes(payload.add.packId), 32, "packId");
        indexDigest = fixedLength(base64UrlToBytes(payload.add.indexDigest), 32, "indexDigest");
    } catch (error) {
        throw invalidCatalogue("Catalogue delta contains an invalid opaque ID or digest", error);
    }
    void indexDigest;
    if (
        payload.repositoryId !== bytesToBase64Url(keys.repositoryId) ||
        payload.writerStreamId !== bytesToBase64Url(writerStreamId) ||
        payload.sequence !== sequenceText(sequence) ||
        payload.add.indexKey !== adaptiveJournalIndexObjectKeyV1(packId)
    ) {
        throw invalidCatalogue("Catalogue delta identity does not match its logical route");
    }
}

export async function encodeAdaptiveJournalCatalogueDeltaV1(
    options: EncodeAdaptiveJournalCatalogueDeltaV1Options
): Promise<EncodedAdaptiveJournalCatalogueDeltaV1> {
    const writerStreamId = fixedLength(options.writerStreamId, 32, "writerStreamId");
    const packId = fixedLength(options.packId, 32, "packId");
    const indexDigest = fixedLength(options.indexDigest, 32, "indexDigest");
    if (!Number.isSafeInteger(options.packBytes) || options.packBytes < 1 || options.packBytes > MAX_PACK_BYTES_V1) {
        throw new RangeError("packBytes must be a positive safe integer within the v1 pack limit");
    }
    if (options.indexKey !== adaptiveJournalIndexObjectKeyV1(packId)) {
        throw invalidCatalogue("Catalogue index key does not match its pack ID");
    }
    const payload: AdaptiveJournalCatalogueDeltaPayloadV1 = {
        add: {
            indexDigest: bytesToBase64Url(indexDigest),
            indexKey: options.indexKey,
            packBytes: options.packBytes,
            packId: bytesToBase64Url(packId),
        },
        formatVersion: 1,
        repositoryId: bytesToBase64Url(options.keys.repositoryId),
        sequence: sequenceText(options.sequence),
        writerStreamId: bytesToBase64Url(writerStreamId),
    };
    const encoded = await encodeRecordFrameV1({
        codec: options.codec,
        iv: options.recordIv,
        keys: options.keys,
        kind: AdaptiveRecordKindV1.CatalogueDelta,
        logicalKey: logicalKey(writerStreamId, options.sequence),
        plaintext: canonicalJsonBytes(payload),
        recordSalt: options.recordSalt,
    });
    return {
        bytes: encoded.bytes,
        digest: encoded.digest,
        key: adaptiveJournalDeltaObjectKeyV1(writerStreamId, options.sequence),
        payload,
    };
}

export async function decodeAdaptiveJournalCatalogueDeltaV1(
    options: DecodeAdaptiveJournalCatalogueDeltaV1Options
): Promise<{ digest: Uint8Array; payload: AdaptiveJournalCatalogueDeltaPayloadV1 }> {
    const writerStreamId = fixedLength(options.writerStreamId, 32, "writerStreamId");
    const decoded = await decodeRecordFrameV1({
        bytes: options.bytes,
        expectedKind: AdaptiveRecordKindV1.CatalogueDelta,
        keys: options.keys,
        logicalKey: logicalKey(writerStreamId, options.sequence),
    });
    const payload = parseDeltaPayload(decoded.plaintext);
    validateDeltaRoute(payload, options.keys, writerStreamId, options.sequence);
    return { digest: decoded.frameDigest, payload };
}

export interface AdaptiveJournalPackLocationV1 extends AdaptiveJournalPackIndexEntryV1 {
    catalogueDependency?: AdaptiveJournalCommitDependencyV1;
    packId: Uint8Array;
}

export class AdaptiveJournalCatalogueV1 {
    private readonly byChunk = new Map<string, AdaptiveJournalPackLocationV1[]>();
    private readonly dependencies = new Map<string, Uint8Array>();

    get size(): number {
        return this.byChunk.size;
    }

    applyCommittedPack(
        packIdSource: Uint8Array,
        entries: readonly AdaptiveJournalPackIndexEntryV1[],
        catalogueDependency?: AdaptiveJournalCommitDependencyV1
    ): void {
        const packId = fixedLength(packIdSource, 32, "packId").slice();
        const packText = bytesToBase64Url(packId);
        const dependency = catalogueDependency
            ? {
                  digest: fixedLength(catalogueDependency.digest, 32, "catalogue delta digest").slice(),
                  key: catalogueDependency.key,
              }
            : undefined;
        if (dependency) {
            parseAdaptiveJournalDeltaObjectKeyV1(dependency.key);
            const knownDigest = this.dependencies.get(dependency.key);
            if (knownDigest && !bytesEqual(knownDigest, dependency.digest)) {
                throw invalidCatalogue("Catalogue delta key was applied with a different digest");
            }
            this.dependencies.set(dependency.key, dependency.digest.slice());
        }
        for (const entry of entries) {
            const key = fixedLength(entry.key, 32, "remote Chunk key").slice();
            const keyHex = bytesToHex(key);
            const locations = this.byChunk.get(keyHex) ?? [];
            const existing = locations.find((location) => bytesToBase64Url(location.packId) === packText);
            if (existing) {
                if (!existing.catalogueDependency && dependency) {
                    existing.catalogueDependency = {
                        digest: dependency.digest.slice(),
                        key: dependency.key,
                    };
                }
                continue;
            }
            locations.push({
                ...(dependency
                    ? {
                          catalogueDependency: {
                              digest: dependency.digest.slice(),
                              key: dependency.key,
                          },
                      }
                    : {}),
                frameDigest: fixedLength(entry.frameDigest, 32, "frameDigest").slice(),
                frameLength: entry.frameLength,
                key,
                offset: entry.offset,
                packId: packId.slice(),
                plaintextLength: entry.plaintextLength,
            });
            this.byChunk.set(keyHex, locations);
        }
    }

    locations(key: Uint8Array): readonly AdaptiveJournalPackLocationV1[] {
        return (this.byChunk.get(bytesToHex(fixedLength(key, 32, "remote Chunk key"))) ?? []).map((location) => ({
            ...location,
            ...(location.catalogueDependency
                ? {
                      catalogueDependency: {
                          digest: location.catalogueDependency.digest.slice(),
                          key: location.catalogueDependency.key,
                      },
                  }
                : {}),
            frameDigest: location.frameDigest.slice(),
            key: location.key.slice(),
            packId: location.packId.slice(),
        }));
    }

    hasDependency(dependency: AdaptiveJournalCommitDependencyV1): boolean {
        const knownDigest = this.dependencies.get(dependency.key);
        return (
            knownDigest !== undefined &&
            bytesEqual(knownDigest, fixedLength(dependency.digest, 32, "catalogue delta digest"))
        );
    }
}
