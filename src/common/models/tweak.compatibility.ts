import {
    TweakCompatibilityRules,
    TweakValuesTemplate,
    type TweakComparedKey,
    type TweakReconstruction,
    type TweakValues,
} from "./tweak.definition.ts";

export type TweakAssessmentRelation = "equal" | "different" | "unadvertised";

export interface TweakAssessmentValue {
    readonly present: boolean;
    readonly rawValue: TweakValues[keyof TweakValues];
    readonly effectiveValue: TweakValues[keyof TweakValues];
}

export interface TweakAssessmentEntry {
    readonly key: keyof TweakValues;
    readonly current: TweakAssessmentValue;
    readonly preferred: TweakAssessmentValue;
    readonly relation: TweakAssessmentRelation;
}

export interface TweakTransitionReason {
    readonly key: keyof TweakValues;
    readonly reconstruction: Exclude<TweakReconstruction, "none">;
}

export interface TweakTransition {
    readonly changes: Readonly<TweakValues>;
    readonly reconstruction: TweakReconstruction;
    readonly reasons: readonly TweakTransitionReason[];
}

export interface TweakAssessment {
    readonly alignment: "matched" | "mismatched";
    readonly representationDiffers: boolean;
    readonly entries: readonly TweakAssessmentEntry[];
    readonly adoptPreferred: TweakTransition;
    readonly adoptCurrent: TweakTransition;
    readonly onlyCompatibleLossyDifferences: boolean;
    readonly currentValues: Readonly<TweakValues>;
    readonly preferredValues: Readonly<TweakValues>;
}

type AssessmentSide = "current" | "preferred";
const hasOwn = (value: object, key: PropertyKey): boolean => Object.prototype.hasOwnProperty.call(value, key);

function snapshotTweakValues(values: Readonly<TweakValues>): Readonly<TweakValues> {
    const snapshot: Record<string, TweakValues[keyof TweakValues]> = {};
    for (const key of Object.keys(TweakValuesTemplate) as (keyof TweakValues)[]) {
        if (hasOwn(values, key)) snapshot[key] = values[key];
    }
    return Object.freeze(snapshot) as Readonly<TweakValues>;
}

function assessedValue(
    values: Readonly<TweakValues>,
    key: TweakComparedKey,
    knownDefault: TweakValues[keyof TweakValues]
): TweakAssessmentValue {
    const present = hasOwn(values, key);
    const rawValue = values[key] as TweakValues[keyof TweakValues];
    const effectiveValue = rawValue === undefined ? knownDefault : rawValue;
    return Object.freeze({ present, rawValue, effectiveValue });
}

function highestReconstruction(
    current: TweakReconstruction,
    next: Exclude<TweakReconstruction, "none">
): Exclude<TweakReconstruction, "none"> {
    if (current === "required" || next === "required") return "required";
    return "recommended";
}

function reconstructionForTransition(
    key: keyof TweakValues,
    from: TweakValues[keyof TweakValues],
    to: TweakValues[keyof TweakValues]
): TweakReconstruction {
    const rule = TweakCompatibilityRules.find((candidate) => candidate.key === key);
    if (!rule) return "none";
    let reconstruction: TweakReconstruction = rule.reconstruction;
    const extensibleRule = rule as typeof rule & {
        readonly specificPatterns?: readonly {
            readonly from?: TweakValues[keyof TweakValues];
            readonly to?: TweakValues[keyof TweakValues];
            readonly reconstruction: Exclude<TweakReconstruction, "none">;
        }[];
    };
    for (const pattern of extensibleRule.specificPatterns ?? []) {
        const matchesFrom = hasOwn(pattern, "from") && pattern.from === from;
        const matchesTo = hasOwn(pattern, "to") && pattern.to === to;
        if (matchesFrom || matchesTo) {
            reconstruction = highestReconstruction(reconstruction, pattern.reconstruction);
        }
    }
    return reconstruction;
}

function transition(
    entries: readonly TweakAssessmentEntry[],
    sourceSide: AssessmentSide,
    targetSide: AssessmentSide
): TweakTransition {
    const changes: Partial<Record<keyof TweakValues, TweakValues[keyof TweakValues]>> = {};
    const reasons: TweakTransitionReason[] = [];
    let reconstruction: TweakReconstruction = "none";

    for (const entry of entries) {
        const source = entry[sourceSide];
        const target = entry[targetSide];
        const sourceAdvertised = source.present && source.rawValue !== undefined;
        const targetAdvertised = target.present && target.rawValue !== undefined;
        const effectiveValueDiffers = source.effectiveValue !== target.effectiveValue;
        const shouldFillMissingTarget = !targetAdvertised && sourceAdvertised;
        if (source.effectiveValue === undefined || (!effectiveValueDiffers && !shouldFillMissingTarget)) continue;

        changes[entry.key] = source.effectiveValue;
        if (entry.relation === "equal") continue;

        const effect = reconstructionForTransition(entry.key, target.effectiveValue, source.effectiveValue);
        if (effect === "none") continue;
        const reason = Object.freeze({
            key: entry.key,
            reconstruction: effect,
        }) as TweakTransitionReason;
        reasons.push(reason);
        reconstruction = highestReconstruction(reconstruction, reason.reconstruction);
    }

    return Object.freeze({
        changes: Object.freeze(changes) as Readonly<TweakValues>,
        reconstruction,
        reasons: Object.freeze(reasons),
    });
}

/** Assess the semantic and stored-representation relationship between two tweak snapshots. */
export function assessTweakCompatibility(
    current: Readonly<TweakValues>,
    preferred: Readonly<TweakValues>
): TweakAssessment {
    const currentValues = snapshotTweakValues(current);
    const preferredValues = snapshotTweakValues(preferred);
    let representationDiffers = false;

    const entries = TweakCompatibilityRules.map((rule): TweakAssessmentEntry => {
        const knownDefault = "knownDefault" in rule ? rule.knownDefault : undefined;
        const currentValue = assessedValue(currentValues, rule.key, knownDefault);
        const preferredValue = assessedValue(preferredValues, rule.key, knownDefault);
        const currentAdvertised = currentValue.present && currentValue.rawValue !== undefined;
        const preferredAdvertised = preferredValue.present && preferredValue.rawValue !== undefined;
        let relation: TweakAssessmentRelation;
        if ((!currentAdvertised || !preferredAdvertised) && knownDefault === undefined) {
            relation = "unadvertised";
        } else {
            relation = currentValue.effectiveValue === preferredValue.effectiveValue ? "equal" : "different";
        }
        if (currentValue.present !== preferredValue.present || currentValue.rawValue !== preferredValue.rawValue) {
            representationDiffers = true;
        }
        return Object.freeze({
            key: rule.key,
            current: currentValue,
            preferred: preferredValue,
            relation,
        });
    });
    const frozenEntries = Object.freeze(entries);
    const differences = frozenEntries.filter(({ relation }) => relation === "different");
    const compatibleLossyKeys = new Set<keyof TweakValues>(
        TweakCompatibilityRules.filter((rule) => "compatibleLossyOrder" in rule).map(({ key }) => key)
    );

    return Object.freeze({
        alignment: differences.length === 0 ? "matched" : "mismatched",
        representationDiffers,
        entries: frozenEntries,
        adoptPreferred: transition(frozenEntries, "preferred", "current"),
        adoptCurrent: transition(frozenEntries, "current", "preferred"),
        onlyCompatibleLossyDifferences:
            differences.length > 0 &&
            differences.every(({ key }) => compatibleLossyKeys.has(key)) &&
            !frozenEntries.some(({ relation }) => relation === "unadvertised"),
        currentValues,
        preferredValues,
    });
}
