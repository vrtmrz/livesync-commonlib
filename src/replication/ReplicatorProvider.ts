import type { RemoteDBSettings, ObsidianLiveSyncSettings, RemoteType } from "@lib/common/types.ts";
import type { LiveSyncAbstractReplicator } from "./LiveSyncAbstractReplicator.ts";

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

/** A request made by an explicitly user-initiated one-shot command. */
export interface UserInitiatedOneShotRequest {
    readonly trigger: "manual";
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
    | "not-ready"
    | "provider-not-composed"
    | "provider-not-configured"
    | "capability-not-implemented"
    | "capability-not-applicable"
    | "interaction-required"
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

export function replicationFailed(error: unknown): ReplicationFailed {
    return { status: "failed", error };
}

/** A declared role is available, but its implementation is not included. */
export type NotImplementedCapability = {
    readonly kind: "not-implemented";
    readonly reason: "capability-not-implemented";
};

/** A declared role does not apply to this provider. */
export type NotApplicableCapability = {
    readonly kind: "not-applicable";
    readonly reason: "capability-not-applicable";
};

export type SupportedCapability<TRole> = {
    readonly kind: "supported";
    readonly run: TRole;
};

/** Provider capability declaration correlated with the role runner. */
export type CapabilitySupport<TRole> = SupportedCapability<TRole> | NotImplementedCapability | NotApplicableCapability;

export type UserInitiatedOneShotRunner = (
    replicator: LiveSyncAbstractReplicator,
    setting: RemoteDBSettings,
    request: UserInitiatedOneShotRequest
) => Promise<ReplicationOutcome>;

export type UnattendedOneShotRunner = (
    replicator: LiveSyncAbstractReplicator,
    setting: RemoteDBSettings,
    request: UnattendedOneShotRequest
) => Promise<ReplicationOutcome>;

export type ContinuousRunner = (
    replicator: LiveSyncAbstractReplicator,
    setting: RemoteDBSettings,
    request: ContinuousReplicationRequest
) => Promise<ReplicationOutcome>;

/**
 * Request cancellation of finite transfer work on the currently active
 * replicator. A `completed` outcome confirms that the stop request was
 * accepted; it does not claim rollback of work which had already settled.
 */
export type StopActiveTransferRunner = (replicator: LiveSyncAbstractReplicator) => Promise<ReplicationOutcome>;

export interface ReplicatorProviderDefinition<TKind extends RemoteType = RemoteType> {
    readonly kind: TKind;
    readonly diagnosticName: string;
    readonly readiness: ReplicationReadinessRequirements;
    readonly isConfigured: (setting: ObsidianLiveSyncSettings) => boolean;
    /** Construct a replicator from the fully merged effective settings. */
    readonly create: (setting: ObsidianLiveSyncSettings) => Promise<LiveSyncAbstractReplicator | undefined | false>;
    readonly userInitiatedOneShot: CapabilitySupport<UserInitiatedOneShotRunner>;
    readonly unattendedOneShot: CapabilitySupport<UnattendedOneShotRunner>;
    readonly continuous: CapabilitySupport<ContinuousRunner>;
    readonly stopActiveTransfer: CapabilitySupport<StopActiveTransferRunner>;
}

/** The atomic pair which identifies the active provider and its replicator. */
export interface ActiveReplicatorContext<TKind extends RemoteType = RemoteType> {
    readonly provider: ReplicatorProviderDefinition<TKind>;
    readonly replicator: LiveSyncAbstractReplicator;
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

    const definitionEntries = Object.entries(definitions) as Array<[string, ReplicatorProviderDefinition]>;
    if (definitionEntries.length !== selectedKinds.size) {
        throw new Error("Replicator provider definitions must match the selected provider kinds.");
    }

    const result = new Map<RemoteType, ReplicatorProviderDefinition>();
    for (const kind of kinds) {
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
export function outcomeFromFiniteOpenReplication(result: void | boolean): ReplicationOutcome {
    return result === true
        ? REPLICATION_COMPLETED
        : replicationFailed(new Error("The provider did not complete finite replication."));
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

export function supportedOpenReplicationOneShot(): SupportedCapability<UserInitiatedOneShotRunner> {
    return {
        kind: "supported",
        run: async (replicator, setting, request) => {
            try {
                const result = await replicator.openReplication(
                    setting,
                    false,
                    request.interaction.kind === "permitted" && request.interaction.permissions.failureRecovery,
                    false
                );
                return outcomeFromFiniteOpenReplication(result);
            } catch (error) {
                return replicationFailed(error);
            }
        },
    };
}

export function supportedOpenReplicationUnattended(): SupportedCapability<UnattendedOneShotRunner> {
    return {
        kind: "supported",
        run: async (replicator, setting, request) => {
            if (request.interaction.kind !== NO_INTERACTION.kind) {
                return replicationBlocked("interaction-required");
            }
            try {
                const result = await replicator.openReplication(setting, false, false, false);
                return outcomeFromFiniteOpenReplication(result);
            } catch (error) {
                return replicationFailed(error);
            }
        },
    };
}

export function supportedOpenReplicationContinuous(): SupportedCapability<ContinuousRunner> {
    return {
        kind: "supported",
        run: async (replicator, setting, request) => {
            if (request.interaction.kind !== NO_INTERACTION.kind) {
                return replicationBlocked("interaction-required");
            }
            try {
                const result = await replicator.openReplication(setting, true, false, false);
                return outcomeFromContinuousOpenReplication(result);
            } catch (error) {
                return replicationFailed(error);
            }
        },
    };
}

/**
 * Adapt the legacy termination hook to the typed active-transfer capability.
 *
 * `terminateSync` is intentionally awaited even though existing replicators
 * implement it synchronously. This keeps the capability boundary valid for a
 * provider whose cancellation work needs to settle asynchronously.
 */
export function supportedStopActiveTransfer(): SupportedCapability<StopActiveTransferRunner> {
    return {
        kind: "supported",
        run: async (replicator) => {
            try {
                await replicator.terminateSync();
                return REPLICATION_COMPLETED;
            } catch (error) {
                return replicationFailed(error);
            }
        },
    };
}

export const CAPABILITY_NOT_IMPLEMENTED: NotImplementedCapability = Object.freeze({
    kind: "not-implemented",
    reason: "capability-not-implemented",
});

export const CAPABILITY_NOT_APPLICABLE: NotApplicableCapability = Object.freeze({
    kind: "not-applicable",
    reason: "capability-not-applicable",
});
