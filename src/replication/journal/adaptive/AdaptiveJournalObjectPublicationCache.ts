import { bytesEqual, fixedLength } from "./AdaptiveJournalBinary.ts";
import type { AdaptiveJournalCommitPackV1 } from "./AdaptiveJournalControl.ts";
import type { AdaptiveJournalObjectRemoteV1 } from "./AdaptiveJournalObjectStore.ts";

export interface VerifiedAdaptiveJournalPackPublicationV1 {
    objectKey: string;
    packBytes: number;
    packId: Uint8Array;
}

/**
 * Retains process-local evidence for acknowledged immutable Pack creates.
 *
 * The evidence avoids an immediate read-back before the Commit Bundle is created. It is
 * deliberately non-durable; recovery verifies a staged Bundle against the remote objects.
 */
export class AdaptiveJournalObjectPublicationCacheV1 {
    private readonly packs = new Map<string, VerifiedAdaptiveJournalPackPublicationV1>();

    constructor(readonly remote: AdaptiveJournalObjectRemoteV1) {}

    requireRemote(remote: AdaptiveJournalObjectRemoteV1): void {
        if (remote !== this.remote) {
            throw new TypeError("Adaptive Journal publication cache belongs to a different object remote");
        }
    }

    rememberPack(publication: VerifiedAdaptiveJournalPackPublicationV1): void {
        const packId = fixedLength(publication.packId, 32, "packId");
        if (!Number.isSafeInteger(publication.packBytes) || publication.packBytes < 1) {
            throw new RangeError("Adaptive Journal Pack byte length must be a positive safe integer");
        }
        this.packs.set(publication.objectKey, {
            objectKey: publication.objectKey,
            packBytes: publication.packBytes,
            packId: packId.slice(),
        });
    }

    hasPack(route: AdaptiveJournalCommitPackV1): boolean {
        const publication = this.packs.get(route.objectKey);
        return (
            publication !== undefined &&
            publication.packBytes === route.packBytes &&
            bytesEqual(publication.packId, fixedLength(route.packId, 32, "packId"))
        );
    }

    acceptCommit(routes: readonly AdaptiveJournalCommitPackV1[]): void {
        for (const route of routes) this.packs.delete(route.objectKey);
    }
}
