import { base64UrlToBytes, bytesEqual, bytesToHex, fixedLength } from "./AdaptiveJournalBinary.ts";
import type { DecodedCommitEnvelopeV1 } from "./AdaptiveJournalCommit.ts";
import {
    decodeAdaptiveJournalCommitPacksV1,
    decodeAdaptiveJournalCommitRecordV1,
    type AdaptiveJournalCommitPackV1,
} from "./AdaptiveJournalControl.ts";
import type { AdaptiveJournalKeySetV1 } from "./AdaptiveJournalManifest.ts";
import { decodeAdaptiveJournalMetadataRecordV1 } from "./AdaptiveJournalPayload.ts";
import type { RemoteFailure } from "./AdaptiveJournalRepository.ts";

type DecodedCommitControlV1 = Awaited<ReturnType<typeof decodeAdaptiveJournalCommitRecordV1>>;

export type AdaptiveJournalCommitRoutePolicyV1 = "native" | "object";

export type AdaptiveJournalCommitVerificationV1 =
    | {
          control: DecodedCommitControlV1;
          routes: readonly AdaptiveJournalCommitPackV1[];
          status: "verified";
      }
    | { failure: RemoteFailure; status: "failed" };

const INVALID_REMOTE: RemoteFailure = { category: "invalid-response", retry: "never" };

function digestFromText(value: string, label: string): Uint8Array {
    return fixedLength(base64UrlToBytes(value), 32, label);
}

function controlMatchesEnvelope(
    envelope: DecodedCommitEnvelopeV1,
    payload: DecodedCommitControlV1["payload"]
): boolean {
    const previous =
        payload.previousCommitDigest === null
            ? null
            : digestFromText(payload.previousCommitDigest, "previousCommitDigest");
    const previousMatches =
        previous === null
            ? envelope.previousCommitDigest === null
            : envelope.previousCommitDigest !== null && bytesEqual(previous, envelope.previousCommitDigest);
    return (
        previousMatches &&
        payload.metadata.bytes === envelope.metadataFrame.byteLength &&
        bytesEqual(digestFromText(payload.metadata.digest, "metadataDigest"), envelope.metadataDigest) &&
        bytesEqual(
            digestFromText(payload.requiredChunkKeysDigest, "requiredChunkKeysDigest"),
            envelope.requiredChunkKeysDigest
        )
    );
}

function objectRoutesCoverRequiredChunks(
    envelope: DecodedCommitEnvelopeV1,
    routes: readonly AdaptiveJournalCommitPackV1[]
): boolean {
    const routed = new Set(routes.flatMap(({ entries }) => entries.map(({ key }) => bytesToHex(key))));
    return (
        routed.size === envelope.requiredChunkKeys.length &&
        envelope.requiredChunkKeys.every((key) => routed.has(bytesToHex(key)))
    );
}

function routesMatchPolicy(
    envelope: DecodedCommitEnvelopeV1,
    routes: readonly AdaptiveJournalCommitPackV1[],
    policy: AdaptiveJournalCommitRoutePolicyV1
): boolean {
    if (policy === "native") return routes.length === 0 && envelope.inlinePack === undefined;
    return objectRoutesCoverRequiredChunks(envelope, routes);
}

/** Verifies the authenticated Commit and Metadata content shared by every physical storage strategy. */
export async function verifyAdaptiveJournalCommitEnvelopeV1(options: {
    envelope: DecodedCommitEnvelopeV1;
    keys: AdaptiveJournalKeySetV1;
    routePolicy: AdaptiveJournalCommitRoutePolicyV1;
}): Promise<AdaptiveJournalCommitVerificationV1> {
    try {
        const control = await decodeAdaptiveJournalCommitRecordV1({
            bytes: options.envelope.commitFrame,
            keys: options.keys,
            sequence: options.envelope.sequence,
            writerStreamId: options.envelope.writerStreamId,
        });
        const routes = decodeAdaptiveJournalCommitPacksV1(control.payload);
        if (
            !bytesEqual(control.digest, options.envelope.commitFrameDigest) ||
            !controlMatchesEnvelope(options.envelope, control.payload) ||
            !routesMatchPolicy(options.envelope, routes, options.routePolicy)
        ) {
            return { failure: INVALID_REMOTE, status: "failed" };
        }
        await decodeAdaptiveJournalMetadataRecordV1({
            bytes: options.envelope.metadataFrame,
            keys: options.keys,
            sequence: options.envelope.sequence,
            writerStreamId: options.envelope.writerStreamId,
        });
        return { control, routes, status: "verified" };
    } catch {
        return { failure: INVALID_REMOTE, status: "failed" };
    }
}
