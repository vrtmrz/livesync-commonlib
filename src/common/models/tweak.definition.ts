import { ChunkAlgorithms, E2EEAlgorithms } from "./setting.const";
import type { ObsidianLiveSyncSettings } from "./setting.type";
import { DEFAULT_SETTINGS } from "./setting.const.defaults";

export type TweakReconstruction = "none" | "recommended" | "required";

type TweakCompatibilityRule = {
    readonly key: keyof ObsidianLiveSyncSettings;
    readonly templateValue: ObsidianLiveSyncSettings[keyof ObsidianLiveSyncSettings];
    readonly reconstruction: TweakReconstruction;
    readonly knownDefault?: ObsidianLiveSyncSettings[keyof ObsidianLiveSyncSettings];
    readonly compatibleLossyOrder?: number;
    readonly specificPatterns?: readonly {
        readonly from?: ObsidianLiveSyncSettings[keyof ObsidianLiveSyncSettings];
        readonly to?: ObsidianLiveSyncSettings[keyof ObsidianLiveSyncSettings];
        readonly reconstruction: Exclude<TweakReconstruction, "none">;
    }[];
};

/**
 * Single source for tweak comparison semantics and the maintained legacy
 * compatibility projections below.
 */
export const TweakCompatibilityRules = Object.freeze([
    { key: "minimumChunkSize", templateValue: 20, reconstruction: "none" },
    { key: "longLineThreshold", templateValue: 250, reconstruction: "none" },
    { key: "encrypt", templateValue: false, reconstruction: "required" },
    { key: "usePathObfuscation", templateValue: false, reconstruction: "required" },
    { key: "enableCompression", templateValue: false, reconstruction: "none" },
    { key: "useEden", templateValue: false, reconstruction: "none" },
    { key: "customChunkSize", templateValue: 0, reconstruction: "recommended", compatibleLossyOrder: 1 },
    { key: "useDynamicIterationCount", templateValue: false, reconstruction: "required" },
    { key: "hashAlg", templateValue: "xxhash64", reconstruction: "recommended", compatibleLossyOrder: 0 },
    { key: "enableChunkSplitterV2", templateValue: false, reconstruction: "none" },
    { key: "maxChunksInEden", templateValue: 10, reconstruction: "none" },
    { key: "maxTotalLengthInEden", templateValue: 1024, reconstruction: "none" },
    { key: "maxAgeInEden", templateValue: 10, reconstruction: "none" },
    {
        key: "usePluginSyncV2",
        templateValue: false,
        reconstruction: "none",
        knownDefault: false,
    },
    {
        key: "handleFilenameCaseSensitive",
        templateValue: false,
        reconstruction: "required",
        knownDefault: false,
    },
    { key: "useSegmenter", templateValue: false, reconstruction: "none" },
    {
        key: "E2EEAlgorithm",
        templateValue: E2EEAlgorithms.V2,
        reconstruction: "none",
        knownDefault: DEFAULT_SETTINGS.E2EEAlgorithm,
    },
    {
        key: "chunkSplitterVersion",
        templateValue: ChunkAlgorithms.RabinKarp,
        reconstruction: "recommended",
        knownDefault: DEFAULT_SETTINGS.chunkSplitterVersion,
        compatibleLossyOrder: 2,
    },
] as const satisfies readonly TweakCompatibilityRule[]);

export type TweakComparedKey = (typeof TweakCompatibilityRules)[number]["key"];

export const TweakValuesShouldMatchedTemplate = Object.fromEntries(
    TweakCompatibilityRules.map(({ key, templateValue }) => [key, templateValue])
) as Pick<ObsidianLiveSyncSettings, TweakComparedKey>;

type TweakKeys = keyof TweakValues;

export const IncompatibleChanges: TweakKeys[] = [
    ...TweakCompatibilityRules.filter(({ reconstruction }) => reconstruction === "required").map(({ key }) => key),
] as TweakKeys[];

export const CompatibleButLossyChanges: TweakKeys[] = TweakCompatibilityRules.filter(
    (rule): rule is (typeof TweakCompatibilityRules)[number] & { readonly compatibleLossyOrder: number } =>
        "compatibleLossyOrder" in rule
)
    .slice()
    .sort((left, right) => left.compatibleLossyOrder - right.compatibleLossyOrder)
    .map(({ key }) => key);

type IncompatibleRecommendationPatterns<T extends TweakKeys> = {
    key: T;
    isRecommendation?: boolean;
} & (
    | {
          from: TweakValues[T];
          to: TweakValues[T];
      }
    | {
          from: TweakValues[T];
      }
    | {
          to: TweakValues[T];
      }
);

export const IncompatibleChangesInSpecificPattern: IncompatibleRecommendationPatterns<TweakKeys>[] = (
    TweakCompatibilityRules as readonly TweakCompatibilityRule[]
).flatMap((rule) =>
    (rule.specificPatterns ?? []).map((pattern) => ({
        key: rule.key,
        ...(Object.prototype.hasOwnProperty.call(pattern, "from") ? { from: pattern.from } : {}),
        ...(Object.prototype.hasOwnProperty.call(pattern, "to") ? { to: pattern.to } : {}),
        ...(pattern.reconstruction === "recommended" ? { isRecommendation: true } : {}),
    }))
) as IncompatibleRecommendationPatterns<TweakKeys>[];

export const TweakValuesRecommendedTemplate: Partial<ObsidianLiveSyncSettings> = {
    useIgnoreFiles: false,
    useCustomRequestHandler: false,

    batch_size: 25,
    batches_limit: 25,
    // useIndexedDBAdapter: false,
    useTimeouts: false,
    readChunksOnline: true,
    hashCacheMaxCount: 300,
    hashCacheMaxAmount: 50,
    concurrencyOfReadChunksOnline: 40,
    minimumIntervalOfReadChunksOnline: 50,
    ignoreFiles: ".gitignore",
    syncMaxSizeInMB: 50,
    enableChunkSplitterV2: false,
    usePluginSyncV2: true,
    handleFilenameCaseSensitive: false,
    E2EEAlgorithm: E2EEAlgorithms.V2,
    chunkSplitterVersion: ChunkAlgorithms.RabinKarp,
} satisfies Partial<ObsidianLiveSyncSettings>;
export const TweakValuesDefault: Partial<ObsidianLiveSyncSettings> = {
    ...Object.fromEntries(
        TweakCompatibilityRules.filter((rule) => "knownDefault" in rule && rule.key !== "handleFilenameCaseSensitive").map(
            ({ key, knownDefault }) => [key, knownDefault]
        )
    ),
    tweakModified: DEFAULT_SETTINGS.tweakModified,
} satisfies Partial<ObsidianLiveSyncSettings>;

export const TweakValuesTemplate = {
    ...TweakValuesRecommendedTemplate,
    ...TweakValuesShouldMatchedTemplate,
    tweakModified: 0,
} satisfies Partial<ObsidianLiveSyncSettings>;
export type TweakValues = Partial<typeof TweakValuesTemplate>;

export const DEVICE_ID_PREFERRED = "PREFERRED";

export const RemotePreferredTweakStatuses = {
    AVAILABLE: "available",
    NOT_CONFIGURED: "not-configured",
    UNAVAILABLE: "unavailable",
    UNSUPPORTED: "unsupported",
} as const;

export type RemotePreferredTweakStatus =
    (typeof RemotePreferredTweakStatuses)[keyof typeof RemotePreferredTweakStatuses];

export const RemotePreferredTweakNotConfiguredReasons = {
    MILESTONE_MISSING: "milestone-missing",
    PREFERRED_VALUES_MISSING: "preferred-values-missing",
} as const;

export type RemotePreferredTweakNotConfiguredReason =
    (typeof RemotePreferredTweakNotConfiguredReasons)[keyof typeof RemotePreferredTweakNotConfiguredReasons];

export type RemotePreferredTweakResult =
    | {
          status: typeof RemotePreferredTweakStatuses.AVAILABLE;
          values: TweakValues;
      }
    | {
          status: typeof RemotePreferredTweakStatuses.NOT_CONFIGURED;
          reason: RemotePreferredTweakNotConfiguredReason;
      }
    | {
          status: typeof RemotePreferredTweakStatuses.UNAVAILABLE;
          error: unknown;
      }
    | {
          status: typeof RemotePreferredTweakStatuses.UNSUPPORTED;
      };
