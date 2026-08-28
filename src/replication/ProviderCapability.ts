/** Stable machine values for provider capability availability. */
export const CAPABILITY_SUPPORT_KINDS = Object.freeze({
    SUPPORTED: "supported",
    NOT_IMPLEMENTED: "not-implemented",
    NOT_APPLICABLE: "not-applicable",
} as const);

/** Stable machine reasons for an unavailable provider capability. */
export const CAPABILITY_UNAVAILABLE_REASONS = Object.freeze({
    NOT_IMPLEMENTED: "capability-not-implemented",
    NOT_APPLICABLE: "capability-not-applicable",
} as const);

/** A declared role is available, but its implementation is not included. */
export type NotImplementedCapability = {
    readonly kind: typeof CAPABILITY_SUPPORT_KINDS.NOT_IMPLEMENTED;
    readonly reason: typeof CAPABILITY_UNAVAILABLE_REASONS.NOT_IMPLEMENTED;
};

/** A declared role does not apply to this provider. */
export type NotApplicableCapability = {
    readonly kind: typeof CAPABILITY_SUPPORT_KINDS.NOT_APPLICABLE;
    readonly reason: typeof CAPABILITY_UNAVAILABLE_REASONS.NOT_APPLICABLE;
};

export type SupportedCapability<TRole> = {
    readonly kind: typeof CAPABILITY_SUPPORT_KINDS.SUPPORTED;
    readonly run: TRole;
};

/** Provider capability declaration correlated with the role runner. */
export type CapabilitySupport<TRole> = SupportedCapability<TRole> | NotImplementedCapability | NotApplicableCapability;

export const CAPABILITY_NOT_IMPLEMENTED: NotImplementedCapability = Object.freeze({
    kind: CAPABILITY_SUPPORT_KINDS.NOT_IMPLEMENTED,
    reason: CAPABILITY_UNAVAILABLE_REASONS.NOT_IMPLEMENTED,
});

export const CAPABILITY_NOT_APPLICABLE: NotApplicableCapability = Object.freeze({
    kind: CAPABILITY_SUPPORT_KINDS.NOT_APPLICABLE,
    reason: CAPABILITY_UNAVAILABLE_REASONS.NOT_APPLICABLE,
});

/** Declare one implemented provider capability without repeating its machine value. */
export function supportedCapability<TRole>(run: TRole): SupportedCapability<TRole> {
    return { kind: CAPABILITY_SUPPORT_KINDS.SUPPORTED, run };
}
