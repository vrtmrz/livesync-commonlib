import {
    adaptiveJournalIndexObjectKeyV1,
    adaptiveJournalPackObjectKeyV1,
    decodeAdaptiveJournalCatalogueDeltaV1,
    encodeAdaptiveJournalCatalogueDeltaV1,
} from "./AdaptiveJournalCatalogue.ts";
import { bytesEqual } from "./AdaptiveJournalBinary.ts";
import { sha256, type AdaptiveJournalKeySetV1 } from "./AdaptiveJournalManifest.ts";
import type { AdaptiveJournalObjectRemoteV1 } from "./AdaptiveJournalObjectStore.ts";
import type { AdaptiveJournalObjectPublicationCacheV1 } from "./AdaptiveJournalObjectPublicationCache.ts";
import {
    decodeAdaptiveJournalPackV1,
    type AdaptiveJournalPackIndexEntryV1,
    type BuiltAdaptiveJournalPackV1,
} from "./AdaptiveJournalPack.ts";
import type { RemoteFailure } from "./AdaptiveJournalRepository.ts";

export interface PublishAdaptiveJournalPackV1Options {
    deltaCodec?: "auto" | "deflate" | "none";
    deltaIv?: Uint8Array;
    deltaRecordSalt?: Uint8Array;
    keys: AdaptiveJournalKeySetV1;
    pack: BuiltAdaptiveJournalPackV1;
    publicationCache?: AdaptiveJournalObjectPublicationCacheV1;
    remote: AdaptiveJournalObjectRemoteV1;
    sequence: bigint;
    writerStreamId: Uint8Array;
}

export type AdaptiveJournalPackPublicationResultV1 =
    | {
          deltaDigest: Uint8Array;
          deltaFrame: Uint8Array;
          deltaKey: string;
          entries: readonly AdaptiveJournalPackIndexEntryV1[];
          indexFrame: Uint8Array;
          indexFrameDigest: Uint8Array;
          indexKey: string;
          packKey: string;
          status: "ok";
      }
    | { failure: RemoteFailure; status: "failed" }
    | { key: string; status: "collision" };

type EnsuredObject =
    | { createStatus: "already-exists" | "created" | "uncertain"; status: "found"; value: Uint8Array }
    | { failure: RemoteFailure; status: "failed" };

async function createThenRead(
    remote: AdaptiveJournalObjectRemoteV1,
    key: string,
    intended: Uint8Array,
    mime: string
): Promise<EnsuredObject> {
    const created = await remote.createAdaptiveObject(key, intended, mime);
    if (created.status === "created") {
        return { status: "found", value: intended.slice(), createStatus: "created" };
    }
    if (created.status === "failed" && created.failure.retry !== "verify-first") return created;
    const read = await remote.readAdaptiveObject(key);
    if (read.status === "found") {
        return {
            status: "found",
            value: read.value,
            createStatus: created.status === "already-exists" ? "already-exists" : "uncertain",
        };
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

    const indexKey = adaptiveJournalIndexObjectKeyV1(options.pack.packId);
    const indexObject = await createThenRead(
        options.remote,
        indexKey,
        options.pack.indexFrame,
        "application/octet-stream"
    );
    if (indexObject.status === "failed") return indexObject;

    let indexFrame: Uint8Array;
    let indexFrameDigest: Uint8Array;
    let entries: readonly AdaptiveJournalPackIndexEntryV1[];
    if (bytesEqual(indexObject.value, options.pack.indexFrame)) {
        indexFrame = options.pack.indexFrame.slice();
        indexFrameDigest = options.pack.indexFrameDigest.slice();
        entries = options.pack.entries;
    } else {
        try {
            const adopted = await decodeAdaptiveJournalPackV1({
                expectedPackId: options.pack.packId,
                indexFrame: indexObject.value,
                keys: options.keys,
                packBytes: options.pack.packBytes,
            });
            indexFrame = indexObject.value.slice();
            indexFrameDigest = adopted.indexFrameDigest;
            entries = adopted.entries;
        } catch {
            return { status: "collision", key: indexKey };
        }
    }

    const intendedDelta = await encodeAdaptiveJournalCatalogueDeltaV1({
        codec: options.deltaCodec,
        indexDigest: indexFrameDigest,
        indexKey,
        keys: options.keys,
        packBytes: options.pack.packBytes.byteLength,
        packId: options.pack.packId,
        recordIv: options.deltaIv,
        recordSalt: options.deltaRecordSalt,
        sequence: options.sequence,
        writerStreamId: options.writerStreamId,
    });
    const deltaObject = await createThenRead(
        options.remote,
        intendedDelta.key,
        intendedDelta.bytes,
        "application/octet-stream"
    );
    if (deltaObject.status === "failed") return deltaObject;

    let deltaFrame: Uint8Array;
    let deltaDigest: Uint8Array;
    if (bytesEqual(deltaObject.value, intendedDelta.bytes)) {
        deltaFrame = intendedDelta.bytes.slice();
        deltaDigest = intendedDelta.digest.slice();
    } else {
        try {
            const adopted = await decodeAdaptiveJournalCatalogueDeltaV1({
                bytes: deltaObject.value,
                keys: options.keys,
                sequence: options.sequence,
                writerStreamId: options.writerStreamId,
            });
            if (JSON.stringify(adopted.payload) !== JSON.stringify(intendedDelta.payload)) {
                return { status: "collision", key: intendedDelta.key };
            }
            deltaFrame = deltaObject.value.slice();
            deltaDigest = await sha256(deltaFrame);
        } catch {
            return { status: "collision", key: intendedDelta.key };
        }
    }
    const result: AdaptiveJournalPackPublicationResultV1 = {
        deltaDigest,
        deltaFrame,
        deltaKey: intendedDelta.key,
        entries,
        indexFrame,
        indexFrameDigest,
        indexKey,
        packKey,
        status: "ok",
    };
    options.publicationCache?.rememberPack({
        deltaDigest,
        deltaKey: intendedDelta.key,
        entries,
        packId: options.pack.packId,
    });
    return result;
}
