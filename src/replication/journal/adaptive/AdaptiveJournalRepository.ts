import { bytesEqual } from "./AdaptiveJournalBinary.ts";
import {
    ADAPTIVE_JOURNAL_REQUIRED_CAPABILITIES_V1,
    AdaptiveJournalError,
    createAdaptiveJournalManifestV1,
    parseAndVerifyAdaptiveJournalManifestV1,
    sha256,
    type AdaptiveJournalEncryption,
    type AdaptiveJournalManifestCandidateV1,
} from "./AdaptiveJournalManifest.ts";

export type RemoteFailure = {
    category: "authentication" | "invalid-response" | "permission" | "rate-limited" | "unavailable" | "unknown";
    retry: "later" | "never" | "verify-first";
};

export type RemoteRead<T> =
    | { identity?: string; status: "found"; value: T }
    | { status: "missing" }
    | { failure: RemoteFailure; status: "failed" };

type ResolvedRemoteRead<T> = Exclude<RemoteRead<T>, { status: "failed" }>;

export type ImmutableCreate =
    | { identity?: string; status: "created" }
    | { identity?: string; status: "already-exists" }
    | { failure: RemoteFailure; status: "failed" };

export type CapabilityVerification =
    | { status: "verified" }
    | { missing: readonly string[]; status: "unsupported" }
    | { failure: RemoteFailure; status: "failed" };

export interface AdaptiveJournalManifestRemoteV1 {
    createManifest(bytes: Uint8Array): Promise<ImmutableCreate>;
    readManifest(): Promise<RemoteRead<Uint8Array>>;
    verifyCapabilities(required: readonly string[]): Promise<CapabilityVerification>;
}

export interface AdaptiveJournalPendingInitialisationV1 {
    bytes: Uint8Array;
    digest: Uint8Array;
}

export interface AdaptiveJournalBindingStateV1 {
    encryption: AdaptiveJournalEncryption;
    pendingInitialisation?: AdaptiveJournalPendingInitialisationV1;
    repositoryId?: string;
}

export interface AdaptiveJournalBindingStoreV1 {
    acceptManifest(repositoryId: string): Promise<void>;
    load(): Promise<AdaptiveJournalBindingStateV1>;
    stageInitialisation(pending: AdaptiveJournalPendingInitialisationV1): Promise<void>;
}

export type AdaptiveJournalOpenIntentV1 = "attach-existing" | "create-new";

export interface OpenAdaptiveJournalRepositoryV1Options {
    additionalRequiredCapabilities?: readonly string[];
    binding: AdaptiveJournalBindingStoreV1;
    candidateFactory?: () => Promise<AdaptiveJournalManifestCandidateV1>;
    expectedRepositoryId?: string;
    intent: AdaptiveJournalOpenIntentV1;
    passphrase: string;
    remote: AdaptiveJournalManifestRemoteV1;
}

export type OpenedAdaptiveJournalRepositoryV1 = AdaptiveJournalManifestCandidateV1 & {
    disposition: "attached" | "attached-concurrent" | "created" | "recovered";
};

function remoteFailure(operation: string, failure: RemoteFailure): AdaptiveJournalError {
    return new AdaptiveJournalError(
        "remote-operation-failed",
        `${operation} failed (${failure.category}; retry ${failure.retry})`
    );
}

async function requireCapabilities(
    options: Pick<OpenAdaptiveJournalRepositoryV1Options, "additionalRequiredCapabilities" | "remote">
): Promise<void> {
    const required = [
        ...new Set([
            ...ADAPTIVE_JOURNAL_REQUIRED_CAPABILITIES_V1,
            ...(options.additionalRequiredCapabilities ?? []),
        ]),
    ];
    const verification = await options.remote.verifyCapabilities(required);
    if (verification.status === "failed") throw remoteFailure("Adaptive Journal capability verification", verification.failure);
    if (verification.status === "unsupported") {
        throw new AdaptiveJournalError(
            "required-capability-missing",
            `Adaptive Journal remote is missing required capabilities: ${verification.missing.join(", ")}`
        );
    }
}

function pinnedRepositoryId(
    state: AdaptiveJournalBindingStateV1,
    exportedRepositoryId: string | undefined
): string | undefined {
    if (
        state.repositoryId !== undefined &&
        exportedRepositoryId !== undefined &&
        state.repositoryId !== exportedRepositoryId
    ) {
        throw new AdaptiveJournalError(
            "repository-id-mismatch",
            "The local binding and exported repository IDs do not match"
        );
    }
    return state.repositoryId ?? exportedRepositoryId;
}

async function verifyManifest(
    bytes: Uint8Array,
    state: AdaptiveJournalBindingStateV1,
    expectedRepositoryId: string | undefined,
    passphrase: string
): Promise<AdaptiveJournalManifestCandidateV1> {
    return await parseAndVerifyAdaptiveJournalManifestV1(bytes, {
        expectedEncryption: state.encryption,
        expectedRepositoryId,
        passphrase,
    });
}

async function readManifestOrThrow(remote: AdaptiveJournalManifestRemoteV1): Promise<ResolvedRemoteRead<Uint8Array>> {
    const read = await remote.readManifest();
    if (read.status === "failed") throw remoteFailure("Adaptive Journal manifest read", read.failure);
    return read;
}

async function accept(
    binding: AdaptiveJournalBindingStoreV1,
    candidate: AdaptiveJournalManifestCandidateV1,
    disposition: OpenedAdaptiveJournalRepositoryV1["disposition"]
): Promise<OpenedAdaptiveJournalRepositoryV1> {
    await binding.acceptManifest(candidate.manifest.repositoryId);
    return { ...candidate, disposition };
}

async function readBackAfterCreate(
    options: OpenAdaptiveJournalRepositoryV1Options,
    state: AdaptiveJournalBindingStateV1,
    expectedRepositoryId: string | undefined,
    intendedDigest: Uint8Array,
    createStatus: "already-exists" | "created",
    recovering: boolean
): Promise<OpenedAdaptiveJournalRepositoryV1> {
    const read = await readManifestOrThrow(options.remote);
    if (read.status === "missing") {
        throw new AdaptiveJournalError(
            "remote-operation-failed",
            "Adaptive Journal manifest remained missing after conditional creation"
        );
    }
    const winner = await verifyManifest(read.value, state, expectedRepositoryId, options.passphrase);
    const exactWinner = bytesEqual(winner.digest, intendedDigest);
    const disposition = recovering
        ? "recovered"
        : createStatus === "created" && exactWinner
          ? "created"
          : "attached-concurrent";
    return await accept(options.binding, winner, disposition);
}

async function resolvePendingInitialisation(
    options: OpenAdaptiveJournalRepositoryV1Options,
    state: AdaptiveJournalBindingStateV1,
    expectedRepositoryId: string | undefined
): Promise<OpenedAdaptiveJournalRepositoryV1> {
    const pending = state.pendingInitialisation;
    if (!pending) throw new TypeError("pendingInitialisation is required");
    if (!bytesEqual(await sha256(pending.bytes), pending.digest)) {
        throw new AdaptiveJournalError(
            "pending-initialisation-mismatch",
            "Pending Adaptive Journal initialisation bytes do not match their digest"
        );
    }
    const existing = await readManifestOrThrow(options.remote);
    if (existing.status === "found") {
        const winner = await verifyManifest(existing.value, state, expectedRepositoryId, options.passphrase);
        await requireCapabilities(options);
        return await accept(options.binding, winner, "recovered");
    }
    await requireCapabilities(options);
    const created = await options.remote.createManifest(pending.bytes);
    if (created.status === "failed" && created.failure.retry !== "verify-first") {
        throw remoteFailure("Adaptive Journal manifest create", created.failure);
    }
    if (created.status === "failed") {
        const verification = await readManifestOrThrow(options.remote);
        if (verification.status === "missing") throw remoteFailure("Adaptive Journal manifest create", created.failure);
        const winner = await verifyManifest(verification.value, state, expectedRepositoryId, options.passphrase);
        await requireCapabilities(options);
        return await accept(options.binding, winner, "recovered");
    }
    return await readBackAfterCreate(
        options,
        state,
        expectedRepositoryId,
        pending.digest,
        created.status,
        true
    );
}

export async function openAdaptiveJournalRepositoryV1(
    options: OpenAdaptiveJournalRepositoryV1Options
): Promise<OpenedAdaptiveJournalRepositoryV1> {
    const state = await options.binding.load();
    const expectedRepositoryId = pinnedRepositoryId(state, options.expectedRepositoryId);
    if (state.pendingInitialisation) {
        return await resolvePendingInitialisation(options, state, expectedRepositoryId);
    }

    const existing = await readManifestOrThrow(options.remote);
    if (existing.status === "found") {
        if (options.intent === "create-new" && expectedRepositoryId === undefined) {
            throw new AdaptiveJournalError(
                "repository-already-exists",
                "An Adaptive Journal repository already exists at this remote"
            );
        }
        const candidate = await verifyManifest(existing.value, state, expectedRepositoryId, options.passphrase);
        await requireCapabilities(options);
        return await accept(options.binding, candidate, "attached");
    }
    if (options.intent === "attach-existing" || expectedRepositoryId !== undefined) {
        throw new AdaptiveJournalError("repository-missing", "The expected Adaptive Journal repository is missing");
    }

    await requireCapabilities(options);
    const candidateFactory =
        options.candidateFactory ??
        (async () =>
            await createAdaptiveJournalManifestV1({
                encryption: state.encryption,
                passphrase: options.passphrase,
            }));
    const candidate = await candidateFactory();
    if (candidate.keys.encryption !== state.encryption) {
        throw new AdaptiveJournalError(
            "encryption-mode-mismatch",
            "Generated manifest encryption does not match the local binding"
        );
    }
    await options.binding.stageInitialisation({ bytes: candidate.bytes, digest: candidate.digest });
    const created = await options.remote.createManifest(candidate.bytes);
    if (created.status === "failed" && created.failure.retry !== "verify-first") {
        throw remoteFailure("Adaptive Journal manifest create", created.failure);
    }
    if (created.status === "failed") {
        const verification = await readManifestOrThrow(options.remote);
        if (verification.status === "missing") throw remoteFailure("Adaptive Journal manifest create", created.failure);
        const winner = await verifyManifest(verification.value, state, undefined, options.passphrase);
        await requireCapabilities(options);
        return await accept(options.binding, winner, "attached-concurrent");
    }
    return await readBackAfterCreate(options, state, undefined, candidate.digest, created.status, false);
}
