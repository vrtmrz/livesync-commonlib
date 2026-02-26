import type { ConfigService } from "../../base/ConfigService";
import { ControlService } from "../../base/ControlService";
import type { KeyValueDBService } from "../../base/KeyValueDBService";
import { PathService } from "../../base/PathService";
import type { ServiceContext } from "../../base/ServiceBase";
import type { SettingService } from "../../base/SettingService";
import { ServiceHub } from "../../ServiceHub";
import type { UIService } from "../base/UIService";
import { InjectableAPIService } from "./InjectableAPIService";
import { type AppLifecycleServiceBase } from "./InjectableAppLifecycleService";
import { InjectableConflictService } from "./InjectableConflictService";
import { InjectableDatabaseEventService } from "./InjectableDatabaseEventService";
import { InjectableFileProcessingService } from "./InjectableFileProcessingService";
import { InjectableRemoteService } from "./InjectableRemoteService";
import { InjectableReplicationService } from "./InjectableReplicationService";
import { InjectableReplicatorService } from "./InjectableReplicatorService";
import type { InjectableServiceInstances } from "./InjectableServices";
import { InjectableTestService } from "./InjectableTestService";
import { InjectableTweakValueService } from "./InjectableTweakValueService";
import { InjectableVaultService } from "./InjectableVaultService";
import type { DatabaseService } from "@lib/services/base/DatabaseService.ts";

export class InjectableServiceHub<T extends ServiceContext = ServiceContext> extends ServiceHub<T> {
    protected readonly _api: InjectableAPIService<T>;

    protected readonly _path: PathService<T>;
    protected readonly _database: DatabaseService<T>;
    protected readonly _databaseEvents: InjectableDatabaseEventService<T>;
    protected readonly _replicator: InjectableReplicatorService<T>;
    protected readonly _fileProcessing: InjectableFileProcessingService<T>;
    protected readonly _replication: InjectableReplicationService<T>;
    protected readonly _remote: InjectableRemoteService<T>;
    protected readonly _conflict: InjectableConflictService<T>;
    protected readonly _appLifecycle: AppLifecycleServiceBase<T>;
    protected readonly _setting: SettingService<T>;
    protected readonly _tweakValue: InjectableTweakValueService<T>;
    protected readonly _vault: InjectableVaultService<T>;
    protected readonly _test: InjectableTestService<T>;
    protected readonly _ui: UIService<T>;
    protected readonly _config: ConfigService<T>;
    protected readonly _keyValueDB: KeyValueDBService<T>;
    protected readonly _control: ControlService<T>;

    override get API(): InjectableAPIService<T> {
        return this._api;
    }
    override get path(): PathService<T> {
        return this._path;
    }
    override get database(): DatabaseService<T> {
        return this._database;
    }
    override get databaseEvents(): InjectableDatabaseEventService<T> {
        return this._databaseEvents;
    }
    override get replicator(): InjectableReplicatorService<T> {
        return this._replicator;
    }
    override get fileProcessing(): InjectableFileProcessingService<T> {
        return this._fileProcessing;
    }
    override get replication(): InjectableReplicationService<T> {
        return this._replication;
    }
    override get remote(): InjectableRemoteService<T> {
        return this._remote;
    }
    override get conflict(): InjectableConflictService<T> {
        return this._conflict;
    }
    override get appLifecycle(): AppLifecycleServiceBase<T> {
        return this._appLifecycle;
    }
    override get setting(): SettingService<T> {
        return this._setting;
    }
    override get tweakValue(): InjectableTweakValueService<T> {
        return this._tweakValue;
    }
    override get vault(): InjectableVaultService<T> {
        return this._vault;
    }
    override get test(): InjectableTestService<T> {
        return this._test;
    }

    override get control(): ControlService<T> {
        return this._control;
    }

    override get keyValueDB(): KeyValueDBService<T> {
        return this._keyValueDB;
    }

    override get UI(): UIService<T> {
        return this._ui;
    }
    override get config(): ConfigService<T> {
        return this._config;
    }

    constructor(
        context: T,
        services: InjectableServiceInstances<T> & {
            setting: SettingService<T>;
            appLifecycle: AppLifecycleServiceBase<T>;
            path: PathService<T>;
            API: InjectableAPIService<T>;
            ui: UIService<T>;
            config: ConfigService<T>;
            database: DatabaseService<T>;
            vault: InjectableVaultService<T>;
            keyValueDB: KeyValueDBService<T>;
            replicator: InjectableReplicatorService<T>;
        }
    ) {
        super(context, services);
        // TODO reorder to resolve dependencies (or make sure dependencies)
        this._api = services.API;
        this._path = services.path;
        this._database = services.database;
        this._databaseEvents = services.databaseEvents ?? new InjectableDatabaseEventService<T>(context);
        this._replicator = services.replicator;
        this._fileProcessing = services.fileProcessing ?? new InjectableFileProcessingService<T>(context);
        this._conflict = services.conflict ?? new InjectableConflictService<T>(context);
        this._appLifecycle = services.appLifecycle;
        this._setting = services.setting;
        this._remote =
            services.remote ??
            new InjectableRemoteService<T>(context, {
                APIService: this._api,
                appLifecycle: this._appLifecycle,
                setting: this._setting,
            });
        this._tweakValue = services.tweakValue ?? new InjectableTweakValueService<T>(context);
        this._replication =
            services.replication ??
            new InjectableReplicationService<T>(context, {
                APIService: this._api,
                appLifecycleService: this._appLifecycle,
                replicatorService: this._replicator,
                settingService: this._setting,
                databaseService: this._database,
                fileProcessingService: this._fileProcessing,
            });
        this._vault = services.vault;
        this._test = services.test ?? new InjectableTestService<T>(context);
        this._ui = services.ui;
        this._config = services.config;
        this._keyValueDB = services.keyValueDB;
        this._control =
            services.control ??
            new ControlService<T>(context, {
                appLifecycleService: this._appLifecycle,
                databaseService: this._database,
                fileProcessingService: this._fileProcessing,
                settingService: this._setting,
                APIService: this._api,
                replicatorService: this._replicator,
            });
    }
}
