import { describe, expect, it } from "vitest";
import type { TweakValues } from "@lib/common/types.ts";
import {
    CENTRAL_COMPATIBILITY_ACCEPTED,
    CENTRAL_COMPATIBILITY_NOT_ASSESSED,
    CENTRAL_COMPATIBILITY_REJECTION_REASONS,
    centralCompatibilityRecoveryHint,
    centralCompatibilityRejected,
} from "./CentralCompatibility.ts";

describe("central compatibility decisions", () => {
    it("does not project an unassessed or accepted decision into recovery", () => {
        expect(centralCompatibilityRecoveryHint(CENTRAL_COMPATIBILITY_NOT_ASSESSED)).toBeUndefined();
        expect(centralCompatibilityRecoveryHint(CENTRAL_COMPATIBILITY_ACCEPTED)).toBeUndefined();
    });

    it("copies a rejected tweak decision into one immutable recovery hint", () => {
        const preferred = { customChunkSize: 60 } as TweakValues;
        const decision = centralCompatibilityRejected(
            CENTRAL_COMPATIBILITY_REJECTION_REASONS.TWEAK_MISMATCH,
            preferred
        );
        preferred.customChunkSize = 120;

        expect(centralCompatibilityRecoveryHint(decision)).toEqual({
            reason: CENTRAL_COMPATIBILITY_REJECTION_REASONS.TWEAK_MISMATCH,
            preferredTweakValue: { customChunkSize: 60 },
        });
        expect(Object.isFrozen(decision)).toBe(true);
        expect(Object.isFrozen(decision.preferredTweakValue)).toBe(true);
    });
});
