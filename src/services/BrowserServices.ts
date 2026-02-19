import { InjectableAppLifecycleService } from "@lib/services/implements/injectable/InjectableAppLifecycleService";
import { InjectableConflictService } from "@lib/services/implements/injectable/InjectableConflictService";
import { InjectableDatabaseEventService } from "@lib/services/implements/injectable/InjectableDatabaseEventService";
import { InjectableFileProcessingService } from "@lib/services/implements/injectable/InjectableFileProcessingService";
import { PathServiceCompat } from "@lib/services/implements/injectable/InjectablePathService";
import { InjectableRemoteService } from "@lib/services/implements/injectable/InjectableRemoteService";
import { InjectableReplicationService } from "@lib/services/implements/injectable/InjectableReplicationService";
import { InjectableReplicatorService } from "@lib/services/implements/injectable/InjectableReplicatorService";
import { InjectableSettingService } from "@lib/services/implements/injectable/InjectableSettingService";
import { InjectableTestService } from "@lib/services/implements/injectable/InjectableTestService";
import { InjectableTweakValueService } from "@lib/services/implements/injectable/InjectableTweakValueService";
import { InjectableVaultServiceCompat } from "@lib/services/implements/injectable/InjectableVaultService";
import { ServiceContext } from "@lib/services/base/ServiceBase";
import { ConfigServiceBrowserCompat } from "@lib/services/implements/browser/ConfigServiceBrowserCompat";
import { InjectableServiceHub } from "@lib/services/implements/injectable/InjectableServiceHub";
import { BrowserUIService } from "@lib/services/implements/browser/BrowserUIService";
import type { ServiceInstances } from "@lib/services/ServiceHub";
import { BrowserAPIService } from "./implements/browser/BrowserAPIService";
import { BrowserDatabaseService, BrowserKeyValueDBService } from "./implements/browser/BrowserDatabaseService";
import { ControlService } from "./base/ControlService";

class BrowserAppLifecycleService<T extends ServiceContext> extends InjectableAppLifecycleService<T> {
    constructor(context: T) {
        super(context);
    }
}
export class BrowserServiceHub<T extends ServiceContext> extends InjectableServiceHub<T> {
    //  get vault():InjectableVaultServiceCompat<T>;
    get vault(): InjectableVaultServiceCompat<T> {
        return this._vault as InjectableVaultServiceCompat<T>;
    }
    constructor() {
        const context = new ServiceContext() as T;
        const API = new BrowserAPIService(context);
        const appLifecycle = new BrowserAppLifecycleService(context);
        const conflict = new InjectableConflictService(context);
        const fileProcessing = new InjectableFileProcessingService(context);
        const replication = new InjectableReplicationService(context);

        const remote = new InjectableRemoteService(context);
        const setting = new InjectableSettingService(context, { APIService: API });
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
        const ui = new BrowserUIService<T>(context, {
            appLifecycle,
            config,
            replicator,
            APIService: API,
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
