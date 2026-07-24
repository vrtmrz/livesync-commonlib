import { ChunkAlgorithms, E2EEAlgorithms } from "./setting.const";
import type { ObsidianLiveSyncSettings } from "./setting.type";
import { DEFAULT_SETTINGS } from "./setting.const.defaults";

export const TweakValuesShouldMatchedTemplate: Partial<ObsidianLiveSyncSettings> = {
    minimumChunkSize: 20,
    longLineThreshold: 250,
    encrypt: false,
    usePathObfuscation: false,
    enableCompression: false,
    useEden: false,
    customChunkSize: 0,
    useDynamicIterationCount: false,
    hashAlg: "xxhash64",
    enableChunkSplitterV2: false,
    maxChunksInEden: 10,
    maxTotalLengthInEden: 1024,
    maxAgeInEden: 10,
    usePluginSyncV2: false,
    handleFilenameCaseSensitive: false,
    useSegmenter: false,
    E2EEAlgorithm: E2EEAlgorithms.V2,
    chunkSplitterVersion: ChunkAlgorithms.RabinKarp,
} satisfies Partial<ObsidianLiveSyncSettings>;

type TweakKeys = keyof TweakValues;

export const IncompatibleChanges: TweakKeys[] = [
    "encrypt",
    "usePathObfuscation",
    "useDynamicIterationCount",
    "handleFilenameCaseSensitive",
] as const;

export const CompatibleButLossyChanges: TweakKeys[] = ["hashAlg", "customChunkSize", "chunkSplitterVersion"] as const;

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

export const IncompatibleChangesInSpecificPattern: IncompatibleRecommendationPatterns<TweakKeys>[] = [];

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
    usePluginSyncV2: false,
    E2EEAlgorithm: DEFAULT_SETTINGS.E2EEAlgorithm,
    chunkSplitterVersion: DEFAULT_SETTINGS.chunkSplitterVersion,
    tweakModified: DEFAULT_SETTINGS.tweakModified,
} satisfies Partial<ObsidianLiveSyncSettings>;

export const TweakValuesTemplate = {
    ...TweakValuesRecommendedTemplate,
    ...TweakValuesShouldMatchedTemplate,
    tweakModified: 0,
} satisfies Partial<ObsidianLiveSyncSettings>;
export type TweakValues = Partial<typeof TweakValuesTemplate>;

export const DEVICE_ID_PREFERRED = "PREFERRED";
