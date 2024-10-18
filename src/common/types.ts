import type { I18N_LANGS } from "./rosetta";

import type { TaggedType } from "octagonal-wheels/common/types";
export type { TaggedType };

export { LOG_LEVEL_DEBUG, LOG_LEVEL_INFO, LOG_LEVEL_NOTICE, LOG_LEVEL_URGENT, LOG_LEVEL_VERBOSE, } from "octagonal-wheels/common/logger.js";
export type { LOG_LEVEL } from "octagonal-wheels/common/logger.js";
import { RESULT_NOT_FOUND, RESULT_TIMED_OUT } from "octagonal-wheels/common/const.js";
export { RESULT_NOT_FOUND, RESULT_TIMED_OUT };
type ExtractPropertiesByType<T, U> = {
    [K in keyof T as T[K] extends U ? K : never]: T[K] extends U ? K : never
}

export type FilterStringKeys<T> = keyof ExtractPropertiesByType<T, string | (string | undefined)>;

export type FilterBooleanKeys<T> = keyof ExtractPropertiesByType<T, boolean | (boolean | undefined)>;

export type FilterNumberKeys<T> = keyof ExtractPropertiesByType<T, number | (number | undefined)>;


export type FilePath = TaggedType<string, "FilePath">;
export type FilePathWithPrefixLC = TaggedType<string, "FilePathWithPrefixLC">;
export type FilePathWithPrefix = TaggedType<string, "FilePathWithPrefix"> | FilePath | FilePathWithPrefixLC;
export type DocumentID = TaggedType<string, "documentId">;


// docs should be encoded as base64, so 1 char -> 1 bytes
// and cloudant limitation is 1MB , we use 900kb;

export const MAX_DOC_SIZE = 1000; // for .md file, but if delimiters exists. use that before.
export const MAX_DOC_SIZE_BIN = 102400; // 100kb
export const VER = 10;

export const RECENT_MODIFIED_DOCS_QTY = 30;
export const LEAF_WAIT_TIMEOUT = 90000; // in synchronization, waiting missing leaf time out.
export const REPLICATION_BUSY_TIMEOUT = 3000000;



// Magic Special value for arguments or results.

export const CANCELLED = Symbol("cancelled");
export const AUTO_MERGED = Symbol("auto_merged");
export const NOT_CONFLICTED = Symbol("not_conflicted");
export const MISSING_OR_ERROR = Symbol("missing_or_error");
export const LEAVE_TO_SUBSEQUENT = Symbol("leave_to_subsequent_proc");
export const TIME_ARGUMENT_INFINITY = Symbol("infinity")

export const VERSIONING_DOCID = "obsydian_livesync_version" as DocumentID;
export const MILESTONE_DOCID = "_local/obsydian_livesync_milestone" as DocumentID;
export const NODEINFO_DOCID = "_local/obsydian_livesync_nodeinfo" as DocumentID;

export type HashAlgorithm = "" | "xxhash32" | "xxhash64" | "sha1";

export type ConfigPassphraseStore = "" /* default */ | "LOCALSTORAGE" | "ASK_AT_LAUNCH";
export type CouchDBConnection = {
    couchDB_URI: string,
    couchDB_USER: string,
    couchDB_PASSWORD: string,
    couchDB_DBNAME: string,
}
export const MODE_SELECTIVE = 0;
export const MODE_AUTOMATIC = 1;
export const MODE_PAUSED = 2;
export const MODE_SHINY = 3;
export type SYNC_MODE = typeof MODE_SELECTIVE | typeof MODE_AUTOMATIC | typeof MODE_PAUSED | typeof MODE_SHINY;
export type PluginSyncSettingEntry = {
    key: string,
    mode: SYNC_MODE,
    files: string[]
}

export const REMOTE_COUCHDB = "";
export const REMOTE_MINIO = "MINIO";
export type RemoteType = typeof REMOTE_COUCHDB | typeof REMOTE_MINIO;

export const SETTING_VERSION_INITIAL = 0;
export const SETTING_VERSION_SUPPORT_CASE_INSENSITIVE = 10;
export const CURRENT_SETTING_VERSION = SETTING_VERSION_SUPPORT_CASE_INSENSITIVE;

interface ObsidianLiveSyncSettings_PluginSetting {
    liveSync: boolean;
    syncOnSave: boolean;
    syncOnStart: boolean;
    syncOnFileOpen: boolean;
    savingDelay: number;
    lessInformationInLog: boolean;
    gcDelay: number;
    versionUpFlash: string;
    showVerboseLog: boolean;
    suspendFileWatching: boolean;
    trashInsteadDelete: boolean;
    periodicReplication: boolean;
    periodicReplicationInterval: number;
    doNotDeleteFolder: boolean;
    resolveConflictsByNewerFile: boolean;
    batchSave: boolean;
    batchSaveMinimumDelay: number;
    batchSaveMaximumDelay: number;
    deviceAndVaultName: string;
    usePluginSettings: boolean;
    showOwnPlugins: boolean;
    showStatusOnEditor: boolean;
    showStatusOnStatusbar: boolean;
    showOnlyIconsOnEditor: boolean;
    usePluginSync: boolean;
    autoSweepPlugins: boolean;
    autoSweepPluginsPeriodic: boolean;
    notifyPluginOrSettingUpdated: boolean;
    skipOlderFilesOnSync: boolean;
    syncInternalFiles: boolean;
    syncInternalFilesBeforeReplication: boolean;
    syncInternalFilesInterval: number;
    syncInternalFilesIgnorePatterns: string;
    lastReadUpdates: number;
    watchInternalFileChanges: boolean;
    disableMarkdownAutoMerge: boolean;
    writeDocumentsIfConflicted: boolean;
    syncAfterMerge: boolean;
    configPassphraseStore: ConfigPassphraseStore;
    encryptedPassphrase: string;
    encryptedCouchDBConnection: string;

    useIndexedDBAdapter: boolean;
    writeLogToTheFile: boolean;
    suspendParseReplicationResult: boolean;
    doNotSuspendOnFetching: boolean;

    useIgnoreFiles: boolean;
    ignoreFiles: string;
    syncOnEditorSave: boolean;

    syncMaxSizeInMB: number;
    settingSyncFile: string;
    writeCredentialsForSettingSync: boolean;
    notifyAllSettingSyncFile: boolean;

    pluginSyncExtendedSetting: Record<PluginSyncSettingEntry["key"], PluginSyncSettingEntry>;

    settingVersion: number;
    isConfigured?: boolean;

    displayLanguage: I18N_LANGS;

    enableChunkSplitterV2: boolean;
    disableWorkerForGeneratingChunks: boolean;
    processSmallFilesInUIThread: boolean;

    notifyThresholdOfRemoteStorageSize: number;

    usePluginSyncV2: boolean;

    useAdvancedMode: boolean;
    usePowerUserMode: boolean;
    useEdgeCaseMode: boolean;

    usePluginEtc: boolean; // This still be hidden from the UI.

    showLongerLogInsideEditor: boolean;

    enableDebugTools: boolean;

}

export type BucketSyncSetting = {
    accessKey: string,
    secretKey: string,
    bucket: string,
    region: string,
    endpoint: string,
    useCustomRequestHandler: boolean;
}
export type RemoteTypeSettings = {
    remoteType: RemoteType;
}

export type RemoteDBSettings = CouchDBConnection & BucketSyncSetting & RemoteTypeSettings & {
    versionUpFlash: string;
    minimumChunkSize: number;
    longLineThreshold: number;
    encrypt: boolean;
    passphrase: string;
    usePathObfuscation: boolean;
    checkIntegrityOnSave: boolean;
    batch_size: number;
    batches_limit: number;
    useHistory: boolean;
    disableRequestURI: boolean;
    checkConflictOnlyOnOpen: boolean;
    additionalSuffixOfDatabaseName: string | undefined;
    ignoreVersionCheck: boolean;
    deleteMetadataOfDeletedFiles: boolean;
    syncOnlyRegEx: string;
    syncIgnoreRegEx: string;
    customChunkSize: number;
    readChunksOnline: boolean;
    automaticallyDeleteMetadataOfDeletedFiles: number;
    useDynamicIterationCount: boolean;
    useTimeouts: boolean;
    showMergeDialogOnlyOnActive: boolean,
    hashCacheMaxCount: number,
    hashCacheMaxAmount: number,
    concurrencyOfReadChunksOnline: number,
    minimumIntervalOfReadChunksOnline: number,

    doNotPaceReplication: boolean,

    hashAlg: HashAlgorithm;
    // This could not be configured from Obsidian.
    permitEmptyPassphrase: boolean;
    enableCompression: boolean;
    disableCheckingConfigMismatch: boolean;

    useEden: boolean;
    maxChunksInEden: number;
    maxTotalLengthInEden: number;
    maxAgeInEden: number;

    enableChunkSplitterV2: boolean;
    disableWorkerForGeneratingChunks: boolean;
    processSmallFilesInUIThread: boolean;

    handleFilenameCaseSensitive: boolean;
    doNotUseFixedRevisionForChunks: boolean;
    sendChunksBulk: boolean;
    sendChunksBulkMaxSize: number;

    useSegmenter: boolean;
}

export type ObsidianLiveSyncSettings = ObsidianLiveSyncSettings_PluginSetting & RemoteDBSettings;


export const DEFAULT_SETTINGS: ObsidianLiveSyncSettings = {
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
    syncInternalFilesIgnorePatterns: "\\/node_modules\\/, \\/\\.git\\/, \\/obsidian-livesync\\/",
    syncInternalFilesInterval: 60,
    additionalSuffixOfDatabaseName: "",
    ignoreVersionCheck: false,
    lastReadUpdates: 0,
    deleteMetadataOfDeletedFiles: false,
    syncIgnoreRegEx: "",
    syncOnlyRegEx: "",
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
    useIndexedDBAdapter: true,
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
    displayLanguage: "",
    enableChunkSplitterV2: false,
    disableWorkerForGeneratingChunks: false,
    processSmallFilesInUIThread: false,
    notifyThresholdOfRemoteStorageSize: -1,

    usePluginSyncV2: false,
    usePluginEtc: false,
    handleFilenameCaseSensitive: undefined!,
    doNotUseFixedRevisionForChunks: undefined!,
    showLongerLogInsideEditor: false,
    sendChunksBulk: false,
    sendChunksBulkMaxSize: 1,
    useSegmenter: false,
    useAdvancedMode: false,
    usePowerUserMode: false,
    useEdgeCaseMode: false,
    enableDebugTools: false,
};

export interface HasSettings<T extends Partial<ObsidianLiveSyncSettings>> {
    settings: T;
}

export const PREFERRED_SETTING_CLOUDANT: Partial<ObsidianLiveSyncSettings> = {
    syncMaxSizeInMB: 50,
    customChunkSize: 0,
    sendChunksBulkMaxSize: 1,
    concurrencyOfReadChunksOnline: 100,
    minimumIntervalOfReadChunksOnline: 333,
    doNotUseFixedRevisionForChunks: false,
    useSegmenter: true,
    usePluginSyncV2: true,
    handleFilenameCaseSensitive: false,
}
export const PREFERRED_SETTING_SELF_HOSTED: Partial<ObsidianLiveSyncSettings> = {
    ...PREFERRED_SETTING_CLOUDANT,
    customChunkSize: 50,
    sendChunksBulkMaxSize: 1,
    concurrencyOfReadChunksOnline: 30,
    minimumIntervalOfReadChunksOnline: 25
}
export const PREFERRED_JOURNAL_SYNC: Partial<ObsidianLiveSyncSettings> = {
    ...PREFERRED_SETTING_CLOUDANT,
    customChunkSize: 10,
    concurrencyOfReadChunksOnline: 30,
    minimumIntervalOfReadChunksOnline: 25
}

export const PREFERRED_SETTING_PERFORMANT: Partial<ObsidianLiveSyncSettings> = {
    useSegmenter: true
}


export interface DatabaseEntry {
    _id: DocumentID;
    _rev?: string;
    _deleted?: boolean;
    _conflicts?: string[];
}

export type EntryBase = {
    ctime: number;
    mtime: number;
    size: number;
    deleted?: boolean;
}

export type EdenChunk = {
    data: string,
    epoch: number,
}

export type EntryWithEden = {
    eden: Record<DocumentID, EdenChunk>;
}

export type NoteEntry = DatabaseEntry & EntryBase & EntryWithEden & {
    path: FilePathWithPrefix;
    data: string | string[];
    type: "notes";
}

export type NewEntry = DatabaseEntry & EntryBase & EntryWithEden & {
    path: FilePathWithPrefix;
    children: string[];
    type: "newnote";
}
export type PlainEntry = DatabaseEntry & EntryBase & EntryWithEden & {
    path: FilePathWithPrefix;
    children: string[];
    type: "plain";
}

export type InternalFileEntry = DatabaseEntry & NewEntry & EntryBase & {
    deleted?: boolean;
    // type: "newnote";
}

export type AnyEntry = NoteEntry | NewEntry | PlainEntry | InternalFileEntry;

export type LoadedEntry = AnyEntry & {
    data: string | string[];
    datatype: "plain" | "newnote";
};
export type SavingEntry = AnyEntry & {
    data: Blob;
    datatype: "plain" | "newnote";
}

export type MetaEntry = AnyEntry & {
    children: string[];
    // datatype: "plain" | "newnote";
}
export function isMetaEntry(entry: AnyEntry): entry is MetaEntry {
    return "children" in entry
}

export type EntryLeaf = DatabaseEntry & {
    type: "leaf";
    data: string;
    isCorrupted?: boolean;
    // received?: boolean;
}

export type EntryChunkPack = DatabaseEntry & {
    type: "chunkpack";
    data: string//Record<string, string>;
}

export interface EntryVersionInfo extends DatabaseEntry {
    type: "versioninfo";
    version: number;
}
export interface EntryHasPath {
    path: FilePathWithPrefix | FilePath;
}
export interface ChunkVersionRange {
    min: number, //lower compatible chunk format version
    max: number, //maximum compatible chunk format version.
    current: number,//current chunk version.
}

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
    enableChunkSplitterV2: true,
    maxChunksInEden: 10,
    maxTotalLengthInEden: 1024,
    maxAgeInEden: 10,
    usePluginSyncV2: false,
    handleFilenameCaseSensitive: false,
    doNotUseFixedRevisionForChunks: false,
    useSegmenter: false,
}

export const CompatibilityBreakingTweakValues: (keyof TweakValues)[] = ["encrypt", "usePathObfuscation", "useDynamicIterationCount", "hashAlg", "handleFilenameCaseSensitive", "doNotUseFixedRevisionForChunks"];


export const TweakValuesRecommendedTemplate: Partial<ObsidianLiveSyncSettings> = {
    useIgnoreFiles: false,
    useCustomRequestHandler: false,

    batch_size: 25,
    batches_limit: 25,
    useIndexedDBAdapter: true,
    useTimeouts: false,
    readChunksOnline: true,
    hashCacheMaxCount: 300,
    hashCacheMaxAmount: 50,
    concurrencyOfReadChunksOnline: 40,
    minimumIntervalOfReadChunksOnline: 50,
    ignoreFiles: ".gitignore",
    syncMaxSizeInMB: 50,
    enableChunkSplitterV2: true,
    usePluginSyncV2: true,
    handleFilenameCaseSensitive: false,
    doNotUseFixedRevisionForChunks: false,
};
export const TweakValuesDefault: Partial<ObsidianLiveSyncSettings> = {
    usePluginSyncV2: false
}


export const configurationNames: Partial<Record<keyof ObsidianLiveSyncSettings, ConfigurationItem>> = {
    minimumChunkSize: {
        name: "Minimum Chunk Size (Not Configurable from the UI Now)."
    },
    longLineThreshold: {
        name: "Longest chunk line threshold value (Not Configurable from the UI Now)."
    },
    encrypt: {
        name: "End-to-End Encryption",
        desc: "Encrypt contents on the remote database. If you use the plugin's synchronization feature, enabling this is recommend."
    },
    usePathObfuscation: {
        name: "Path Obfuscation"
    },
    enableCompression: {
        name: "Data Compression",
        status: "EXPERIMENTAL"
    },
    useEden: {
        name: "Incubate Chunks in Document",
        desc: "If enabled, newly created chunks are temporarily kept within the document, and graduated to become independent chunks once stabilised.",
        status: "BETA"
    },
    customChunkSize: {
        name: "Enhance chunk size"
    },
    useDynamicIterationCount: {
        name: "Use dynamic iteration count", status: "EXPERIMENTAL"
    },
    hashAlg: {
        name: "The Hash algorithm for chunk IDs", status: "EXPERIMENTAL"
    },
    enableChunkSplitterV2: {
        name: "Use splitting-limit-capped chunk splitter",
        desc: "If enabled, chunks will be split into no more than 100 items. However, dedupe is slightly weaker."
    },
    "maxChunksInEden": {
        "name": "Maximum Incubating Chunks",
        "desc": "The maximum number of chunks that can be incubated within the document. Chunks exceeding this number will immediately graduate to independent chunks."
    },
    "maxTotalLengthInEden": {
        "name": "Maximum Incubating Chunk Size",
        "desc": "The maximum total size of chunks that can be incubated within the document. Chunks exceeding this size will immediately graduate to independent chunks."
    },
    "maxAgeInEden": {
        "name": "Maximum Incubation Period",
        "desc": "The maximum duration for which chunks can be incubated within the document. Chunks exceeding this period will graduate to independent chunks."
    },
    "usePluginSyncV2": {
        name: "Per-file-saved customization sync",
        desc: "If enabled per-filed efficient customization sync will be used. We need a small migration when enabling this. And all devices should be updated to v0.23.18. Once we enabled this, we lost a compatibility with old versions."
    },
    "handleFilenameCaseSensitive": {
        name: "Handle files as Case-Sensitive",
        desc: "If this enabled, All files are handled as case-Sensitive (Previous behaviour)."
    },
    "doNotUseFixedRevisionForChunks": {
        name: "Compute revisions for chunks (Previous behaviour)",
        desc: "If this enabled, all chunks will be stored with the revision made from its content. (Previous behaviour)"
    },
    "useSegmenter": {
        name: "Use Segmented-splitter",
        desc: "If this enabled, chunks will be split into semantically meaningful segments. Not all platforms support this feature."
    }
}

export const LEVEL_ADVANCED = "ADVANCED";
export const LEVEL_POWER_USER = "POWER_USER";
export const LEVEL_EDGE_CASE = "EDGE_CASE";
export type ConfigLevel = "" | "ADVANCED" | "POWER_USER" | "EDGE_CASE";
export type ConfigurationItem = {
    name: string,
    desc?: string,
    placeHolder?: string,
    status?: "BETA" | "ALPHA" | "EXPERIMENTAL",
    obsolete?: boolean,
    level?: ConfigLevel,
}


/**
 * Get human readable Configuration stability
 * @param status 
 * @returns 
 */
export function statusDisplay(status?: string): string {
    if (!status) return "";
    if (status == "EXPERIMENTAL") return ` (Experimental)`;
    if (status == "ALPHA") return ` (Alpha)`;
    if (status == "BETA") return ` (Beta)`;
    return ` (${status})`;
}

/**
 * Get human readable configuration name.
 * @param key configuration key
 * @param alt 
 * @returns 
 */
export function confName(key: keyof ObsidianLiveSyncSettings, alt: string = "") {
    if (key in configurationNames) {
        return `${configurationNames[key]?.name}${statusDisplay(configurationNames[key]?.status)}`;
    } else {
        return `${alt || ""}`;
    }
}

/**
 * Get human readable configuration description.
 * @param key configuration key
 * @param alt 
 * @returns 
 */
export function confDesc(key: keyof ObsidianLiveSyncSettings, alt?: string) {
    if (key in configurationNames) {
        if (configurationNames[key]?.desc) {
            return `${configurationNames[key]?.name}${statusDisplay(configurationNames[key]?.status)}`;
        }
        return alt;
    } else {
        return alt;
    }
}
export const TweakValuesTemplate = { ...TweakValuesRecommendedTemplate, ...TweakValuesShouldMatchedTemplate };
export type TweakValues = typeof TweakValuesTemplate;

export const DEVICE_ID_PREFERRED = "PREFERRED";

export interface EntryMilestoneInfo extends DatabaseEntry {
    _id: typeof MILESTONE_DOCID;
    type: "milestoneinfo";
    created: number;
    accepted_nodes: string[];
    locked: boolean;
    cleaned?: boolean;
    node_chunk_info: { [key: string]: ChunkVersionRange }
    tweak_values: { [key: string]: TweakValues }
}

export interface EntryNodeInfo extends DatabaseEntry {
    _id: typeof NODEINFO_DOCID;
    type: "nodeinfo";
    nodeid: string;
    v20220607?: boolean;
}

export type EntryBody = NoteEntry | NewEntry | PlainEntry | InternalFileEntry;

export type EntryDoc = EntryBody | LoadedEntry | EntryLeaf | EntryVersionInfo | EntryMilestoneInfo | EntryNodeInfo | EntryChunkPack;

export type diff_result_leaf = {
    rev: string;
    data: string;
    ctime: number;
    mtime: number;
    deleted?: boolean;
};
export type dmp_result = Array<[number, string]>;


export type diff_result = {
    left: diff_result_leaf;
    right: diff_result_leaf;
    diff: dmp_result;
};

export type DIFF_CHECK_RESULT_AUTO = typeof CANCELLED | typeof AUTO_MERGED | typeof NOT_CONFLICTED | typeof MISSING_OR_ERROR;

export type diff_check_result =
    DIFF_CHECK_RESULT_AUTO | diff_result;

export type Credential = {
    username: string;
    password: string;
};

export type EntryDocResponse = EntryDoc & PouchDB.Core.IdMeta & PouchDB.Core.GetMeta;

export type DatabaseConnectingStatus =
    "STARTED"
    | "NOT_CONNECTED"
    | "PAUSED"
    | "CONNECTED"
    | "COMPLETED"
    | "CLOSED"
    | "ERRORED"
    | "JOURNAL_SEND"
    | "JOURNAL_RECEIVE";

export const PREFIXMD_LOGFILE = "livesync_log_";
export const PREFIXMD_LOGFILE_UC = "LIVESYNC_LOG_";

export const FLAGMD_REDFLAG = "redflag.md" as FilePath;
export const FLAGMD_REDFLAG2 = "redflag2.md" as FilePath;
export const FLAGMD_REDFLAG2_HR = "flag_rebuild.md" as FilePath;
export const FLAGMD_REDFLAG3 = "redflag3.md" as FilePath;
export const FLAGMD_REDFLAG3_HR = "flag_fetch.md" as FilePath;
export const SYNCINFO_ID = "syncinfo" as DocumentID;

export interface SyncInfo extends DatabaseEntry {
    _id: typeof SYNCINFO_ID;
    type: "syncinfo";
    data: string;
}

export const SALT_OF_PASSPHRASE = "rHGMPtr6oWw7VSa3W3wpa8fT8U";

export const PREFIX_OBFUSCATED = "f:";
export const PREFIX_CHUNK = "h:";
export const PREFIX_ENCRYPTED_CHUNK = "h:+";

export type UXStat = {
    size: number,
    mtime: number,
    ctime: number,
    type: "file" | "folder",
}

export type UXFileInfo = UXFileInfoStub & {
    body: Blob,
}
// export type UXFileInfoStub = UXFileFileInfoStub;
export type UXAbstractInfoStub = UXFileInfoStub | UXFolderInfo;

export type UXFileInfoStub = {
    name: string,
    path: FilePath | FilePathWithPrefix,
    stat: UXStat,
    deleted?: boolean;
    isFolder?: false;
    isInternal?: boolean;
}
export type UXInternalFileInfoStub = {
    name: string,
    path: FilePath | FilePathWithPrefix,
    deleted?: boolean;
    isFolder?: false;
    isInternal: true;
    stat: undefined;
}



export type UXFolderInfo = {
    name: string,
    path: FilePath | FilePathWithPrefix,
    deleted?: boolean;
    isFolder: true;
    children: UXFileInfoStub[]
    parent: FilePath | FilePathWithPrefix | undefined;
}

export type UXDataWriteOptions = {
    /**
     * Time of creation, represented as a unix timestamp, in milliseconds.
     * Omit this if you want to keep the default behaviour.
     * @public
     * */
    ctime?: number;
    /**
     * Time of last modification, represented as a unix timestamp, in milliseconds.
     * Omit this if you want to keep the default behaviour.
     * @public
     */
    mtime?: number;

}


export type Prettify<T> = {
    [K in keyof T]: T[K];
    // eslint-disable-next-line 
} & {};