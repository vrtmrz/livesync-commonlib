// docs should be encoded as base64, so 1 char -> 1 bytes
// and cloudant limitation is 1MB , we use 900kb;

export const MAX_DOC_SIZE = 1000; // for .md file, but if delimiters exists. use that before.
export const MAX_DOC_SIZE_BIN = 102400; // 100kb
export const VER = 10;

export const RECENT_MOFIDIED_DOCS_QTY = 30;
export const LEAF_WAIT_TIMEOUT = 90000; // in synchronization, waiting missing leaf time out.
export const LOG_LEVEL = {
    DEBUG: -1,
    VERBOSE: 1,
    INFO: 10,
    NOTICE: 100,
    URGENT: 1000,
} as const;
export type LOG_LEVEL = typeof LOG_LEVEL[keyof typeof LOG_LEVEL];
export const VERSIONINFO_DOCID = "obsydian_livesync_version";
export const MILSTONE_DOCID = "_local/obsydian_livesync_milestone";
export const NODEINFO_DOCID = "_local/obsydian_livesync_nodeinfo";

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
    workingEncrypt: boolean;
    workingPassphrase: string;
    doNotDeleteFolder: boolean;
    resolveConflictsByNewerFile: boolean;
    batchSave: boolean;
    deviceAndVaultName: string;
    usePluginSettings: boolean;
    showOwnPlugins: boolean;
    showStatusOnEditor: boolean;
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

}

export interface RemoteDBSettings {
    couchDB_URI: string;
    couchDB_USER: string;
    couchDB_PASSWORD: string;
    couchDB_DBNAME: string;
    versionUpFlash: string;
    minimumChunkSize: number;
    longLineThreshold: number;
    encrypt: boolean;
    passphrase: string;
    checkIntegrityOnSave: boolean;
    batch_size: number;
    batches_limit: number;
    useHistory: boolean;
    disableRequestURI: boolean;
    checkConflictOnlyOnOpen: boolean;
    additionalSuffixOfDatabaseName: string | null;
    ignoreVersionCheck: boolean;
    deleteMetadataOfDeletedFiles: boolean;
    syncOnlyRegEx: string;
    syncIgnoreRegEx: string;
    customChunkSize: number;
    readChunksOnline: boolean;
    automaticallyDeleteMetadataOfDeletedFiles: number;
    useDynamicIterationCount: boolean;
    workingUseDynamicIterationCount: boolean;
}

export type ObsidianLiveSyncSettings = ObsidianLiveSyncSettings_PluginSetting & RemoteDBSettings;
export const DEFAULT_SETTINGS: ObsidianLiveSyncSettings = {
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
    workingEncrypt: false,
    workingPassphrase: "",
    doNotDeleteFolder: false,
    resolveConflictsByNewerFile: false,
    batchSave: false,
    deviceAndVaultName: "",
    usePluginSettings: false,
    showOwnPlugins: false,
    showStatusOnEditor: false,
    usePluginSync: false,
    autoSweepPlugins: false,
    autoSweepPluginsPeriodic: false,
    notifyPluginOrSettingUpdated: false,
    checkIntegrityOnSave: false,
    batch_size: 250,
    batches_limit: 40,
    useHistory: false,
    disableRequestURI: false,
    skipOlderFilesOnSync: true,
    checkConflictOnlyOnOpen: false,
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
    workingUseDynamicIterationCount: false,
    syncAfterMerge: false,
};

export interface DatabaseEntry {
    _id: string;
    _rev?: string;
    _deleted?: boolean;
    _conflicts?: string[];
}

export type Entry = DatabaseEntry & {
    ctime: number;
    mtime: number;
    size: number;
    deleted?: boolean;
}
export type NoteEntry = Entry & {
    data: string;
    type: "notes";
}

export type NewEntry = Entry & {

    children: string[];
    type: "newnote";
}
export type PlainEntry = Entry & {
    children: string[];
    type: "plain";
}

export type InternalFileEntry = NewEntry & {
    deleted?: boolean;
    // type: "newnote";
}

export type AnyEntry = NoteEntry | NewEntry | PlainEntry | InternalFileEntry;

export type LoadedEntry = AnyEntry & {
    data: string;
    datatype: "plain" | "newnote";
};

export type EntryLeaf = DatabaseEntry & {
    type: "leaf";
    data: string;
    isCorrupted?: boolean;
}

export interface EntryVersionInfo extends DatabaseEntry {
    type: "versioninfo";
    version: number;
}

export interface ChunkVersionRange {
    min: number, //lower compatible chunk format version
    max: number, //maximum compatible chunk format version.
    current: number,//current chunk version.
}

export interface EntryMilestoneInfo extends DatabaseEntry {
    _id: typeof MILSTONE_DOCID;
    type: "milestoneinfo";
    created: number;
    accepted_nodes: string[];
    locked: boolean;
    node_chunk_info: { [key: string]: ChunkVersionRange }
}

export interface EntryNodeInfo extends DatabaseEntry {
    _id: typeof NODEINFO_DOCID;
    type: "nodeinfo";
    nodeid: string;
    v20220607?: boolean;
}

export type EntryBody = NoteEntry | NewEntry | PlainEntry | InternalFileEntry;

export type EntryDoc = EntryBody | LoadedEntry | EntryLeaf | EntryVersionInfo | EntryMilestoneInfo | EntryNodeInfo;

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
export type diff_check_result = boolean | diff_result;

export type Credential = {
    username: string;
    password: string;
};

export type EntryDocResponse = EntryDoc & PouchDB.Core.IdMeta & PouchDB.Core.GetMeta;

export type DatabaseConnectingStatus = "STARTED" | "NOT_CONNECTED" | "PAUSED" | "CONNECTED" | "COMPLETED" | "CLOSED" | "ERRORED";

export const FLAGMD_REDFLAG = "redflag.md";

export const SYNCINFO_ID = "syncinfo";

export interface SyncInfo extends DatabaseEntry {
    _id: typeof SYNCINFO_ID;
    type: "syncinfo";
    data: string;
}
