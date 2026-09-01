import type { RemoteDBSettings, RemotePreferredTweakResult } from "@lib/common/types.ts";
import type { RemoteDBStatus } from "./LiveSyncAbstractReplicator.ts";
import { CAPABILITY_NOT_APPLICABLE, type CapabilitySupport } from "./ProviderCapability.ts";

/** Stable machine identifiers for finite provider-owned remote resources. */
export const REMOTE_RESOURCE_KINDS = Object.freeze({
    CONNECTION: "connection",
    PREFERRED_TWEAK: "preferred-tweak",
    SECURITY_SEED: "security-seed",
    SYNCHRONISATION_INFORMATION: "synchronisation-information",
} as const);

export type RemoteResourceKind = (typeof REMOTE_RESOURCE_KINDS)[keyof typeof REMOTE_RESOURCE_KINDS];

/** Options understood by a provider's finite remote-connection resource. */
export interface RemoteConnectionProbeOptions {
    /** Permit a provider which supports provisioning to create the selected remote. */
    readonly createIfMissing?: boolean;
    /** Permit the provider to emit its ordinary user-facing connection result. */
    readonly showResult?: boolean;
}

/** Result of checking one trial remote configuration. */
export type RemoteConnectionProbeResult = { readonly ok: true } | { readonly ok: false; readonly reason?: unknown };

/**
 * A finite connection and status resource bound to one trial configuration.
 *
 * The owner must call {@link RemoteConnectionProbe.dispose} even when an
 * operation rejects. Disposal is asynchronous and must be idempotent.
 */
export interface RemoteConnectionProbe {
    check(options?: RemoteConnectionProbeOptions): Promise<RemoteConnectionProbeResult>;
    getStatus(): Promise<false | RemoteDBStatus>;
    dispose(): Promise<void>;
}

/** A finite preferred-tweak reader bound to one trial configuration. */
export interface PreferredTweakProbe {
    read(): Promise<RemotePreferredTweakResult>;
    /** Release every resource owned by this probe. Repeated calls must settle safely. */
    dispose(): Promise<void>;
}

/**
 * An owned reader for the remote Security Seed used to derive replication keys.
 *
 * Each read observes the remote for this resource's settings snapshot rather
 * than reusing process-cached parameters from an earlier workflow. Reading the
 * seed may create explicitly missing remote synchronisation parameters. The
 * caller must therefore treat this as a bounded remote operation and dispose
 * the resource in `finally`.
 */
export interface SecuritySeedResource {
    read(): Promise<Uint8Array<ArrayBuffer>>;
    dispose(): Promise<void>;
}

/**
 * An owned verifier for the remote synchronisation-information document.
 *
 * A successful check proves that the document can be decrypted. When the
 * document is absent, a provider may create it as part of the check. The owner
 * must dispose the resource in `finally`.
 */
export interface SynchronisationInformationResource {
    check(): Promise<boolean>;
    dispose(): Promise<void>;
}

export type RemoteResourceMap = {
    readonly [REMOTE_RESOURCE_KINDS.CONNECTION]: RemoteConnectionProbe;
    readonly [REMOTE_RESOURCE_KINDS.PREFERRED_TWEAK]: PreferredTweakProbe;
    readonly [REMOTE_RESOURCE_KINDS.SECURITY_SEED]: SecuritySeedResource;
    readonly [REMOTE_RESOURCE_KINDS.SYNCHRONISATION_INFORMATION]: SynchronisationInformationResource;
};

export type RemoteResourceFactoryMap = {
    readonly [K in RemoteResourceKind]: (setting: RemoteDBSettings) => Promise<RemoteResourceMap[K]>;
};

/** Exhaustive resource support catalogue supplied by one provider. */
export type RemoteResourceCapabilities = {
    readonly [K in RemoteResourceKind]: CapabilitySupport<RemoteResourceFactoryMap[K]>;
};

/** Explicit catalogue for providers which own no finite remote resources. */
export const NO_REMOTE_RESOURCE_CAPABILITIES: RemoteResourceCapabilities = Object.freeze({
    [REMOTE_RESOURCE_KINDS.CONNECTION]: CAPABILITY_NOT_APPLICABLE,
    [REMOTE_RESOURCE_KINDS.PREFERRED_TWEAK]: CAPABILITY_NOT_APPLICABLE,
    [REMOTE_RESOURCE_KINDS.SECURITY_SEED]: CAPABILITY_NOT_APPLICABLE,
    [REMOTE_RESOURCE_KINDS.SYNCHRONISATION_INFORMATION]: CAPABILITY_NOT_APPLICABLE,
});

export type ConnectionProbeFactory = RemoteResourceFactoryMap[typeof REMOTE_RESOURCE_KINDS.CONNECTION];
export type PreferredTweakProbeFactory = RemoteResourceFactoryMap[typeof REMOTE_RESOURCE_KINDS.PREFERRED_TWEAK];
export type SecuritySeedResourceFactory = RemoteResourceFactoryMap[typeof REMOTE_RESOURCE_KINDS.SECURITY_SEED];
export type SynchronisationInformationResourceFactory =
    RemoteResourceFactoryMap[typeof REMOTE_RESOURCE_KINDS.SYNCHRONISATION_INFORMATION];
