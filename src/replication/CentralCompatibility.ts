import type { TweakValues } from "@lib/common/types.ts";

/** Stable machine states for one central-remote compatibility assessment. */
export const CENTRAL_COMPATIBILITY_STATUSES = Object.freeze({
    NOT_ASSESSED: "not-assessed",
    ACCEPTED: "accepted",
    REJECTED: "rejected",
} as const);

/** Stable machine reasons carried by a rejected compatibility assessment. */
export const CENTRAL_COMPATIBILITY_REJECTION_REASONS = Object.freeze({
    INCOMPATIBLE_VERSION: "incompatible-version",
    NODE_LOCKED: "node-locked",
    NODE_CLEANED: "node-cleaned",
    TWEAK_MISMATCH: "tweak-mismatch",
} as const);

export type CentralCompatibilityRejectionReason =
    (typeof CENTRAL_COMPATIBILITY_REJECTION_REASONS)[keyof typeof CENTRAL_COMPATIBILITY_REJECTION_REASONS];

export const CENTRAL_COMPATIBILITY_NOT_ASSESSED = Object.freeze({
    status: CENTRAL_COMPATIBILITY_STATUSES.NOT_ASSESSED,
} as const);

export const CENTRAL_COMPATIBILITY_ACCEPTED = Object.freeze({
    status: CENTRAL_COMPATIBILITY_STATUSES.ACCEPTED,
} as const);

export interface CentralCompatibilityRejected {
    readonly status: typeof CENTRAL_COMPATIBILITY_STATUSES.REJECTED;
    readonly reason: CentralCompatibilityRejectionReason;
    readonly preferredTweakValue?: Readonly<TweakValues>;
}

/** Immutable result produced by one provider-local compatibility assessment. */
export type CentralCompatibilityDecision =
    | typeof CENTRAL_COMPATIBILITY_NOT_ASSESSED
    | typeof CENTRAL_COMPATIBILITY_ACCEPTED
    | CentralCompatibilityRejected;

/** Stack-local sink used while a provider owns the connection or client being assessed. */
export type CentralCompatibilityDecisionRecorder = (decision: CentralCompatibilityDecision) => void;

export interface CentralCompatibilityRecoveryHint {
    readonly reason: CentralCompatibilityRejectionReason;
    readonly preferredTweakValue?: Readonly<TweakValues>;
}

export function centralCompatibilityRejected(
    reason: CentralCompatibilityRejectionReason,
    preferredTweakValue?: TweakValues
): CentralCompatibilityRejected {
    return Object.freeze({
        status: CENTRAL_COMPATIBILITY_STATUSES.REJECTED,
        reason,
        ...(preferredTweakValue === undefined
            ? {}
            : { preferredTweakValue: Object.freeze({ ...preferredTweakValue }) }),
    });
}

/** Project only a rejected decision into the generic replication failure path. */
export function centralCompatibilityRecoveryHint(
    decision: CentralCompatibilityDecision
): CentralCompatibilityRecoveryHint | undefined {
    if (decision.status !== CENTRAL_COMPATIBILITY_STATUSES.REJECTED) return undefined;
    return Object.freeze({
        reason: decision.reason,
        ...(decision.preferredTweakValue === undefined
            ? {}
            : { preferredTweakValue: decision.preferredTweakValue }),
    });
}
