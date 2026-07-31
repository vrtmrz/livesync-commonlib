import { bytesEqual, fixedLength } from "./AdaptiveJournalBinary.ts";
import type { AdaptiveJournalObjectRemoteV1 } from "./AdaptiveJournalObjectStore.ts";
import type { AdaptiveJournalPackIndexEntryV1 } from "./AdaptiveJournalPack.ts";

interface VerifiedMetadataPublicationV1 {
    bytes: number;
    digest: Uint8Array;
}

export interface VerifiedAdaptiveJournalPackPublicationV1 {
    deltaDigest: Uint8Array;
    deltaKey: string;
    entries: readonly AdaptiveJournalPackIndexEntryV1[];
    packId: Uint8Array;
}

function cloneEntry(entry: AdaptiveJournalPackIndexEntryV1): AdaptiveJournalPackIndexEntryV1 {
    return {
        frameDigest: entry.frameDigest.slice(),
        frameLength: entry.frameLength,
        key: entry.key.slice(),
        offset: entry.offset,
        plaintextLength: entry.plaintextLength,
    };
}

/**
 * Retains small, process-local evidence for immutable objects accepted during one publication session.
 *
 * The cache avoids immediate read-back after an acknowledged conditional create. It is deliberately
 * non-durable: after restart, the object event store verifies dependencies from the remote before it
 * publishes the final Commit.
 */
export class AdaptiveJournalObjectPublicationCacheV1 {
    private readonly metadata = new Map<string, VerifiedMetadataPublicationV1>();
    private readonly packs = new Map<string, VerifiedAdaptiveJournalPackPublicationV1>();

    constructor(readonly remote: AdaptiveJournalObjectRemoteV1) {}

    requireRemote(remote: AdaptiveJournalObjectRemoteV1): void {
        if (remote !== this.remote) {
            throw new TypeError("Adaptive Journal publication cache belongs to a different object remote");
        }
    }

    rememberMetadata(key: string, digestSource: Uint8Array, bytes: number): void {
        if (!Number.isSafeInteger(bytes) || bytes < 0) {
            throw new RangeError("Adaptive Journal Metadata byte length must be a non-negative safe integer");
        }
        const digest = fixedLength(digestSource, 32, "metadataDigest");
        this.metadata.set(key, { bytes, digest: digest.slice() });
    }

    hasMetadata(key: string, digestSource: Uint8Array, bytes: number): boolean {
        const expected = this.metadata.get(key);
        return (
            expected !== undefined &&
            expected.bytes === bytes &&
            bytesEqual(expected.digest, fixedLength(digestSource, 32, "metadataDigest"))
        );
    }

    rememberPack(publication: VerifiedAdaptiveJournalPackPublicationV1): void {
        const deltaDigest = fixedLength(publication.deltaDigest, 32, "deltaDigest");
        const packId = fixedLength(publication.packId, 32, "packId");
        this.packs.set(publication.deltaKey, {
            deltaDigest: deltaDigest.slice(),
            deltaKey: publication.deltaKey,
            entries: publication.entries.map(cloneEntry),
            packId: packId.slice(),
        });
    }

    packForDelta(deltaKey: string, digestSource: Uint8Array): VerifiedAdaptiveJournalPackPublicationV1 | undefined {
        const publication = this.packs.get(deltaKey);
        if (!publication || !bytesEqual(publication.deltaDigest, fixedLength(digestSource, 32, "deltaDigest"))) {
            return undefined;
        }
        return {
            deltaDigest: publication.deltaDigest.slice(),
            deltaKey: publication.deltaKey,
            entries: publication.entries.map(cloneEntry),
            packId: publication.packId.slice(),
        };
    }

    acceptCommit(metadataKey: string, deltaKeys: readonly string[]): void {
        this.metadata.delete(metadataKey);
        for (const key of deltaKeys) this.packs.delete(key);
    }
}
