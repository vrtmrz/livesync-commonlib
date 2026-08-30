import type { RemoteDBSettings } from "@lib/common/types.ts";
import { CAPABILITY_UNAVAILABLE_REASONS } from "./ProviderCapability.ts";
import type { ReplicatorInstance } from "./ReplicatorInstance.ts";

/** Stable machine identifiers for central-remote administration mutations. */
export const CENTRAL_REMOTE_ADMINISTRATION_ACTIONS = Object.freeze({
    MARK_RESOLVED: "mark-resolved",
    LOCK: "lock",
    UNLOCK: "unlock",
} as const);

/** Stable machine identifiers for central-remote administration settlement. */
export const CENTRAL_REMOTE_ADMINISTRATION_RESULT_STATUSES = Object.freeze({
    VERIFIED: "verified",
    VERIFICATION_FAILED: "verification-failed",
} as const);

/** Stable machine identifiers for provider-specific observations. */
export const CENTRAL_REMOTE_ADMINISTRATION_OBSERVATION_KINDS = Object.freeze({
    MILESTONE: "milestone",
} as const);

/** Stable machine reasons which must not be used as display or translation keys. */
export const CENTRAL_REMOTE_ADMINISTRATION_FAILURE_REASONS = Object.freeze({
    NO_ACTIVE_REPLICATOR: "no-active-replicator",
    CAPABILITY_NOT_IMPLEMENTED: CAPABILITY_UNAVAILABLE_REASONS.NOT_IMPLEMENTED,
    CAPABILITY_NOT_APPLICABLE: CAPABILITY_UNAVAILABLE_REASONS.NOT_APPLICABLE,
    LOCAL_IDENTITY_UNAVAILABLE: "local-identity-unavailable",
    CONNECTION_FAILED: "connection-failed",
    MILESTONE_NOT_FOUND: "milestone-not-found",
    MILESTONE_READ_FAILED: "milestone-read-failed",
    POSTCONDITION_MISMATCH: "postcondition-mismatch",
} as const);

export type CentralRemoteAdministrationAction =
    (typeof CENTRAL_REMOTE_ADMINISTRATION_ACTIONS)[keyof typeof CENTRAL_REMOTE_ADMINISTRATION_ACTIONS];
export type CentralRemoteAdministrationFailureReason =
    (typeof CENTRAL_REMOTE_ADMINISTRATION_FAILURE_REASONS)[keyof typeof CENTRAL_REMOTE_ADMINISTRATION_FAILURE_REASONS];

export interface CentralRemoteAdministrationRequest {
    readonly action: CentralRemoteAdministrationAction;
}

export interface MilestoneCentralRemoteAdministrationObservation {
    readonly kind: typeof CENTRAL_REMOTE_ADMINISTRATION_OBSERVATION_KINDS.MILESTONE;
    readonly locked: boolean;
    readonly accepted: boolean;
    readonly nodeId: string;
}

export type CentralRemoteAdministrationObservation = MilestoneCentralRemoteAdministrationObservation;

export interface CentralRemoteAdministrationVerified {
    readonly status: typeof CENTRAL_REMOTE_ADMINISTRATION_RESULT_STATUSES.VERIFIED;
    readonly observation: CentralRemoteAdministrationObservation;
}

export interface CentralRemoteAdministrationVerificationFailed {
    readonly status: typeof CENTRAL_REMOTE_ADMINISTRATION_RESULT_STATUSES.VERIFICATION_FAILED;
    readonly reason: CentralRemoteAdministrationFailureReason;
    readonly observation?: CentralRemoteAdministrationObservation;
    readonly detail?: unknown;
}

/**
 * Settled central-remote administration result.
 *
 * Provider runners return verification failures. They must allow mutation
 * exceptions to reject so a compatibility exit policy cannot hide a failed
 * write behind an earlier command's historical success code.
 */
export type CentralRemoteAdministrationResult =
    | CentralRemoteAdministrationVerified
    | CentralRemoteAdministrationVerificationFailed;

/** Operations required by a provider which owns central remote administration. */
export interface CentralRemoteAdministrationReplicator extends ReplicatorInstance {
    readonly nodeid: string;
    markRemoteResolved(setting: RemoteDBSettings): Promise<void>;
    markRemoteLocked(setting: RemoteDBSettings, locked: boolean, lockByClean: boolean): Promise<void>;
}

/** Provider boundary which must narrow the active instance before mutation. */
export type CentralRemoteAdministrationRunner = (
    replicator: ReplicatorInstance,
    setting: RemoteDBSettings,
    request: CentralRemoteAdministrationRequest
) => Promise<CentralRemoteAdministrationResult>;

export function centralRemoteAdministrationVerified(
    observation: CentralRemoteAdministrationObservation
): CentralRemoteAdministrationVerified {
    return { status: CENTRAL_REMOTE_ADMINISTRATION_RESULT_STATUSES.VERIFIED, observation };
}

export function centralRemoteAdministrationVerificationFailed(
    reason: CentralRemoteAdministrationFailureReason,
    options: {
        readonly observation?: CentralRemoteAdministrationObservation;
        readonly detail?: unknown;
    } = {}
): CentralRemoteAdministrationVerificationFailed {
    return {
        status: CENTRAL_REMOTE_ADMINISTRATION_RESULT_STATUSES.VERIFICATION_FAILED,
        reason,
        ...options,
    };
}

export function isCentralRemoteAdministrationVerified(
    result: CentralRemoteAdministrationResult
): result is CentralRemoteAdministrationVerified {
    return result.status === CENTRAL_REMOTE_ADMINISTRATION_RESULT_STATUSES.VERIFIED;
}

/** Apply the legacy mutation selected by a typed administration request. */
export async function applyCentralRemoteAdministrationMutation(
    replicator: CentralRemoteAdministrationReplicator,
    setting: RemoteDBSettings,
    action: CentralRemoteAdministrationAction
): Promise<void> {
    switch (action) {
        case CENTRAL_REMOTE_ADMINISTRATION_ACTIONS.MARK_RESOLVED:
            await replicator.markRemoteResolved(setting);
            return;
        case CENTRAL_REMOTE_ADMINISTRATION_ACTIONS.LOCK:
            await replicator.markRemoteLocked(setting, true, false);
            return;
        case CENTRAL_REMOTE_ADMINISTRATION_ACTIONS.UNLOCK:
            await replicator.markRemoteLocked(setting, false, false);
            return;
    }
}

/** Return whether an observed milestone proves the requested postcondition. */
export function milestoneSatisfiesCentralRemoteAdministration(
    action: CentralRemoteAdministrationAction,
    observation: MilestoneCentralRemoteAdministrationObservation
): boolean {
    switch (action) {
        case CENTRAL_REMOTE_ADMINISTRATION_ACTIONS.MARK_RESOLVED:
            return observation.accepted;
        case CENTRAL_REMOTE_ADMINISTRATION_ACTIONS.LOCK:
            return observation.locked;
        case CENTRAL_REMOTE_ADMINISTRATION_ACTIONS.UNLOCK:
            return !observation.locked;
    }
}
