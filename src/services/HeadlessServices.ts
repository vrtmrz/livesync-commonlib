import { type AppLifecycleService, type AppLifecycleServiceDependencies } from "@lib/services/base/AppLifecycleService";

import { InjectableAppLifecycleService } from "@lib/services/implements/injectable/InjectableAppLifecycleService";
import { InjectableConflictService } from "@lib/services/implements/injectable/InjectableConflictService";
import { InjectableDatabaseEventService } from "@lib/services/implements/injectable/InjectableDatabaseEventService";
import { InjectableFileProcessingService } from "@lib/services/implements/injectable/InjectableFileProcessingService";
import { PathServiceCompat } from "@lib/services/implements/injectable/InjectablePathService";
import { InjectableRemoteService } from "@lib/services/implements/injectable/InjectableRemoteService";
import { InjectableReplicationService } from "@lib/services/implements/injectable/InjectableReplicationService";
import { InjectableReplicatorService } from "@lib/services/implements/injectable/InjectableReplicatorService";
import { InjectableTestService } from "@lib/services/implements/injectable/InjectableTestService";
import { InjectableTweakValueService } from "@lib/services/implements/injectable/InjectableTweakValueService";
import { InjectableVaultServiceCompat } from "@lib/services/implements/injectable/InjectableVaultService";
import { ServiceContext } from "@lib/services/base/ServiceBase";
import { ConfigServiceBrowserCompat } from "@lib/services/implements/browser/ConfigServiceBrowserCompat";
import { InjectableServiceHub } from "@lib/services/implements/injectable/InjectableServiceHub";
import type { ServiceInstances } from "@lib/services/ServiceHub";

import { UIService } from "@lib/services/implements/base/UIService";
import { HeadlessAPIService } from "./implements/headless/HeadlessAPIService";
import { HeadlessDatabaseService, HeadlessKeyValueDBService } from "./implements/headless/HeadlessDatabaseService";
import { SvelteDialogManagerBase, type ComponentHasResult } from "./implements/base/SvelteDialog";
import type { DatabaseService } from "@lib/services/base/DatabaseService.ts";
import { ControlService } from "./base/ControlService";
import { InjectableSettingService } from "./implements/injectable/InjectableSettingService";
import type { IControlService } from "./base/IService";

class HeadlessAppLifecycleService<T extends ServiceContext> extends InjectableAppLifecycleService<T> {
    constructor(context: T, dependencies: AppLifecycleServiceDependencies) {
        super(context, dependencies);
        // The main entry point when the environment is ready
        // const onReady = this.onReady.bind(this);
        // In headless, we must call onReady externally when ready
    }
}

class HeadlessSvelteDialogManager<T extends ServiceContext> extends SvelteDialogManagerBase<T> {
    openSvelteDialog<T, U>(component: ComponentHasResult<T, U>, initialData?: U): Promise<T | undefined> {
        throw new Error("Method not implemented.");
    }
}

type HeadlessUIServiceDependencies<T extends ServiceContext = ServiceContext> = {
    appLifecycle: AppLifecycleService<T>;
    config: ConfigServiceBrowserCompat<T>;
    replicator: InjectableReplicatorService<T>;
    APIService: HeadlessAPIService<T>;
    control: IControlService;
};

class HeadlessUIService extends UIService<ServiceContext> {
    override get dialogToCopy(): never {
        throw new Error("Method not implemented.");
    }
    constructor(context: ServiceContext, dependents: HeadlessUIServiceDependencies<ServiceContext>) {
        const headlessConfirm = dependents.APIService.confirm;
        const headlessSvelteDialogManager = new HeadlessSvelteDialogManager<ServiceContext>(context, {
            confirm: headlessConfirm,
            appLifecycle: dependents.appLifecycle,
            config: dependents.config,
            replicator: dependents.replicator,
            control: dependents.control,
        });
        super(context, {
            appLifecycle: dependents.appLifecycle,
            dialogManager: headlessSvelteDialogManager,
            APIService: dependents.APIService,
        });
    }
}
type Constructor<T> = new (...args: any[]) => T;

export class HeadlessServiceHub extends InjectableServiceHub<ServiceContext> {
    constructor(
        _context?: ServiceContext,
        overrideServiceConstructor: {
            database?: Constructor<DatabaseService<ServiceContext>>;
        } = {}
    ) {
        const context = _context ?? new ServiceContext();

        const API = new HeadlessAPIService(context);
        const conflict = new InjectableConflictService(context);
        const fileProcessing = new InjectableFileProcessingService(context);

        const setting = new InjectableSettingService(context, {
            APIService: API,
        });
        const appLifecycle = new HeadlessAppLifecycleService(context, {
            settingService: setting,
        });
        const remote = new InjectableRemoteService(context, {
            APIService: API,
            appLifecycle: appLifecycle,
            setting: setting,
        });
        const tweakValue = new InjectableTweakValueService(context);
        const vault = new InjectableVaultServiceCompat(context, {
            settingService: setting,
            APIService: API,
        });
        const test = new InjectableTestService(context);
        const databaseEvents = new InjectableDatabaseEventService(context);
        const path = new PathServiceCompat(context, {
            settingService: setting,
        });
        const database = new (overrideServiceConstructor.database ?? HeadlessDatabaseService)(context, {
            path: path,
            vault: vault,
            setting: setting,
        });
        const config = new ConfigServiceBrowserCompat<ServiceContext>(context, {
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
            databaseEventService: databaseEvents,
            replicatorService: replicator,
            settingService: setting,
            fileProcessingService: fileProcessing,
            databaseService: database,
        });

        const keyValueDB = new HeadlessKeyValueDBService(context, {
            appLifecycle: appLifecycle,
            databaseEvents: databaseEvents,
            vault: vault,
        });
        const control = new ControlService(context, {
            appLifecycleService: appLifecycle,
            settingService: setting,
            databaseService: database,
            fileProcessingService: fileProcessing,
            APIService: API,
            replicatorService: replicator,
        });
        const ui = new HeadlessUIService(context, {
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
        } satisfies Required<ServiceInstances<ServiceContext>>;

        super(context, serviceInstancesToInit);
    }
}
