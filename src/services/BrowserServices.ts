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
import type { ServiceInstances } from "@lib/services/ServiceHub";
import { BrowserDatabaseService, BrowserKeyValueDBService } from "./implements/browser/BrowserDatabaseService";
import { ControlService } from "./base/ControlService";
import type { AppLifecycleService, AppLifecycleServiceDependencies } from "./base/AppLifecycleService";
import type { ConfigService } from "./base/ConfigService";
import type { ReplicatorService } from "./base/ReplicatorService";
import type { UIService } from "./implements/base/UIService";
import type { InjectableAPIService } from "./implements/injectable/InjectableAPIService";
import { createIndexedDBKeyValueDatabaseFactory } from "@lib/databases/IndexedDBKeyValueDatabase";
import type { KeyValueDatabaseFactory } from "@lib/interfaces/KeyValueDatabase";
import { PouchDB } from "@lib/pouchdb/pouchdb-browser.ts";
import type { ObsidianLiveSyncSettings } from "@lib/common/types";

class BrowserAppLifecycleService<T extends ServiceContext> extends InjectableAppLifecycleService<T> {
    constructor(context: T, dependencies: AppLifecycleServiceDependencies) {
        super(context, dependencies);
    }
}

export type BrowserServiceHostDependencies<T extends ServiceContext> = {
    API: InjectableAPIService<T>;
    appLifecycle: AppLifecycleService<T>;
    config: ConfigService<T>;
    control: ControlService<T>;
    replicator: ReplicatorService<T>;
};

/**
 * Host-owned presentation services used by the browser composition.
 *
 * Commonlib owns the data and replication composition, while the application
 * chooses its confirmation, dialogue, and other presentation behaviour.
 */
export interface BrowserServiceHost<T extends ServiceContext> {
    createAPI(context: T): InjectableAPIService<T>;
    createUI(context: T, dependencies: BrowserServiceHostDependencies<T>): UIService<T>;
}

export type BrowserServiceHubOptions<T extends ServiceContext> = {
    context?: T;
    host: BrowserServiceHost<T>;
    openKeyValueDatabase?: KeyValueDatabaseFactory;
    onDisplayLanguageChanged?: (language: ObsidianLiveSyncSettings["displayLanguage"]) => void;
};

export class BrowserServiceHub<T extends ServiceContext> extends InjectableServiceHub<T> {
    //  get vault():InjectableVaultServiceCompat<T>;
    override get vault(): InjectableVaultServiceCompat<T> {
        return this._vault as InjectableVaultServiceCompat<T>;
    }
    constructor(options: BrowserServiceHubOptions<T>) {
        const context = options.context ?? (new ServiceContext() as T);
        const API = options.host.createAPI(context);
        const conflict = new InjectableConflictService(context);
        const fileProcessing = new InjectableFileProcessingService(context);

        const setting = new InjectableSettingService(context, {
            APIService: API,
            onDisplayLanguageChanged: options.onDisplayLanguageChanged,
        });
        const appLifecycle = new BrowserAppLifecycleService(context, { settingService: setting });
        const remote = new InjectableRemoteService(context, {
            pouchDB: PouchDB,
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
            pouchDB: PouchDB,
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
            openKeyValueDatabase: options.openKeyValueDatabase ?? createIndexedDBKeyValueDatabaseFactory(),
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
        const ui = options.host.createUI(context, {
            API,
            appLifecycle,
            config,
            control,
            replicator,
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
