import { ServiceHub, type ServiceContext, type ServiceInstances } from "./ServiceHub.ts";
import {
    APIService,
    AppLifecycleService,
    ConflictService,
    DatabaseEventService,
    DatabaseService,
    PathService,
    RemoteService,
    ReplicationService,
    ReplicatorService,
    FileProcessingService,
    SettingService,
    TestService,
    TweakValueService,
    VaultService,
    type UIService,
    type ConfigService,
} from "./Services.ts";
import { handlers } from "./HandlerUtils.ts";
import type { SimpleStore } from "../common/utils.ts";
import type {
    IAPIService,
    IAppLifecycleService,
    IConflictService,
    IDatabaseEventService,
    IDatabaseService,
    IPathService,
    IRemoteService,
    IReplicationService,
    IReplicatorService,
    ISettingService,
    ITestService,
    ITweakValueService,
    IVaultService,
} from "./IService.ts";

export type InjectableServiceInstances<T extends ServiceContext> = ServiceInstances<T> & {
    API?: InjectableAPIService<T>;
    path?: InjectablePathService<T>;
    database?: InjectableDatabaseService<T>;
    databaseEvents?: InjectableDatabaseEventService<T>;
    replicator?: InjectableReplicatorService<T>;
    fileProcessing?: InjectableFileProcessingService<T>;
    replication?: InjectableReplicationService<T>;
    remote?: InjectableRemoteService<T>;
    conflict?: InjectableConflictService<T>;
    appLifecycle?: InjectableAppLifecycleService<T>;
    setting?: InjectableSettingService<T>;
    tweakValue?: InjectableTweakValueService<T>;
    vault?: InjectableVaultService<T>;
    test?: InjectableTestService<T>;
    ui?: UIService<T>;
    config?: ConfigService<T>;
};

export class InjectableAPIService<T extends ServiceContext> extends APIService<T> {
    addLog = handlers<IAPIService>().binder("addLog");
    getCustomFetchHandler = handlers<IAPIService>().binder("getCustomFetchHandler");
    isMobile = handlers<IAPIService>().binder("isMobile");
    showWindow = handlers<IAPIService>().binder("showWindow");
    getAppID = handlers<IAPIService>().binder("getAppID");
    getAppVersion = handlers<IAPIService>().binder("getAppVersion");
    getPluginVersion = handlers<IAPIService>().binder("getPluginVersion");
    isLastPostFailedDueToPayloadSize = handlers<IAPIService>().binder("isLastPostFailedDueToPayloadSize");

    override getPlatform(): string {
        return "unknown";
    }
}

export class InjectablePathService<T extends ServiceContext> extends PathService<T> {
    id2path = handlers<IPathService>().binder("id2path");
    path2id = handlers<IPathService>().binder("path2id");
}

export class InjectableDatabaseService<T extends ServiceContext> extends DatabaseService<T> {
    // _throughHole: ThroughHole;
    createPouchDBInstance = handlers<IDatabaseService>().binder("createPouchDBInstance") as (<T extends object>(
        name?: string,
        options?: PouchDB.Configuration.DatabaseConfiguration
    ) => PouchDB.Database<T>) & {
        setHandler: (handler: IDatabaseService["createPouchDBInstance"], override?: boolean) => void;
    };
    openSimpleStore = handlers<IDatabaseService>().binder("openSimpleStore") as (<T>(
        kind: string
    ) => SimpleStore<T>) & { setHandler: (handler: IDatabaseService["openSimpleStore"], override?: boolean) => void };
    openDatabase = handlers<IDatabaseService>().binder("openDatabase");
    resetDatabase = handlers<IDatabaseService>().binder("resetDatabase");
    isDatabaseReady = handlers<IDatabaseService>().binder("isDatabaseReady");
}
export class InjectableDatabaseEventService<T extends ServiceContext> extends DatabaseEventService<T> {
    initialiseDatabase = handlers<IDatabaseEventService>().binder("initialiseDatabase");
}

export class InjectableReplicatorService<T extends ServiceContext> extends ReplicatorService<T> {
    getActiveReplicator = handlers<IReplicatorService>().binder("getActiveReplicator");
}
export class InjectableFileProcessingService<T extends ServiceContext> extends FileProcessingService<T> {}
export class InjectableReplicationService<T extends ServiceContext> extends ReplicationService<T> {
    parseSynchroniseResult = handlers<IReplicationService>().binder("parseSynchroniseResult");
    isReplicationReady = handlers<IReplicationService>().binder("isReplicationReady");
    replicate = handlers<IReplicationService>().binder("replicate");
    replicateByEvent = handlers<IReplicationService>().binder("replicateByEvent");
}
export class InjectableRemoteService<T extends ServiceContext> extends RemoteService<T> {
    // _throughHole: ThroughHole;
    replicateAllToRemote = handlers<IRemoteService>().binder("replicateAllToRemote");
    replicateAllFromRemote = handlers<IRemoteService>().binder("replicateAllFromRemote");
    markLocked = handlers<IRemoteService>().binder("markLocked");
    markUnlocked = handlers<IRemoteService>().binder("markUnlocked");
    markResolved = handlers<IRemoteService>().binder("markResolved");
    tryResetDatabase = handlers<IRemoteService>().binder("tryResetDatabase");
    tryCreateDatabase = handlers<IRemoteService>().binder("tryCreateDatabase");
    connect = handlers<IRemoteService>().binder("connect");
}
export class InjectableConflictService<T extends ServiceContext> extends ConflictService<T> {
    queueCheckForIfOpen = handlers<IConflictService>().binder("queueCheckForIfOpen");
    queueCheckFor = handlers<IConflictService>().binder("queueCheckFor");
    ensureAllProcessed = handlers<IConflictService>().binder("ensureAllProcessed");
    resolveByDeletingRevision = handlers<IConflictService>().binder("resolveByDeletingRevision");
    resolve = handlers<IConflictService>().binder("resolve");
    resolveByNewest = handlers<IConflictService>().binder("resolveByNewest");
}

export class InjectableAppLifecycleService<T extends ServiceContext> extends AppLifecycleService<T> {
    performRestart = handlers<IAppLifecycleService>().binder("performRestart");
    askRestart = handlers<IAppLifecycleService>().binder("askRestart");
    scheduleRestart = handlers<IAppLifecycleService>().binder("scheduleRestart");
    isSuspended = handlers<IAppLifecycleService>().binder("isSuspended");
    setSuspended = handlers<IAppLifecycleService>().binder("setSuspended");
    isReady = handlers<IAppLifecycleService>().binder("isReady");
    markIsReady = handlers<IAppLifecycleService>().binder("markIsReady");
    resetIsReady = handlers<IAppLifecycleService>().binder("resetIsReady");
    hasUnloaded = handlers<IAppLifecycleService>().binder("hasUnloaded");
    isReloadingScheduled = handlers<IAppLifecycleService>().binder("isReloadingScheduled");
}
export class InjectableSettingService<T extends ServiceContext> extends SettingService<T> {
    clearUsedPassphrase = handlers<ISettingService>().binder("clearUsedPassphrase");
    realiseSetting = handlers<ISettingService>().binder("realiseSetting");
    decryptSettings = handlers<ISettingService>().binder("decryptSettings");
    adjustSettings = handlers<ISettingService>().binder("adjustSettings");
    getDeviceAndVaultName = handlers<ISettingService>().binder("getDeviceAndVaultName");
    setDeviceAndVaultName = handlers<ISettingService>().binder("setDeviceAndVaultName");
    saveDeviceAndVaultName = handlers<ISettingService>().binder("saveDeviceAndVaultName");
    saveSettingData = handlers<ISettingService>().binder("saveSettingData");
    loadSettings = handlers<ISettingService>().binder("loadSettings");
    currentSettings = handlers<ISettingService>().binder("currentSettings");
    shouldCheckCaseInsensitively = handlers<ISettingService>().binder("shouldCheckCaseInsensitively");
    importSettings = handlers<ISettingService>().binder("importSettings");
}
export class InjectableTweakValueService<T extends ServiceContext> extends TweakValueService<T> {
    fetchRemotePreferred = handlers<ITweakValueService>().binder("fetchRemotePreferred");
    checkAndAskResolvingMismatched = handlers<ITweakValueService>().binder("checkAndAskResolvingMismatched");

    askResolvingMismatched = handlers<ITweakValueService>().binder("askResolvingMismatched");
    checkAndAskUseRemoteConfiguration = handlers<ITweakValueService>().binder("checkAndAskUseRemoteConfiguration");
    askUseRemoteConfiguration = handlers<ITweakValueService>().binder("askUseRemoteConfiguration");
}
export class InjectableVaultService<T extends ServiceContext> extends VaultService<T> {
    getVaultName = handlers<IVaultService>().binder("getVaultName");
    scanVault = handlers<IVaultService>().binder("scanVault");
    isIgnoredByIgnoreFile = handlers<IVaultService>().binder("isIgnoredByIgnoreFile");
    isTargetFile = handlers<IVaultService>().binder("isTargetFile");
    isFileSizeTooLarge = handlers<IVaultService>().binder("isFileSizeTooLarge");
    getActiveFilePath = handlers<IVaultService>().binder("getActiveFilePath");
    markFileListPossiblyChanged = handlers<IVaultService>().binder("markFileListPossiblyChanged");
    isStorageInsensitive = handlers<IVaultService>().binder("isStorageInsensitive");
    vaultName = handlers<IVaultService>().binder("vaultName");
}

export class InjectableTestService<T extends ServiceContext> extends TestService<T> {
    addTestResult = handlers<ITestService>().binder("addTestResult");
}

export class InjectableServiceHub<T extends ServiceContext = ServiceContext> extends ServiceHub<T> {
    protected readonly _api: InjectableAPIService<T>;

    protected readonly _path: InjectablePathService<T>;
    protected readonly _database: InjectableDatabaseService<T>;
    protected readonly _databaseEvents: InjectableDatabaseEventService<T>;
    protected readonly _replicator: InjectableReplicatorService<T>;
    protected readonly _fileProcessing: InjectableFileProcessingService<T>;
    protected readonly _replication: InjectableReplicationService<T>;
    protected readonly _remote: InjectableRemoteService<T>;
    protected readonly _conflict: InjectableConflictService<T>;
    protected readonly _appLifecycle: InjectableAppLifecycleService<T>;
    protected readonly _setting: InjectableSettingService<T>;
    protected readonly _tweakValue: InjectableTweakValueService<T>;
    protected readonly _vault: InjectableVaultService<T>;
    protected readonly _test: InjectableTestService<T>;
    protected readonly _ui: UIService<T>;
    protected readonly _config: ConfigService<T>;

    get API(): InjectableAPIService<T> {
        return this._api;
    }
    get path(): InjectablePathService<T> {
        return this._path;
    }
    get database(): InjectableDatabaseService<T> {
        return this._database;
    }
    get databaseEvents(): InjectableDatabaseEventService<T> {
        return this._databaseEvents;
    }
    get replicator(): InjectableReplicatorService<T> {
        return this._replicator;
    }
    get fileProcessing(): InjectableFileProcessingService<T> {
        return this._fileProcessing;
    }
    get replication(): InjectableReplicationService<T> {
        return this._replication;
    }
    get remote(): InjectableRemoteService<T> {
        return this._remote;
    }
    get conflict(): InjectableConflictService<T> {
        return this._conflict;
    }
    get appLifecycle(): InjectableAppLifecycleService<T> {
        return this._appLifecycle;
    }
    get setting(): InjectableSettingService<T> {
        return this._setting;
    }
    get tweakValue(): InjectableTweakValueService<T> {
        return this._tweakValue;
    }
    get vault(): InjectableVaultService<T> {
        return this._vault;
    }
    get test(): InjectableTestService<T> {
        return this._test;
    }

    get UI(): UIService<T> {
        return this._ui;
    }
    get config(): ConfigService<T> {
        return this._config;
    }

    constructor(context: T, services: InjectableServiceInstances<T> & { ui: UIService<T>; config: ConfigService<T> }) {
        super(context, services);
        // TODO reorder to resolve dependencies (or make sure dependencies)
        this._api = services.API ?? new InjectableAPIService<T>(context);
        this._path = services.path ?? new InjectablePathService<T>(context);
        this._database = services.database ?? new InjectableDatabaseService<T>(context);
        this._databaseEvents = services.databaseEvents ?? new InjectableDatabaseEventService<T>(context);
        this._replicator = services.replicator ?? new InjectableReplicatorService<T>(context);
        this._fileProcessing = services.fileProcessing ?? new InjectableFileProcessingService<T>(context);
        this._replication = services.replication ?? new InjectableReplicationService<T>(context);
        this._remote = services.remote ?? new InjectableRemoteService<T>(context);
        this._conflict = services.conflict ?? new InjectableConflictService<T>(context);
        this._appLifecycle = services.appLifecycle ?? new InjectableAppLifecycleService<T>(context);
        this._setting = services.setting ?? new InjectableSettingService<T>(context);
        this._tweakValue = services.tweakValue ?? new InjectableTweakValueService<T>(context);
        this._vault = services.vault ?? new InjectableVaultService<T>(context);
        this._test = services.test ?? new InjectableTestService<T>(context);
        this._ui = services.ui;
        this._config = services.config;
    }
}
