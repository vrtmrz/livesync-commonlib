import type { FetchHttpHandler } from "@smithy/fetch-http-handler";
import { type LOG_LEVEL } from "octagonal-wheels/common/logger";
import type {
    AUTO_MERGED,
    CouchDBCredentials,
    diff_result,
    DocumentID,
    EntryDoc,
    EntryHasPath,
    FileEventItem,
    FilePath,
    FilePathWithPrefix,
    LoadedEntry,
    MetaEntry,
    MISSING_OR_ERROR,
    ObsidianLiveSyncSettings,
    RemoteDBSettings,
    TweakValues,
    UXFileInfoStub,
} from "../common/types";

import type { LiveSyncLocalDB } from "../pouchdb/LiveSyncLocalDB";
import type { LiveSyncAbstractReplicator } from "../replication/LiveSyncAbstractReplicator";
import type { SimpleStore } from "octagonal-wheels/databases/SimpleStoreBase";
import type { Confirm } from "../interfaces/Confirm";

export interface IAPIService {
    getCustomFetchHandler(): FetchHttpHandler;

    addLog(message: any, level: LOG_LEVEL, key: string): void;

    isMobile(): boolean;

    showWindow(type: string): Promise<void>;

    getAppID(): string;

    isLastPostFailedDueToPayloadSize(): boolean;

    getPlatform(): string;

    getAppVersion(): string;

    getPluginVersion(): string;
}
export interface IPathService {
    id2path(id: DocumentID, entry?: EntryHasPath, stripPrefix?: boolean): FilePathWithPrefix;

    path2id(filename: FilePathWithPrefix | FilePath, prefix?: string): Promise<DocumentID>;
}
export interface IDatabaseService {
    createPouchDBInstance<T extends object>(
        name?: string,
        options?: PouchDB.Configuration.DatabaseConfiguration
    ): PouchDB.Database<T>;

    openSimpleStore<T>(kind: string): SimpleStore<T>;

    openDatabase(): Promise<boolean>;

    resetDatabase(): Promise<boolean>;

    isDatabaseReady(): boolean;
}
export interface IDatabaseEventService {
    onUnloadDatabase(db: LiveSyncLocalDB): Promise<boolean>;

    onCloseDatabase(db: LiveSyncLocalDB): Promise<boolean>;

    onDatabaseInitialisation(db: LiveSyncLocalDB): Promise<boolean>;

    onDatabaseInitialised(showNotice: boolean): Promise<boolean>;

    onResetDatabase(db: LiveSyncLocalDB): Promise<boolean>;

    initialiseDatabase(showingNotice?: boolean, reopenDatabase?: boolean, ignoreSuspending?: boolean): Promise<boolean>;
}
export interface IFileProcessingService {
    processFileEvent(item: FileEventItem): Promise<boolean>;

    processOptionalFileEvent(path: FilePath): Promise<boolean>;

    commitPendingFileEvents(): Promise<boolean>;
}
export interface IReplicatorService {
    onCloseActiveReplication(): Promise<boolean>;

    getNewReplicator(
        settingOverride?: Partial<ObsidianLiveSyncSettings>
    ): Promise<LiveSyncAbstractReplicator | undefined | false>;

    getActiveReplicator(): LiveSyncAbstractReplicator | undefined;
}
export interface IReplicationService {
    processSynchroniseResult(doc: MetaEntry): Promise<boolean>;

    processOptionalSynchroniseResult(doc: LoadedEntry): Promise<boolean>;
    processVirtualDocument(docs: PouchDB.Core.ExistingDocument<EntryDoc>): Promise<boolean>;
    onBeforeReplicate(showMessage: boolean): Promise<boolean>;
    checkConnectionFailure(): Promise<boolean | "CHECKAGAIN" | undefined>;
    isReplicationReady(showMessage: boolean): Promise<boolean>;
    replicate(showMessage?: boolean): Promise<boolean | void>;
    replicateByEvent(showMessage?: boolean): Promise<boolean | void>;
    parseSynchroniseResult(docs: Array<PouchDB.Core.ExistingDocument<EntryDoc>>): void;
}
export interface IRemoteService {
    connect(
        uri: string,
        auth: CouchDBCredentials,
        disableRequestURI: boolean,
        passphrase: string | false,
        useDynamicIterationCount: boolean,
        performSetup: boolean,
        skipInfo: boolean,
        compression: boolean,
        customHeaders: Record<string, string>,
        useRequestAPI: boolean,
        getPBKDF2Salt: () => Promise<Uint8Array<ArrayBuffer>>
    ): Promise<
        | string
        | {
              db: PouchDB.Database<EntryDoc>;
              info: PouchDB.Core.DatabaseInfo;
          }
    >;

    replicateAllToRemote(showingNotice?: boolean, sendChunksInBulkDisabled?: boolean): Promise<boolean>;

    replicateAllFromRemote(showingNotice?: boolean): Promise<boolean>;

    markLocked(lockByClean?: boolean): Promise<void>;

    markUnlocked(): Promise<void>;

    markResolved(): Promise<void>;

    tryResetDatabase(): Promise<void>;

    tryCreateDatabase(): Promise<void>;
}
export interface IConflictService {
    getOptionalConflictCheckMethod(path: FilePathWithPrefix): Promise<boolean | undefined | "newer">;
    resolveByUserInteraction: (
        filename: FilePathWithPrefix,
        conflictCheckResult: diff_result
    ) => Promise<boolean | undefined>;

    queueCheckForIfOpen(path: FilePathWithPrefix): Promise<void>;

    queueCheckFor(path: FilePathWithPrefix): Promise<void>;

    ensureAllProcessed(): Promise<boolean>;

    resolveByDeletingRevision(
        path: FilePathWithPrefix,
        deleteRevision: string,
        title: string
    ): Promise<typeof MISSING_OR_ERROR | typeof AUTO_MERGED>;

    resolve(filename: FilePathWithPrefix): Promise<void>;

    resolveByNewest(filename: FilePathWithPrefix): Promise<boolean>;
}
export interface IAppLifecycleService {
    onLayoutReady(): Promise<boolean>;
    onFirstInitialise(): Promise<boolean>;
    onReady(): Promise<boolean>;
    onWireUpEvents(): Promise<boolean>;
    onInitialise(): Promise<boolean>;
    onLoad(): Promise<boolean>;
    onSettingLoaded(): Promise<boolean>;
    onLoaded(): Promise<boolean>;
    onScanningStartupIssues(): Promise<boolean>;
    onAppUnload(): Promise<void>;
    onBeforeUnload(): Promise<boolean>;
    onUnload(): Promise<boolean>;
    onSuspending(): Promise<boolean>;
    onResuming(): Promise<boolean>;
    onResumed(): Promise<boolean>;
    getUnresolvedMessages: () => Promise<(string | Error)[]>;

    performRestart(): void;

    askRestart(message?: string): void;

    scheduleRestart(): void;

    isSuspended(): boolean;

    setSuspended(suspend: boolean): void;

    isReady(): boolean;

    markIsReady(): void;

    resetIsReady(): void;

    hasUnloaded(): boolean;

    isReloadingScheduled(): boolean;
}
export interface ISettingService {
    onBeforeRealiseSetting(): Promise<boolean>;
    onSettingRealised(): Promise<boolean>;
    onRealiseSetting(): Promise<boolean>;
    suspendAllSync(): Promise<boolean>;
    suspendExtraSync(): Promise<boolean>;
    suggestOptionalFeatures(opt: { enableFetch?: boolean; enableOverwrite?: boolean }): Promise<boolean>;
    enableOptionalFeature(mode: keyof OPTIONAL_SYNC_FEATURES): Promise<boolean>;

    clearUsedPassphrase(): void;

    realiseSetting(): Promise<void>;

    decryptSettings(settings: ObsidianLiveSyncSettings): Promise<ObsidianLiveSyncSettings>;

    adjustSettings(settings: ObsidianLiveSyncSettings): Promise<ObsidianLiveSyncSettings>;

    loadSettings(): Promise<void>;

    getDeviceAndVaultName(): string;

    setDeviceAndVaultName(name: string): void;

    saveDeviceAndVaultName(): void;

    saveSettingData(): Promise<void>;

    currentSettings(): ObsidianLiveSyncSettings;

    shouldCheckCaseInsensitively(): boolean;

    importSettings(imported: Partial<ObsidianLiveSyncSettings>): Promise<boolean>;
}
export interface ITweakValueService {
    fetchRemotePreferred(trialSetting: RemoteDBSettings): Promise<TweakValues | false>;

    checkAndAskResolvingMismatched(preferred: Partial<TweakValues>): Promise<[TweakValues | boolean, boolean]>;

    askResolvingMismatched(preferredSource: TweakValues): Promise<"OK" | "CHECKAGAIN" | "IGNORE">;

    checkAndAskUseRemoteConfiguration(
        settings: RemoteDBSettings
    ): Promise<{ result: false | TweakValues; requireFetch: boolean }>;

    askUseRemoteConfiguration(
        trialSetting: RemoteDBSettings,
        preferred: TweakValues
    ): Promise<{ result: false | TweakValues; requireFetch: boolean }>;
}
export interface IVaultService {
    vaultName(): string;

    getVaultName(): string;

    scanVault(showingNotice?: boolean, ignoreSuspending?: boolean): Promise<boolean>;

    isIgnoredByIgnoreFile(file: string | UXFileInfoStub): Promise<boolean>;

    markFileListPossiblyChanged(): void;

    isTargetFile(file: string | UXFileInfoStub, keepFileCheckList?: boolean): Promise<boolean>;

    isFileSizeTooLarge(size: number): boolean;

    getActiveFilePath(): FilePath | undefined;

    isStorageInsensitive(): boolean;
}
export interface ITestService {
    test(): Promise<boolean>;
    testMultiDevice(): Promise<boolean>;

    addTestResult(name: string, key: string, result: boolean, summary?: string, message?: string): void;
}
export interface IUIService {
    promptCopyToClipboard(title: string, value: string): Promise<boolean>;

    showMarkdownDialog<T extends string[]>(
        title: string,
        contentMD: string,
        buttons: T
    ): Promise<(typeof buttons)[number] | false>;

    get confirm(): Confirm;
}
export interface IConfigService {
    getSmallConfig(key: string): string | null;

    setSmallConfig(key: string, value: string): void;

    deleteSmallConfig(key: string): void;
}
