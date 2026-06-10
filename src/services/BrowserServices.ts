import { InjectableAppLifecycleService } from "./implements/injectable/InjectableAppLifecycleService";
import { InjectableConflictService } from "./implements/injectable/InjectableConflictService";
import { InjectableDatabaseEventService } from "./implements/injectable/InjectableDatabaseEventService";
import { InjectableFileProcessingService } from "./implements/injectable/InjectableFileProcessingService";
import { PathServiceCompat } from "./implements/injectable/InjectablePathService";
import { InjectableRemoteService } from "./implements/injectable/InjectableRemoteService";
import { InjectableReplicationService } from "./implements/injectable/InjectableReplicationService";
import { InjectableReplicatorService } from "./implements/injectable/InjectableReplicatorService";
import { InjectableSettingService } from "./implements/injectable/InjectableSettingService";
import { InjectableTestService } from "./implements/injectable/InjectableTestService";
import { InjectableTweakValueService } from "./implements/injectable/InjectableTweakValueService";
import { InjectableVaultServiceCompat } from "./implements/injectable/InjectableVaultService";
import { ServiceContext } from "./base/ServiceBase";
import { ConfigServiceBrowserCompat } from "./implements/browser/ConfigServiceBrowserCompat";
import { InjectableServiceHub } from "./implements/injectable/InjectableServiceHub";
import { BrowserUIService } from "./implements/browser/BrowserUIService";
import type { ServiceInstances } from "./ServiceHub";
import { BrowserAPIService } from "./implements/browser/BrowserAPIService";
import { BrowserDatabaseService, BrowserKeyValueDBService } from "./implements/browser/BrowserDatabaseService";
import { ControlService } from "./base/ControlService";
import type { AppLifecycleServiceDependencies } from "./base/AppLifecycleService";

class BrowserAppLifecycleService<T extends ServiceContext> extends InjectableAppLifecycleService<T> {
    constructor(context: T, dependencies: AppLifecycleServiceDependencies) {
        super(context, dependencies);
    }
}
export class BrowserServiceHub<T extends ServiceContext> extends InjectableServiceHub<T> {
    //  get vault():InjectableVaultServiceCompat<T>;
    override get vault(): InjectableVaultServiceCompat<T> {
        return this._vault as InjectableVaultServiceCompat<T>;
    }
    constructor() {
        const context = new ServiceContext() as T;
        const API = new BrowserAPIService(context);
        const conflict = new InjectableConflictService(context);
        const fileProcessing = new InjectableFileProcessingService(context);

        const setting = new InjectableSettingService(context, { APIService: API });
        const appLifecycle = new BrowserAppLifecycleService(context, { settingService: setting });
        const remote = new InjectableRemoteService(context, {
            APIService: API,
            appLifecycle: appLifecycle,
            setting: setting,
        });
        const tweakValue = new InjectableTweakValueService(context);
        const vault = new InjectableVaultServiceCompat<T>(context, {
            settingService: setting,
            APIService: API,
        });
        const test = new InjectableTestService(context);
        const databaseEvents = new InjectableDatabaseEventService(context);
        const path = new PathServiceCompat(context, {
            settingService: setting,
        });
        const database = new BrowserDatabaseService(context, {
            path: path,
            vault: vault,
            setting: setting,
            API: API,
        });
        const config = new ConfigServiceBrowserCompat<T>(context, {
            settingService: setting,
            APIService: API,
        });
        const replicator = new InjectableReplicatorService(context, {
            settingService: setting,
            appLifecycleService: appLifecycle,
            databaseEventService: databaseEvents,
        });
        const replication = new InjectableReplicationService(context, {
            APIService: API,
            appLifecycleService: appLifecycle,
            replicatorService: replicator,
            settingService: setting,
            fileProcessingService: fileProcessing,
            databaseService: database,
        });
        const keyValueDB = new BrowserKeyValueDBService(context, {
            appLifecycle: appLifecycle,
            databaseEvents: databaseEvents,
            vault: vault,
        });
        const control = new ControlService(context, {
            appLifecycleService: appLifecycle,
            databaseService: database,
            fileProcessingService: fileProcessing,
            settingService: setting,
            APIService: API,
            replicatorService: replicator,
        });
        const ui = new BrowserUIService<T>(context, {
            appLifecycle,
            config,
            replicator,
            APIService: API,
            control: control,
        });

        // Using 'satisfies' to ensure all services are provided
        const serviceInstancesToInit = {
            appLifecycle: appLifecycle,
            conflict: conflict,
            database: database,
            databaseEvents: databaseEvents,
            fileProcessing: fileProcessing,
            replication: replication,
            replicator: replicator,
            remote: remote,
            setting: setting,
            tweakValue: tweakValue,
            vault: vault,
            test: test,
            ui: ui,
            path: path,
            API: API,
            config: config,
            keyValueDB: keyValueDB,
            control: control,
        } satisfies Required<ServiceInstances<T>>;

        super(context, serviceInstancesToInit);
    }
}
