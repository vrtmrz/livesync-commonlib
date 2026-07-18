import { ChunkAlgorithms, CURRENT_SETTING_VERSION, E2EEAlgorithms, REMOTE_COUCHDB } from "./setting.const";
import { PREFERRED_BASE } from "./setting.const.preferred";
import { AutoAccepting, type ObsidianLiveSyncSettings, type P2PSyncSetting } from "./setting.type";
import type { CustomRegExpSourceList } from "./shared.type.util";

export const P2P_DEFAULT_SETTINGS: P2PSyncSetting = {
    P2P_Enabled: false,
    P2P_AutoAccepting: AutoAccepting.NONE,
    P2P_AppID: "self-hosted-livesync",
    P2P_roomID: "",
    P2P_passphrase: "",
    P2P_relays: "wss://exp-relay.vrtmrz.net/",
    P2P_AutoBroadcast: false,
    P2P_AutoStart: false,
    P2P_AutoSyncPeers: "",
    P2P_AutoWatchPeers: "",
    P2P_SyncOnReplication: "",
    P2P_RebuildFrom: "",
    P2P_AutoAcceptingPeers: "",
    P2P_AutoDenyingPeers: "",
    P2P_IsHeadless: false,
    P2P_DevicePeerName: "",
    P2P_turnServers: "",
    P2P_turnUsername: "",
    P2P_turnCredential: "",
    P2P_useDiagRTC: false,
} as const;

/**
 * Conservative fallback values used to complete stored settings.
 *
 * Keep these values compatible with existing installations. Defaults intended
 * only for a newly created Vault belong in {@link NEW_VAULT_SETTINGS}.
 */
export const SETTINGS_SCHEMA_DEFAULTS: ObsidianLiveSyncSettings = {
    remoteType: REMOTE_COUCHDB,
    useCustomRequestHandler: false,
    couchDB_URI: "",
    couchDB_USER: "",
    couchDB_PASSWORD: "",
    couchDB_DBNAME: "",
    liveSync: false,
    syncOnSave: false,
    syncOnStart: false,
    savingDelay: 200,
    lessInformationInLog: false,
    gcDelay: 300,
    versionUpFlash: "",
    minimumChunkSize: 20,
    longLineThreshold: 250,
    showVerboseLog: false,
    suspendFileWatching: false,
    trashInsteadDelete: true,
    periodicReplication: false,
    periodicReplicationInterval: 60,
    syncOnFileOpen: false,
    encrypt: false,
    passphrase: "",
    usePathObfuscation: false,
    doNotDeleteFolder: false,
    resolveConflictsByNewerFile: false,
    batchSave: false,
    batchSaveMinimumDelay: 5,
    batchSaveMaximumDelay: 60,
    deviceAndVaultName: "",
    usePluginSettings: false,
    showOwnPlugins: false,
    showStatusOnEditor: true,
    showStatusOnStatusbar: true,
    showOnlyIconsOnEditor: false,
    hideFileWarningNotice: false,
    networkWarningStyle: "",
    usePluginSync: false,
    autoSweepPlugins: false,
    autoSweepPluginsPeriodic: false,
    notifyPluginOrSettingUpdated: false,
    checkIntegrityOnSave: false,
    batch_size: 25,
    batches_limit: 25,
    useHistory: false,
    disableRequestURI: false,
    skipOlderFilesOnSync: true,
    checkConflictOnlyOnOpen: false,
    showMergeDialogOnlyOnActive: false,
    syncInternalFiles: false,
    syncInternalFilesBeforeReplication: false,
    syncInternalFilesIgnorePatterns:
        "\\/node_modules\\/, \\/\\.git\\/, \\/obsidian-livesync\\/" as CustomRegExpSourceList<",">,
    syncInternalFilesTargetPatterns: "" as CustomRegExpSourceList<",">,
    syncInternalFilesInterval: 60,
    additionalSuffixOfDatabaseName: "",
    ignoreVersionCheck: false,
    lastReadUpdates: 0,
    deleteMetadataOfDeletedFiles: false,
    syncIgnoreRegEx: "" as CustomRegExpSourceList<"|[]|">,
    syncOnlyRegEx: "" as CustomRegExpSourceList<"|[]|">,
    customChunkSize: 0,
    readChunksOnline: true,
    watchInternalFileChanges: true,
    automaticallyDeleteMetadataOfDeletedFiles: 0,
    disableMarkdownAutoMerge: false,
    writeDocumentsIfConflicted: false,
    useDynamicIterationCount: false,
    syncAfterMerge: false,
    configPassphraseStore: "",
    encryptedPassphrase: "",
    encryptedCouchDBConnection: "",
    permitEmptyPassphrase: false,
    remoteConfigurations: {},
    activeConfigurationId: "",
    P2P_ActiveRemoteConfigurationId: "",
    useIndexedDBAdapter: false,
    useTimeouts: false,
    writeLogToTheFile: false,
    doNotPaceReplication: false,
    hashCacheMaxCount: 300,
    hashCacheMaxAmount: 50,
    concurrencyOfReadChunksOnline: 40,
    minimumIntervalOfReadChunksOnline: 50,
    hashAlg: "xxhash64",
    suspendParseReplicationResult: false,
    doNotSuspendOnFetching: false,
    useIgnoreFiles: false,
    ignoreFiles: ".gitignore",
    syncOnEditorSave: false,
    keepReplicationActiveInBackground: false,
    pluginSyncExtendedSetting: {},
    syncMaxSizeInMB: 50,
    settingSyncFile: "",
    writeCredentialsForSettingSync: false,
    notifyAllSettingSyncFile: false,
    isConfigured: undefined,
    settingVersion: CURRENT_SETTING_VERSION,
    enableCompression: false,
    accessKey: "",
    bucket: "",
    endpoint: "",
    region: "auto",
    secretKey: "",
    useEden: false,
    maxChunksInEden: 10,
    maxTotalLengthInEden: 1024,
    maxAgeInEden: 10,
    disableCheckingConfigMismatch: false,
    autoAcceptCompatibleTweak: undefined,
    displayLanguage: "",
    /**
     * @deprecated
     */
    enableChunkSplitterV2: false,
    disableWorkerForGeneratingChunks: false,
    processSmallFilesInUIThread: false,
    notifyThresholdOfRemoteStorageSize: -1,

    usePluginSyncV2: false,
    usePluginEtc: false,
    handleFilenameCaseSensitive: undefined!,
    doNotUseFixedRevisionForChunks: true,
    showLongerLogInsideEditor: false,
    sendChunksBulk: false,
    sendChunksBulkMaxSize: 1,
    /**
     * @deprecated
     * This setting is no longer used and will be removed in the future.
     */
    useSegmenter: false,
    useAdvancedMode: false,
    usePowerUserMode: false,
    useEdgeCaseMode: false,
    enableDebugTools: false,
    suppressNotifyHiddenFilesChange: false,
    syncMinimumInterval: 2000,
    ...P2P_DEFAULT_SETTINGS,
    doctorProcessedVersion: "",

    bucketCustomHeaders: "",
    couchDB_CustomHeaders: "",
    useJWT: false,
    jwtAlgorithm: "",
    jwtKey: "",
    jwtKid: "",
    jwtSub: "",
    jwtExpDuration: 5,
    useRequestAPI: false,
    bucketPrefix: "",
    chunkSplitterVersion: ChunkAlgorithms.RabinKarp,
    E2EEAlgorithm: E2EEAlgorithms.V2,
    processSizeMismatchedFiles: false,
    forcePathStyle: true,
    syncInternalFileOverwritePatterns: "" as CustomRegExpSourceList<",">,
    useOnlyLocalChunk: false,
    maxMTimeForReflectEvents: 0,
    tweakModified: undefined,
};

/**
 * Initial values for a Vault which has never stored Self-hosted LiveSync settings.
 *
 * This object is deliberately separate from schema fallbacks so that future
 * releases can improve new-user defaults without changing existing choices.
 */
export const NEW_VAULT_SETTINGS: ObsidianLiveSyncSettings = {
    ...SETTINGS_SCHEMA_DEFAULTS,
    ...PREFERRED_BASE,
    remoteConfigurations: {},
    pluginSyncExtendedSetting: {},
};

/** Create an independently mutable copy of the current new-Vault settings. */
export function createNewVaultSettings(): ObsidianLiveSyncSettings {
    return {
        ...NEW_VAULT_SETTINGS,
        remoteConfigurations: {},
        pluginSyncExtendedSetting: {},
    };
}

/**
 * Compatibility name for the conservative setting-schema fallbacks.
 */
export const DEFAULT_SETTINGS = SETTINGS_SCHEMA_DEFAULTS;
