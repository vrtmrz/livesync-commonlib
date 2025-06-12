import { Logger } from "./logger";
import { type ObsidianLiveSyncSettings } from "./types";

enum ConditionType {
    PLATFORM_CASE_INSENSITIVE = "platform-case-insensitive",
    PLATFORM_CASE_SENSITIVE = "platform-case-sensitive",
    REMOTE_CASE_SENSITIVE = "remote-case-sensitive",
}
export enum RuleLevel {
    Must,
    Necessary,
    Recommended,
    Optional,
}
// eslint-disable-next-line @typescript-eslint/no-unused-vars
type BaseRule<TType extends string, TValue> = {
    // type: TType;
    level?: RuleLevel;
    requireRebuild?: boolean;
    requireRebuildLocal?: boolean;
    recommendRebuild?: boolean;
    reason?: string;
    condition?: ConditionType[];
    value: TValue;
    obsoleteValues?: TValue[];
};

// Number-related rules
type NumberRuleExact = BaseRule<"number", number> & {};

type NumberRuleRange = BaseRule<"number", number> & {
    min?: number;
    max?: number;
    step?: number;
};

// String-related rules
type StringRangeRule = BaseRule<"string", string> & {
    minLength?: number;
    maxLength?: number;
    regexp?: string;
};

type StringRule = BaseRule<"string", string> & {
    // value: string;
};

// Boolean-related rules
type BooleanRule = BaseRule<"boolean", boolean> & {};

// type NotTarget = BaseRule<"ignored", unknown>;

// Define appropriate rule types based on property types
export type RuleForType<T> = T extends number
    ? NumberRuleExact | NumberRuleRange
    : T extends string
      ? StringRule | StringRangeRule
      : T extends boolean
        ? BooleanRule
        : never;

type OriginalSettings = Partial<ObsidianLiveSyncSettings>;

// Strongly typed regulation mapping
export type DoctorRegulation = {
    version: string;
    rules: {
        [P in keyof OriginalSettings]: RuleForType<OriginalSettings[P]>;
    };
};
export const DoctorRegulationV0_24_16: DoctorRegulation = {
    version: "0.24.16",
    rules: {
        sendChunksBulk: {
            value: false,
            reason: "This is an obsolete setting and we should not enable this no more",
            level: RuleLevel.Must,
        },
        sendChunksBulkMaxSize: {
            value: 1,
            reason: "This is an obsolete setting and we should not enable this no more",
            level: RuleLevel.Must,
        },
        doNotUseFixedRevisionForChunks: {
            value: true,
            reason: "This value has been reverted at v0.24.16 for garbage collection of chunks.",
            level: RuleLevel.Recommended,
        },
        handleFilenameCaseSensitive: {
            value: false,
            reason: "If Self-hosted LiveSync is Case-Sensitive, unexpected file operations may occur when synchronising with Windows, Android or other devices. This value should only be enabled if all devices have a Case-Sensitive file system.",
            requireRebuild: true,
            level: RuleLevel.Recommended,
        },
        useIndexedDBAdapter: {
            value: true,
            requireRebuildLocal: true,
            level: RuleLevel.Optional,
            reason: "The old option is active. This is not a performance-appropriate setting.",
        },
        useEden: {
            reason: "This option is no longer recommended.",
            level: RuleLevel.Optional,
            value: false,
        },
        hashAlg: {
            obsoleteValues: ["sha1", "xxhash32", ""],
            value: "xxhash64",
            level: RuleLevel.Necessary,
            reason: "The hash function is set to the old fallback. This should be retried. This may result in a change to the new fallback.",
        },
        disableCheckingConfigMismatch: {
            value: false,
            level: RuleLevel.Recommended,
            reason: "If you disabled an older version of the dialogue because it was hard to understand, try it once in the latest version.",
        },
        enableCompression: {
            value: false,
            level: RuleLevel.Recommended,
            requireRebuild: true,
            reason: "This option will be sunset soon.",
        },
    },
} as const;
export const DoctorRegulation = DoctorRegulationV0_24_16;

export function checkUnsuitableValues(
    setting: Partial<ObsidianLiveSyncSettings>,
    regulation: DoctorRegulation = DoctorRegulation
): DoctorRegulation {
    const result: DoctorRegulation = {
        version: regulation.version,
        rules: {},
    };
    for (const key in regulation.rules) {
        if (!regulation.rules.hasOwnProperty(key)) continue;
        const rule = regulation.rules[key as keyof OriginalSettings];
        if (!rule) continue;

        const value = setting[key as keyof OriginalSettings];
        if (rule.value === value) {
            Logger(`Rule satisfied: ${key} is ${value}`);
            continue;
        }
        if (typeof value == "number" && "min" in rule && "max" in rule) {
            const min = rule.min ?? Number.MIN_SAFE_INTEGER;
            const max = rule.max ?? Number.MAX_SAFE_INTEGER;
            if (value >= min && value <= max) {
                Logger(`Rule satisfied: ${key} is ${value} between ${min} and ${max}`);
                continue;
            }
        }
        //@ts-ignore
        result.rules[key as keyof OriginalSettings] = rule;
        Logger(`Rule violation: ${key} is ${value} but should be ${rule.value}`);
    }
    return result;
}
