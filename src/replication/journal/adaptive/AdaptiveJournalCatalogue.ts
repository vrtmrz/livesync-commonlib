import { base64UrlToBytes, bytesEqual, bytesToBase64Url, bytesToHex, fixedLength } from "./AdaptiveJournalBinary.ts";
import type { AdaptiveJournalCommitPackV1 } from "./AdaptiveJournalControl.ts";
import { AdaptiveJournalError } from "./AdaptiveJournalManifest.ts";
import type { AdaptiveJournalPackEntryV1 } from "./AdaptiveJournalPack.ts";

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

function invalidCatalogue(message: string, cause?: unknown): AdaptiveJournalError {
    return new AdaptiveJournalError("invalid-catalogue-record", message, cause === undefined ? undefined : { cause });
}

export const ADAPTIVE_JOURNAL_WRITER_OBJECT_PREFIX_V1 = "a1~writer~";

export function adaptiveJournalWriterObjectKeyV1(writerStreamId: Uint8Array): string {
    return `${ADAPTIVE_JOURNAL_WRITER_OBJECT_PREFIX_V1}${opaqueId(writerStreamId, "writerStreamId")}.writer`;
}

export function adaptiveJournalPackObjectKeyV1(packId: Uint8Array): string {
    return `a1~pack~${opaqueId(packId, "packId")}.bin`;
}

export function adaptiveJournalCommitObjectKeyV1(writerStreamId: Uint8Array, sequence: bigint): string {
    return `a1~commit~${opaqueId(writerStreamId, "writerStreamId")}~${sequenceText(sequence)}.commit`;
}

export function adaptiveJournalCommitObjectPrefixV1(writerStreamId: Uint8Array): string {
    return `a1~commit~${opaqueId(writerStreamId, "writerStreamId")}~`;
}

export interface AdaptiveJournalCommitObjectRouteV1 {
    sequence: bigint;
    writerStreamId: Uint8Array;
}

export function parseAdaptiveJournalCommitObjectKeyV1(key: string): AdaptiveJournalCommitObjectRouteV1 {
    const match = /^a1~commit~([A-Za-z0-9_-]{43})~([0-9]{20})\.commit$/u.exec(key);
    if (!match) throw invalidCatalogue("Commit Bundle object key is invalid");
    try {
        const writerStreamId = fixedLength(base64UrlToBytes(match[1]), 32, "writerStreamId");
        const sequence = BigInt(match[2]);
        if (key !== adaptiveJournalCommitObjectKeyV1(writerStreamId, sequence)) {
            throw invalidCatalogue("Commit Bundle object key is not canonical");
        }
        return { sequence, writerStreamId };
    } catch (error) {
        if (error instanceof AdaptiveJournalError) throw error;
        throw invalidCatalogue("Commit Bundle object key is invalid", error);
    }
}

export interface AdaptiveJournalPackLocationV1 extends AdaptiveJournalPackEntryV1 {
    container: "bundle" | "pack";
    objectKey: string;
    packBytes: number;
    packId: Uint8Array;
}

export class AdaptiveJournalCatalogueV1 {
    private readonly byChunk = new Map<string, AdaptiveJournalPackLocationV1[]>();
    private readonly byObject = new Map<
        string,
        Pick<AdaptiveJournalPackLocationV1, "container" | "objectKey" | "packBytes" | "packId">
    >();

    get size(): number {
        return this.byChunk.size;
    }

    applyCommittedPack(route: AdaptiveJournalCommitPackV1): void {
        this.applyCommittedPacks([route]);
    }

    applyCommittedPacks(routes: readonly AdaptiveJournalCommitPackV1[]): void {
        const additions = new Map<string, AdaptiveJournalPackLocationV1[]>();
        const objectAdditions = new Map<
            string,
            Pick<AdaptiveJournalPackLocationV1, "container" | "objectKey" | "packBytes" | "packId">
        >();
        for (const route of routes) {
            const packId = fixedLength(route.packId, 32, "packId").slice();
            if (!Number.isSafeInteger(route.packBytes) || route.packBytes < 1 || route.packBytes > MAX_PACK_BYTES_V1) {
                throw invalidCatalogue("Committed Pack byte length is invalid");
            }
            if (route.container === "pack") {
                if (route.objectKey !== adaptiveJournalPackObjectKeyV1(packId)) {
                    throw invalidCatalogue("Committed Pack object key does not match its digest");
                }
            } else if (route.container === "bundle") {
                parseAdaptiveJournalCommitObjectKeyV1(route.objectKey);
            } else {
                throw invalidCatalogue("Committed Pack container is invalid");
            }
            if (route.entries.length === 0) throw invalidCatalogue("Committed Pack route must contain an entry");
            const existingObject = this.byObject.get(route.objectKey) ?? objectAdditions.get(route.objectKey);
            if (
                existingObject &&
                (existingObject.container !== route.container ||
                    existingObject.packBytes !== route.packBytes ||
                    !bytesEqual(existingObject.packId, packId))
            ) {
                throw invalidCatalogue("Committed Pack route conflicts with an existing object identity");
            }
            if (!existingObject) {
                objectAdditions.set(route.objectKey, {
                    container: route.container,
                    objectKey: route.objectKey,
                    packBytes: route.packBytes,
                    packId: packId.slice(),
                });
            }
            for (const entry of route.entries) {
                const key = fixedLength(entry.key, 32, "remote Chunk key").slice();
                const frameDigest = fixedLength(entry.frameDigest, 32, "frameDigest").slice();
                if (
                    !Number.isSafeInteger(entry.offset) ||
                    entry.offset < 0 ||
                    !Number.isSafeInteger(entry.frameLength) ||
                    entry.frameLength < 1 ||
                    entry.offset + entry.frameLength > route.packBytes
                ) {
                    throw invalidCatalogue("Committed Pack entry extends beyond the Pack");
                }
                const keyHex = bytesToHex(key);
                const existing = [...(this.byChunk.get(keyHex) ?? []), ...(additions.get(keyHex) ?? [])].find(
                    (location) => location.objectKey === route.objectKey
                );
                if (existing) {
                    if (
                        existing.container !== route.container ||
                        existing.packBytes !== route.packBytes ||
                        !bytesEqual(existing.packId, packId) ||
                        existing.offset !== entry.offset ||
                        existing.frameLength !== entry.frameLength ||
                        !bytesEqual(existing.frameDigest, frameDigest)
                    ) {
                        throw invalidCatalogue("Committed Pack route conflicts with an existing catalogue entry");
                    }
                    continue;
                }
                const pending = additions.get(keyHex) ?? [];
                pending.push({
                    container: route.container,
                    frameDigest,
                    frameLength: entry.frameLength,
                    key,
                    objectKey: route.objectKey,
                    offset: entry.offset,
                    packBytes: route.packBytes,
                    packId: packId.slice(),
                });
                additions.set(keyHex, pending);
            }
        }
        for (const [objectKey, identity] of objectAdditions) this.byObject.set(objectKey, identity);
        for (const [keyHex, pending] of additions) {
            this.byChunk.set(keyHex, [...(this.byChunk.get(keyHex) ?? []), ...pending]);
        }
    }

    locations(key: Uint8Array): readonly AdaptiveJournalPackLocationV1[] {
        return (this.byChunk.get(bytesToHex(fixedLength(key, 32, "remote Chunk key"))) ?? []).map((location) => ({
            ...location,
            frameDigest: location.frameDigest.slice(),
            key: location.key.slice(),
            packId: location.packId.slice(),
        }));
    }

    routes(keys: readonly Uint8Array[]): readonly AdaptiveJournalCommitPackV1[] | undefined {
        const grouped = new Map<string, AdaptiveJournalCommitPackV1>();
        for (const key of keys) {
            const location = this.locations(key)[0];
            if (!location) return undefined;
            const entry: AdaptiveJournalPackEntryV1 = {
                frameDigest: location.frameDigest.slice(),
                frameLength: location.frameLength,
                key: location.key.slice(),
                offset: location.offset,
            };
            const existing = grouped.get(location.objectKey);
            if (existing) {
                grouped.set(location.objectKey, { ...existing, entries: [...existing.entries, entry] });
            } else {
                grouped.set(location.objectKey, {
                    container: location.container,
                    entries: [entry],
                    objectKey: location.objectKey,
                    packBytes: location.packBytes,
                    packId: location.packId.slice(),
                });
            }
        }
        return [...grouped.values()];
    }
}
