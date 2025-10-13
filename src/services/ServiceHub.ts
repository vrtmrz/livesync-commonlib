import type {
    APIService,
    PathService,
    DatabaseService,
    DatabaseEventService,
    ReplicatorService,
    FileProcessingService,
    ReplicationService,
    RemoteService,
    AppLifecycleService,
    SettingService,
    TweakValueService,
    VaultService,
    ConflictService,
    TestService,
} from "./Services.ts";

export abstract class ServiceHub {
    protected abstract _api: APIService;
    protected abstract _path: PathService;
    protected abstract _database: DatabaseService;
    protected abstract _databaseEvents: DatabaseEventService;
    protected abstract _replicator: ReplicatorService;
    protected abstract _fileProcessing: FileProcessingService;
    protected abstract _replication: ReplicationService;
    protected abstract _remote: RemoteService;
    protected abstract _conflict: ConflictService;
    protected abstract _appLifecycle: AppLifecycleService;
    protected abstract _setting: SettingService;
    protected abstract _tweakValue: TweakValueService;
    protected abstract _vault: VaultService;
    protected abstract _test: TestService;

    get API(): APIService {
        return this._api;
    }
    get path(): PathService {
        return this._path;
    }
    get database(): DatabaseService {
        return this._database;
    }
    get databaseEvents(): DatabaseEventService {
        return this._databaseEvents;
    }
    get replicator(): ReplicatorService {
        return this._replicator;
    }
    get fileProcessing(): FileProcessingService {
        return this._fileProcessing;
    }
    get replication(): ReplicationService {
        return this._replication;
    }
    get remote(): RemoteService {
        return this._remote;
    }
    get conflict(): ConflictService {
        return this._conflict;
    }
    get appLifecycle(): AppLifecycleService {
        return this._appLifecycle;
    }
    get setting(): SettingService {
        return this._setting;
    }
    get tweakValue(): TweakValueService {
        return this._tweakValue;
    }
    get vault(): VaultService {
        return this._vault;
    }
    get test(): TestService {
        return this._test;
    }
}
