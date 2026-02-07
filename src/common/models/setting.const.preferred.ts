import { E2EEAlgorithms } from "./setting.const";
import type { ObsidianLiveSyncSettings } from "./setting.type";

export const PREFERRED_BASE: Partial<ObsidianLiveSyncSettings> = {
    syncMaxSizeInMB: 50,
    chunkSplitterVersion: "v3-rabin-karp",
    doNotUseFixedRevisionForChunks: false,
    usePluginSyncV2: true,
    handleFilenameCaseSensitive: false,
    E2EEAlgorithm: E2EEAlgorithms.V2,
};

export const PREFERRED_SETTING_CLOUDANT: Partial<ObsidianLiveSyncSettings> = {
    ...PREFERRED_BASE,
    customChunkSize: 0,
    sendChunksBulkMaxSize: 1,
    concurrencyOfReadChunksOnline: 100,
    minimumIntervalOfReadChunksOnline: 333,
};
export const PREFERRED_SETTING_SELF_HOSTED: Partial<ObsidianLiveSyncSettings> = {
    ...PREFERRED_BASE,
    customChunkSize: 50,
    sendChunksBulkMaxSize: 1,
    concurrencyOfReadChunksOnline: 30,
    minimumIntervalOfReadChunksOnline: 25,
};
export const PREFERRED_JOURNAL_SYNC: Partial<ObsidianLiveSyncSettings> = {
    ...PREFERRED_BASE,
    customChunkSize: 10,
    concurrencyOfReadChunksOnline: 30,
    minimumIntervalOfReadChunksOnline: 25,
};
