import { bytesEqual } from "./AdaptiveJournalBinary.ts";
import type { CapabilityVerification, RemoteFailure } from "./AdaptiveJournalRepository.ts";
import type { AdaptiveJournalObjectRemoteV1 } from "./AdaptiveJournalObjectStore.ts";

export const ADAPTIVE_JOURNAL_OBJECT_CAPABILITIES_V1: ReadonlySet<string> = new Set([
    "binary-fidelity",
    "byte-range",
    "complete-listing",
    "conditional-create",
    "delete-visibility",
    "read-after-write",
]);

export interface AdaptiveJournalObjectCapabilityProbeOptionsV1 {
    makeProbeKey(): string;
    remote: AdaptiveJournalObjectRemoteV1;
    removeProbe(key: string): Promise<boolean>;
    required: readonly string[];
}

/**
 * Exercises the object semantics required by Adaptive Journal against one owned random key.
 *
 * The transport remains responsible for classifying its responses. This sequence never treats an
 * ambiguous mutation, permission denial, or transport failure as evidence that an object is absent.
 */
export async function probeAdaptiveJournalObjectCapabilitiesV1(
    options: AdaptiveJournalObjectCapabilityProbeOptionsV1
): Promise<CapabilityVerification> {
    const unsupported = options.required.filter(
        (capability) => !ADAPTIVE_JOURNAL_OBJECT_CAPABILITIES_V1.has(capability)
    );
    if (unsupported.length > 0) return { status: "unsupported", missing: unsupported };

    const key = options.makeProbeKey();
    const body = new Uint8Array([0x00, 0xff, 0x41, 0x80, 0x0a, 0x7f]);
    const replacement = new Uint8Array([0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0x11]);
    const missing = new Set<string>();
    let ownsProbe = false;
    let failure: RemoteFailure | undefined;

    const created = await options.remote.createAdaptiveObject(key, body, "application/octet-stream");
    if (created.status === "created") {
        ownsProbe = true;
    } else if (created.status === "failed") {
        if (created.failure.retry === "verify-first") {
            const verification = await options.remote.readAdaptiveObject(key);
            ownsProbe = verification.status === "found" && bytesEqual(verification.value, body);
        }
        if (!ownsProbe) failure = created.failure;
    } else {
        missing.add("conditional-create");
    }

    if (!failure && ownsProbe) {
        const read = await options.remote.readAdaptiveObject(key);
        if (read.status === "failed") failure = read.failure;
        else if (read.status !== "found" || !bytesEqual(read.value, body)) {
            missing.add("binary-fidelity");
            missing.add("read-after-write");
        }

        const listing = await options.remote.listAdaptiveObjects(key);
        if (listing.status === "failed") failure ??= listing.failure;
        else if (!listing.keys.includes(key)) missing.add("complete-listing");

        const second = await options.remote.createAdaptiveObject(key, replacement, "application/octet-stream");
        if (second.status === "failed") failure ??= second.failure;
        else if (second.status !== "already-exists") missing.add("conditional-create");

        const retained = await options.remote.readAdaptiveObject(key);
        if (retained.status === "failed") failure ??= retained.failure;
        else if (retained.status !== "found" || !bytesEqual(retained.value, body)) {
            missing.add("conditional-create");
        }

        if (options.required.includes("byte-range")) {
            const ranged = await options.remote.readAdaptiveObject(key, { length: 3, offset: 1 });
            if (ranged.status === "failed") {
                if (ranged.failure.category === "invalid-response") missing.add("byte-range");
                else failure ??= ranged.failure;
            } else if (ranged.status !== "found" || !bytesEqual(ranged.value, body.slice(1, 4))) {
                missing.add("byte-range");
            }
        }
    }

    if (ownsProbe) {
        if (!(await options.removeProbe(key))) {
            failure ??= { category: "unavailable", retry: "later" };
        } else {
            const deleted = await options.remote.readAdaptiveObject(key);
            if (deleted.status === "failed") failure ??= deleted.failure;
            else if (deleted.status !== "missing") missing.add("delete-visibility");
        }
    }

    if (failure) return { status: "failed", failure };
    if (!ownsProbe) return { status: "unsupported", missing: [...missing] };
    if (missing.size > 0) return { status: "unsupported", missing: [...missing] };
    return { status: "verified" };
}
