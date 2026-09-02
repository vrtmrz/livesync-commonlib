import type { RemoteDBSettings, ObsidianLiveSyncSettings, RemoteType } from "@lib/common/types.ts";
import type { ReplicatorInstance } from "./ReplicatorInstance.ts";
import { supportedCapability, type CapabilitySupport, type SupportedCapability } from "./ProviderCapability.ts";
import type { RemoteResourceCapabilities } from "./RemoteResource.ts";
import type { CentralRemoteAdministrationRunner } from "./CentralRemoteAdministration.ts";
import type { CentralCompatibilityRecoveryHint } from "./CentralCompatibility.ts";

export {
    CAPABILITY_NOT_APPLICABLE,
    CAPABILITY_NOT_IMPLEMENTED,
    CAPABILITY_SUPPORT_KINDS,
    CAPABILITY_UNAVAILABLE_REASONS,
    supportedCapability,
} from "./ProviderCapability.ts";
export type {
    CapabilitySupport,
    NotApplicableCapability,
    NotImplementedCapability,
    SupportedCapability,
} from "./ProviderCapability.ts";

/**
 * A finite replication trigger which can run without opening a user dialogue.
 *
 * This is deliberately a closed list. Adding another automatic trigger must
 * make its lifecycle ownership visible at the call site and in the provider
 * contract rather than silently inheriting manual interaction permissions.
 */
export type UnattendedReplicationTrigger =
    | "resume"
    | "periodic"
    | "database-event"
    | "editor-save"
    | "file-open"
    | "merge"
    | "daemon";

/** Automatic trigger which may start or resume a long-lived connection. */
export type ContinuousReplicationTrigger = "resume" | "daemon";

/** No user interaction may be requested by an unattended replication path. */
export const NO_INTERACTION = Object.freeze({ kind: "forbidden" } as const);

/**
 * The authority carried by a user-initiated replication command.
 *
 * The permissions are explicit so that a future caller can narrow an
 * operation without passing a broad boolean such as `showMessage` through
 * provider code. The common authority grants all currently supported user
 * actions.
 */
export const USER_INITIATED_REPLICATION_AUTHORITY = Object.freeze({
    kind: "permitted",
    permissions: Object.freeze({
        peerSelection: true,
        localPeerAdmission: true,
        configurationExchange: true,
        failureRecovery: true,
    }),
} as const);

export type NoInteraction = typeof NO_INTERACTION;

/** All interaction permissions understood by the current provider boundary. */
export interface InteractionPermissions {
    readonly peerSelection: boolean;
    readonly localPeerAdmission: boolean;
    readonly configurationExchange: boolean;
    readonly failureRecovery: boolean;
}

/**
 * A permitted authority must retain at least one explicit permission.
 *
 * This prevents an apparently user-authorised request from carrying an empty
 * permission set, while allowing a caller to veto or narrow individual
 * actions without introducing a second authority type.
 */
export type PermittedInteractionPermissions =
    | (InteractionPermissions & { readonly peerSelection: true })
    | (InteractionPermissions & { readonly localPeerAdmission: true })
    | (InteractionPermissions & { readonly configurationExchange: true })
    | (InteractionPermissions & { readonly failureRecovery: true });

export interface UserInitiatedReplicationAuthority {
    readonly kind: "permitted";
    readonly permissions: PermittedInteractionPermissions;
}

export type ReplicationInteraction = NoInteraction | UserInitiatedReplicationAuthority;

/** Authority carried through a replication request and its failure path. */
export type InteractionAuthority = ReplicationInteraction;

/** Stable host presentation choices for routine OneShot progress. */
export const REPLICATION_PROGRESS_PRESENTATIONS = Object.freeze({
    QUIET: "quiet",
    NOTICE: "notice",
} as const);

export type ReplicationProgressPresentation =
    (typeof REPLICATION_PROGRESS_PRESENTATIONS)[keyof typeof REPLICATION_PROGRESS_PRESENTATIONS];

/**
 * A request made by an explicitly user-initiated one-shot command.
 *
 * Progress presentation is independent of interaction authority: a quiet
 * command may still open an authorised peer-selection or failure-recovery
 * dialogue when the operation requires a decision.
 */
export interface UserInitiatedOneShotRequest {
    readonly trigger: "manual";
    readonly progressPresentation: ReplicationProgressPresentation;
    readonly interaction: InteractionAuthority;
}

/** A request made by an automatic finite replication trigger. */
export interface UnattendedOneShotRequest {
    readonly trigger: UnattendedReplicationTrigger;
    readonly interaction: NoInteraction;
}

/** A request which starts a provider's long-lived/continuous operation. */
export interface ContinuousReplicationRequest {
    readonly trigger: ContinuousReplicationTrigger;
    readonly interaction: NoInteraction;
}

/** Stable reasons for which a provider role cannot be run. */
export type ReplicationBlockReason =
    | "no-active-replicator"
    | "no-targets"
    | "not-ready"
    | "provider-not-composed"
    | "provider-not-configured"
    | "capability-not-implemented"
    | "capability-not-applicable"
    | "interaction-required"
    | "replication-in-progress"
    | "rate-limited";

/** A finite operation completed without a partial or failed result. */
export const REPLICATION_COMPLETED = Object.freeze({ status: "completed" } as const);

/** A user-initiated operation was cancelled before it completed. */
export const REPLICATION_CANCELLED = Object.freeze({ status: "cancelled" } as const);

export type ReplicationCompleted = typeof REPLICATION_COMPLETED;
export type ReplicationCancelled = typeof REPLICATION_CANCELLED;

export type ReplicationBlocked = {
    readonly status: "blocked";
    readonly reason: ReplicationBlockReason;
};

export type ReplicationPartial = {
    readonly status: "partial";
    readonly detail: unknown;
};

export type ReplicationFailed = {
    readonly status: "failed";
    readonly error: unknown;
    readonly recoveryHint?: CentralCompatibilityRecoveryHint;
};

/**
 * Result of a typed replication role.
 *
 * `completed` is intentionally not represented by a truthy value from the
 * legacy `openReplication` method. Providers must opt into this singleton,
 * which keeps `false` and `void` observable as non-completion for finite work.
 */
export type ReplicationOutcome =
    | ReplicationCompleted
    | ReplicationCancelled
    | ReplicationBlocked
    | ReplicationPartial
    | ReplicationFailed;

/** Preparation required before an ordinary operation may use a provider. */
export interface ReplicationReadinessRequirements {
    readonly centralRemotePreparation: "required" | "not-applicable";
}

/** Shared readiness contract for providers backed by the central remote. */
export const CENTRAL_REMOTE_REPLICATION_READINESS = Object.freeze({
    centralRemotePreparation: "required",
} as const satisfies ReplicationReadinessRequirements);

/** Shared readiness contract for peer-to-peer providers without a central remote. */
export const PEER_REPLICATION_READINESS = Object.freeze({
    centralRemotePreparation: "not-applicable",
} as const satisfies ReplicationReadinessRequirements);

/** Return whether a typed replication result represents completed work. */
export function isReplicationCompleted(outcome: ReplicationOutcome): outcome is ReplicationCompleted {
    return outcome.status === "completed";
}

export function replicationBlocked(reason: ReplicationBlockReason): ReplicationBlocked {
    return { status: "blocked", reason };
}

export function replicationFailed(error: unknown, recoveryHint?: CentralCompatibilityRecoveryHint): ReplicationFailed {
    return {
        status: "failed",
        error,
        ...(recoveryHint === undefined ? {} : { recoveryHint }),
    };
}

export type UserInitiatedOneShotRunner = (
    replicator: ReplicatorInstance,
    setting: RemoteDBSettings,
    request: UserInitiatedOneShotRequest
) => Promise<ReplicationOutcome>;

export type UnattendedOneShotRunner = (
    replicator: ReplicatorInstance,
    setting: RemoteDBSettings,
    request: UnattendedOneShotRequest
) => Promise<ReplicationOutcome>;

/**
 * Register a provider-owned Continuous task and settle its startup request.
 *
 * The runner must return after task ownership and pre-controller cancellation
 * have been registered. It must not retain the caller's active-publication
 * admission for the lifetime of the long-lived transfer.
 */
export type ContinuousRunner = (
    replicator: ReplicatorInstance,
    setting: RemoteDBSettings,
    request: ContinuousReplicationRequest
) => Promise<ReplicationOutcome>;

/**
 * Request cancellation of finite transfer work on the currently active
 * replicator. A `completed` outcome confirms that the stop request was
 * accepted; it does not claim rollback of work which had already settled.
 */
export type StopActiveTransferRunner = (replicator: ReplicatorInstance) => Promise<ReplicationOutcome>;

/**
 * Opaque provider-owned projection of every setting which binds an active Replicator.
 * It is private comparison state and must not be logged, persisted, or displayed.
 */
export type ReplicatorConfigurationIdentity = string;

/** One host-composed provider and every role which may use its active instance. */
export interface ReplicatorProviderDefinition<TKind extends RemoteType = RemoteType> {
    /** Canonical persisted remote kind used for provider selection. */
    readonly kind: TKind;
    /** Human-readable diagnostic label; never use it as a machine decision. */
    readonly diagnosticName: string;
    /** Preparation gates required before an ordinary replication role runs. */
    readonly readiness: ReplicationReadinessRequirements;
    /** Return whether the effective settings are sufficient to construct this provider. */
    readonly isConfigured: (setting: RemoteDBSettings) => boolean;
    /** Project the fully merged effective settings to this provider's stable binding identity. */
    readonly configurationIdentity: (setting: RemoteDBSettings) => ReplicatorConfigurationIdentity;
    /** Construct a replicator from the fully merged effective settings. */
    readonly create: (setting: ObsidianLiveSyncSettings) => Promise<ReplicatorInstance | undefined | false>;
    /** Exhaustive provider-owned catalogue for finite remote resources. */
    readonly remoteResources: RemoteResourceCapabilities;
    /** Optional provider-owned central-remote administration runner. */
    readonly centralRemoteAdministration?: CapabilitySupport<CentralRemoteAdministrationRunner>;
    /** Finite role carrying explicit user-interaction authority. */
    readonly userInitiatedOneShot: CapabilitySupport<UserInitiatedOneShotRunner>;
    /** Finite role which must not request user interaction. */
    readonly unattendedOneShot: CapabilitySupport<UnattendedOneShotRunner>;
    /** Explicit support decision for ordinary long-lived Continuous replication. */
    readonly continuous: CapabilitySupport<ContinuousRunner>;
    /** Bounded cancellation request for transfer work on the active instance. */
    readonly stopActiveTransfer: CapabilitySupport<StopActiveTransferRunner>;
}

/** The atomic provider, Replicator, and binding identity published by the owner service. */
export interface ActiveReplicatorContext<TKind extends RemoteType = RemoteType> {
    readonly provider: ReplicatorProviderDefinition<TKind>;
    readonly replicator: ReplicatorInstance;
    /** Private comparison state; callers must not log, persist, or display it. */
    readonly configurationIdentity: ReplicatorConfigurationIdentity;
}

/** Immutable source of one failed attempt, safe to carry after its reservation is released. */
export interface ReplicationAttemptFailure {
    readonly context: ActiveReplicatorContext;
    readonly setting: ObsidianLiveSyncSettings;
    readonly outcome: ReplicationFailed;
}

/** Immutable failure source plus presentation and interaction policy from its original request. */
export interface ReplicationFailureRequest extends ReplicationAttemptFailure {
    readonly progressPresentation: ReplicationProgressPresentation;
    readonly interaction: InteractionAuthority;
}

/** Return whether one detached setting still belongs to the admitted publication. */
export function isActiveReplicatorContextBoundToSetting(
    context: ActiveReplicatorContext,
    setting: RemoteDBSettings
): boolean {
    try {
        return (
            setting.remoteType === context.provider.kind &&
            context.provider.isConfigured(setting) &&
            context.provider.configurationIdentity(setting) === context.configurationIdentity
        );
    } catch {
        // Invalid or partially edited settings must fail closed instead of
        // dispatching them through the previously bound Replicator.
        return false;
    }
}

export type ReplicatorProviderDefinitionMap = ReadonlyMap<RemoteType, ReplicatorProviderDefinition>;

/**
 * Define exactly the provider subset composed by a host.
 *
 * The tuple is the host's closed catalogue for this composition. The mapped
 * argument makes every selected kind required at compile time, while the
 * runtime checks reject duplicate, omitted, or extra definitions. A host can
 * therefore omit a provider intentionally, but cannot silently select a
 * partially defined provider.
 */
export function defineReplicatorProviderDefinitions<const TKind extends readonly RemoteType[]>(
    kinds: TKind,
    definitions: { readonly [K in TKind[number]]: ReplicatorProviderDefinition<K> }
): ReplicatorProviderDefinitionMap {
    const selectedKinds = new Set<RemoteType>(kinds);
    if (selectedKinds.size !== kinds.length) {
        throw new Error("Replicator provider kinds must be unique.");
    }

    if (Object.keys(definitions).length !== selectedKinds.size) {
        throw new Error("Replicator provider definitions must match the selected provider kinds.");
    }

    const result = new Map<RemoteType, ReplicatorProviderDefinition>();
    for (const kind of kinds) {
        // TypeScript widens a value iterated from the generic tuple to its
        // `RemoteType` constraint. The mapped argument above still guarantees
        // this key, and the following runtime check protects JavaScript callers.
        const definition = definitions[kind as TKind[number]];
        if (!definition || definition.kind !== kind) {
            throw new Error(`Replicator provider definition does not match '${kind}'.`);
        }
        result.set(kind, definition);
    }
    return result;
}

/**
 * Convert a legacy `openReplication` result to the typed finite outcome.
 * `void` is not a success signal for a finite operation.
 */
export function outcomeFromFiniteOpenReplication(
    result: void | boolean,
    recoveryHint?: CentralCompatibilityRecoveryHint
): ReplicationOutcome {
    return result === true
        ? REPLICATION_COMPLETED
        : replicationFailed(new Error("The provider did not complete finite replication."), recoveryHint);
}

/**
 * Convert a legacy `openReplication` result to a continuous-start outcome.
 * A provider which returns `void` has accepted the start request, whereas an
 * explicit `false` still reports a failed start.
 */
export function outcomeFromContinuousOpenReplication(result: void | boolean): ReplicationOutcome {
    return result === false
        ? replicationFailed(new Error("The provider rejected continuous replication."))
        : REPLICATION_COMPLETED;
}

/**
 * Adapt legacy `openReplication` for package and test compatibility.
 *
 * Current central providers use exact-outcome wrappers; this
 * adapter remains for consumers and tests which still expose the legacy role.
 */
export function supportedOpenReplicationOneShot(): SupportedCapability<UserInitiatedOneShotRunner> {
    return supportedCapability(async (replicator, setting, request) => {
        try {
            const result = await replicator.openReplication(
                setting,
                false,
                request.progressPresentation === REPLICATION_PROGRESS_PRESENTATIONS.NOTICE,
                false
            );
            return outcomeFromFiniteOpenReplication(result);
        } catch (error) {
            return replicationFailed(error);
        }
    });
}

/**
 * Adapt legacy `openReplication` for unattended package and test compatibility.
 *
 * Current central providers use exact-outcome wrappers; this
 * adapter remains for consumers and tests which still expose the legacy role.
 */
export function supportedOpenReplicationUnattended(): SupportedCapability<UnattendedOneShotRunner> {
    return supportedCapability(async (replicator, setting, request) => {
        if (request.interaction.kind !== NO_INTERACTION.kind) {
            return replicationBlocked("interaction-required");
        }
        try {
            const result = await replicator.openReplication(setting, false, false, false);
            return outcomeFromFiniteOpenReplication(result);
        } catch (error) {
            return replicationFailed(error);
        }
    });
}

export function supportedOpenReplicationContinuous(): SupportedCapability<ContinuousRunner> {
    return supportedCapability(async (replicator, setting, request) => {
        if (request.interaction.kind !== NO_INTERACTION.kind) {
            return replicationBlocked("interaction-required");
        }
        try {
            const result = await replicator.openReplication(setting, true, false, false);
            return outcomeFromContinuousOpenReplication(result);
        } catch (error) {
            return replicationFailed(error);
        }
    });
}

/**
 * Adapt the legacy termination hook to the typed active-transfer capability.
 *
 * `terminateSync` is intentionally awaited even though existing replicators
 * implement it synchronously. This keeps the capability boundary valid for a
 * provider whose cancellation work needs to settle asynchronously.
 */
export function supportedStopActiveTransfer(): SupportedCapability<StopActiveTransferRunner> {
    return supportedCapability(async (replicator) => {
        try {
            await replicator.terminateSync();
            return REPLICATION_COMPLETED;
        } catch (error) {
            return replicationFailed(error);
        }
    });
}
