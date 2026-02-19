import type { UIService } from "./implements/base/UIService.ts";
import type { ConfigService } from "@lib/services/base/ConfigService.ts";
import type { TestService } from "@lib/services/base/TestService.ts";
import type { VaultService } from "@lib/services/base/VaultService.ts";
import type { TweakValueService } from "@lib/services/base/TweakValueService.ts";
import type { SettingService } from "@lib/services/base/SettingService.ts";
import type { AppLifecycleService } from "@lib/services/base/AppLifecycleService.ts";
import type { ConflictService } from "@lib/services/base/ConflictService.ts";
import type { RemoteService } from "@lib/services/base/RemoteService.ts";
import type { ReplicationService } from "@lib/services/base/ReplicationService.ts";
import type { ReplicatorService } from "@lib/services/base/ReplicatorService.ts";
import type { FileProcessingService } from "@lib/services/base/FileProcessingService.ts";
import type { DatabaseEventService } from "@lib/services/base/DatabaseEventService.ts";
import type { DatabaseService } from "@lib/services/base/DatabaseService.ts";
import type { PathService } from "@lib/services/base/PathService.ts";
import type { APIService } from "@lib/services/base/APIService.ts";
import type { ServiceContext } from "./base/ServiceBase.ts";
import type { IServiceHub } from "./base/IService.ts";
import type { KeyValueDBService } from "./base/KeyValueDBService.ts";
import type { ControlService } from "./base/ControlService.ts";

export type ServiceInstances<T extends ServiceContext = ServiceContext> = {
    API?: APIService<T>;
    path?: PathService<T>;
    database?: DatabaseService<T>;
    databaseEvents?: DatabaseEventService<T>;
    replicator?: ReplicatorService<T>;
    fileProcessing?: FileProcessingService<T>;
    replication?: ReplicationService<T>;
    remote?: RemoteService<T>;
    conflict?: ConflictService<T>;
    appLifecycle?: AppLifecycleService<T>;
    setting?: SettingService<T>;
    tweakValue?: TweakValueService<T>;
    vault?: VaultService<T>;
    test?: TestService<T>;
    ui?: UIService<T>;
    config?: ConfigService<T>;
    keyValueDB?: KeyValueDBService<T>;
    control?: ControlService<T>;
};

export abstract class ServiceHub<T extends ServiceContext = ServiceContext> implements IServiceHub {
    protected context: T;
    protected abstract _api: APIService<T>;
    protected abstract _path: PathService<T>;
    protected abstract _database: DatabaseService<T>;
    protected abstract _databaseEvents: DatabaseEventService<T>;
    protected abstract _replicator: ReplicatorService<T>;
    protected abstract _fileProcessing: FileProcessingService<T>;
    protected abstract _replication: ReplicationService<T>;
    protected abstract _remote: RemoteService<T>;
    protected abstract _conflict: ConflictService<T>;
    protected abstract _appLifecycle: AppLifecycleService<T>;
    protected abstract _setting: SettingService<T>;
    protected abstract _tweakValue: TweakValueService<T>;
    protected abstract _vault: VaultService<T>;
    protected abstract _test: TestService<T>;
    protected abstract _ui: UIService<T>;
    protected abstract _config: ConfigService<T>;
    protected abstract _keyValueDB: KeyValueDBService<T>;
    protected abstract _control: ControlService<T>;
    protected _injected: ServiceInstances<T> = {};
    constructor(context: T, services: ServiceInstances<T> = {}) {
        this.context = context;
        this._injected = services;
    }

    get API(): APIService<T> {
        return this._injected.API || this._api;
    }
    get path(): PathService<T> {
        return this._injected.path || this._path;
    }
    get database(): DatabaseService<T> {
        return this._injected.database || this._database;
    }
    get databaseEvents(): DatabaseEventService<T> {
        return this._injected.databaseEvents || this._databaseEvents;
    }
    get replicator(): ReplicatorService<T> {
        return this._injected.replicator || this._replicator;
    }
    get fileProcessing(): FileProcessingService<T> {
        return this._injected.fileProcessing || this._fileProcessing;
    }
    get replication(): ReplicationService<T> {
        return this._injected.replication || this._replication;
    }
    get remote(): RemoteService<T> {
        return this._injected.remote || this._remote;
    }
    get conflict(): ConflictService<T> {
        return this._injected.conflict || this._conflict;
    }
    get appLifecycle(): AppLifecycleService<T> {
        return this._injected.appLifecycle || this._appLifecycle;
    }
    get setting(): SettingService<T> {
        return this._injected.setting || this._setting;
    }
    get tweakValue(): TweakValueService<T> {
        return this._injected.tweakValue || this._tweakValue;
    }
    get vault(): VaultService<T> {
        return this._injected.vault || this._vault;
    }
    get test(): TestService<T> {
        return this._injected.test || this._test;
    }

    get UI(): UIService<T> {
        return this._injected.ui || this._ui;
    }
    get config(): ConfigService<T> {
        return this._injected.config || this._config;
    }
    get keyValueDB(): KeyValueDBService<T> {
        return this._injected.keyValueDB || this._keyValueDB;
    }
    get control(): ControlService<T> {
        return this._injected.control || this._control;
    }
}
