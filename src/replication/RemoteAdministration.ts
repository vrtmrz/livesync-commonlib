import type { RemoteDBSettings } from "@lib/common/types.ts";
import type { LiveSyncAbstractReplicator } from "./LiveSyncAbstractReplicator.ts";
import { CAPABILITY_UNAVAILABLE_REASONS } from "./ProviderCapability.ts";

/** Stable machine identifiers for remote-administration mutations. */
export const REMOTE_ADMINISTRATION_ACTIONS = Object.freeze({
    MARK_RESOLVED: "mark-resolved",
    LOCK: "lock",
    UNLOCK: "unlock",
} as const);

/** Stable machine identifiers for remote-administration settlement. */
export const REMOTE_ADMINISTRATION_RESULT_STATUSES = Object.freeze({
    VERIFIED: "verified",
    VERIFICATION_FAILED: "verification-failed",
} as const);

/** Stable machine identifiers for provider-specific observations. */
export const REMOTE_ADMINISTRATION_OBSERVATION_KINDS = Object.freeze({
    MILESTONE: "milestone",
} as const);

/** Stable machine reasons which must not be used as display or translation keys. */
export const REMOTE_ADMINISTRATION_FAILURE_REASONS = Object.freeze({
    NO_ACTIVE_REPLICATOR: "no-active-replicator",
    CAPABILITY_NOT_IMPLEMENTED: CAPABILITY_UNAVAILABLE_REASONS.NOT_IMPLEMENTED,
    CAPABILITY_NOT_APPLICABLE: CAPABILITY_UNAVAILABLE_REASONS.NOT_APPLICABLE,
    LOCAL_IDENTITY_UNAVAILABLE: "local-identity-unavailable",
    CONNECTION_FAILED: "connection-failed",
    MILESTONE_NOT_FOUND: "milestone-not-found",
    MILESTONE_READ_FAILED: "milestone-read-failed",
    POSTCONDITION_MISMATCH: "postcondition-mismatch",
} as const);

export type RemoteAdministrationAction =
    (typeof REMOTE_ADMINISTRATION_ACTIONS)[keyof typeof REMOTE_ADMINISTRATION_ACTIONS];
export type RemoteAdministrationFailureReason =
    (typeof REMOTE_ADMINISTRATION_FAILURE_REASONS)[keyof typeof REMOTE_ADMINISTRATION_FAILURE_REASONS];

export interface RemoteAdministrationRequest {
    readonly action: RemoteAdministrationAction;
}

export interface MilestoneRemoteAdministrationObservation {
    readonly kind: typeof REMOTE_ADMINISTRATION_OBSERVATION_KINDS.MILESTONE;
    readonly locked: boolean;
    readonly accepted: boolean;
    readonly nodeId: string;
}

export type RemoteAdministrationObservation = MilestoneRemoteAdministrationObservation;

export interface RemoteAdministrationVerified {
    readonly status: typeof REMOTE_ADMINISTRATION_RESULT_STATUSES.VERIFIED;
    readonly observation: RemoteAdministrationObservation;
}

export interface RemoteAdministrationVerificationFailed {
    readonly status: typeof REMOTE_ADMINISTRATION_RESULT_STATUSES.VERIFICATION_FAILED;
    readonly reason: RemoteAdministrationFailureReason;
    readonly observation?: RemoteAdministrationObservation;
    readonly detail?: unknown;
}

/**
 * Settled remote-administration result.
 *
 * Provider runners return verification failures. They must allow mutation
 * exceptions to reject so a compatibility exit policy cannot hide a failed
 * write behind an earlier command's historical success code.
 */
export type RemoteAdministrationResult = RemoteAdministrationVerified | RemoteAdministrationVerificationFailed;

export type RemoteAdministrationRunner = (
    replicator: LiveSyncAbstractReplicator,
    setting: RemoteDBSettings,
    request: RemoteAdministrationRequest
) => Promise<RemoteAdministrationResult>;

export function remoteAdministrationVerified(
    observation: RemoteAdministrationObservation
): RemoteAdministrationVerified {
    return { status: REMOTE_ADMINISTRATION_RESULT_STATUSES.VERIFIED, observation };
}

export function remoteAdministrationVerificationFailed(
    reason: RemoteAdministrationFailureReason,
    options: {
        readonly observation?: RemoteAdministrationObservation;
        readonly detail?: unknown;
    } = {}
): RemoteAdministrationVerificationFailed {
    return {
        status: REMOTE_ADMINISTRATION_RESULT_STATUSES.VERIFICATION_FAILED,
        reason,
        ...options,
    };
}

export function isRemoteAdministrationVerified(
    result: RemoteAdministrationResult
): result is RemoteAdministrationVerified {
    return result.status === REMOTE_ADMINISTRATION_RESULT_STATUSES.VERIFIED;
}

/** Apply the legacy mutation selected by a typed administration request. */
export async function applyRemoteAdministrationMutation(
    replicator: LiveSyncAbstractReplicator,
    setting: RemoteDBSettings,
    action: RemoteAdministrationAction
): Promise<void> {
    switch (action) {
        case REMOTE_ADMINISTRATION_ACTIONS.MARK_RESOLVED:
            await replicator.markRemoteResolved(setting);
            return;
        case REMOTE_ADMINISTRATION_ACTIONS.LOCK:
            await replicator.markRemoteLocked(setting, true, false);
            return;
        case REMOTE_ADMINISTRATION_ACTIONS.UNLOCK:
            await replicator.markRemoteLocked(setting, false, false);
            return;
    }
}

/** Return whether an observed milestone proves the requested postcondition. */
export function milestoneSatisfiesRemoteAdministration(
    action: RemoteAdministrationAction,
    observation: MilestoneRemoteAdministrationObservation
): boolean {
    switch (action) {
        case REMOTE_ADMINISTRATION_ACTIONS.MARK_RESOLVED:
            return observation.accepted;
        case REMOTE_ADMINISTRATION_ACTIONS.LOCK:
            return observation.locked;
        case REMOTE_ADMINISTRATION_ACTIONS.UNLOCK:
            return !observation.locked;
    }
}
