import { adaptiveJournalPackObjectKeyV1 } from "./AdaptiveJournalCatalogue.ts";
import { bytesEqual } from "./AdaptiveJournalBinary.ts";
import type { AdaptiveJournalObjectRemoteV1 } from "./AdaptiveJournalObjectStore.ts";
import type { AdaptiveJournalObjectPublicationCacheV1 } from "./AdaptiveJournalObjectPublicationCache.ts";
import type { AdaptiveJournalPackEntryV1, BuiltAdaptiveJournalPackV1 } from "./AdaptiveJournalPack.ts";
import type { RemoteFailure } from "./AdaptiveJournalRepository.ts";

export interface PublishAdaptiveJournalPackV1Options {
    pack: BuiltAdaptiveJournalPackV1;
    publicationCache?: AdaptiveJournalObjectPublicationCacheV1;
    remote: AdaptiveJournalObjectRemoteV1;
}

export type AdaptiveJournalPackPublicationResultV1 =
    | {
          entries: readonly AdaptiveJournalPackEntryV1[];
          packKey: string;
          status: "ok";
      }
    | { failure: RemoteFailure; status: "failed" }
    | { key: string; status: "collision" };

type EnsuredObject = { status: "found"; value: Uint8Array } | { failure: RemoteFailure; status: "failed" };

async function createThenRead(
    remote: AdaptiveJournalObjectRemoteV1,
    key: string,
    intended: Uint8Array,
    mime: string
): Promise<EnsuredObject> {
    const created = await remote.createAdaptiveObject(key, intended, mime);
    if (created.status === "created") {
        return { status: "found", value: intended.slice() };
    }
    if (created.status === "failed" && created.failure.retry !== "verify-first") return created;
    const read = await remote.readAdaptiveObject(key);
    if (read.status === "found") {
        return { status: "found", value: read.value };
    }
    if (read.status === "failed") return read;
    if (created.status === "failed") return created;
    return {
        status: "failed",
        failure: { category: "invalid-response", retry: "later" },
    };
}

export async function publishAdaptiveJournalPackV1(
    options: PublishAdaptiveJournalPackV1Options
): Promise<AdaptiveJournalPackPublicationResultV1> {
    options.publicationCache?.requireRemote(options.remote);
    const packKey = adaptiveJournalPackObjectKeyV1(options.pack.packId);
    const packObject = await createThenRead(
        options.remote,
        packKey,
        options.pack.packBytes,
        "application/octet-stream"
    );
    if (packObject.status === "failed") return packObject;
    if (!bytesEqual(packObject.value, options.pack.packBytes)) return { status: "collision", key: packKey };
    options.publicationCache?.rememberPack({
        objectKey: packKey,
        packBytes: options.pack.packBytes.byteLength,
        packId: options.pack.packId,
    });
    return { entries: options.pack.entries, packKey, status: "ok" };
}
