import { InjectableAppLifecycleService } from "@lib/services/implements/injectable/InjectableAppLifecycleService";
import { InjectableConflictService } from "@lib/services/implements/injectable/InjectableConflictService";
import { InjectableDatabaseEventService } from "@lib/services/implements/injectable/InjectableDatabaseEventService";
import { InjectableFileProcessingService } from "@lib/services/implements/injectable/InjectableFileProcessingService";
import { InjectablePathService } from "@lib/services/implements/injectable/InjectablePathService";
import { InjectableRemoteService } from "@lib/services/implements/injectable/InjectableRemoteService";
import { InjectableReplicationService } from "@lib/services/implements/injectable/InjectableReplicationService";
import { InjectableReplicatorService } from "@lib/services/implements/injectable/InjectableReplicatorService";
import { InjectableSettingService } from "@lib/services/implements/injectable/InjectableSettingService";
import { InjectableTestService } from "@lib/services/implements/injectable/InjectableTestService";
import { InjectableTweakValueService } from "@lib/services/implements/injectable/InjectableTweakValueService";
import { InjectableVaultService } from "@lib/services/implements/injectable/InjectableVaultService";
import { ServiceContext } from "@lib/services/base/ServiceBase";
import { ConfigServiceBrowserCompat } from "@lib/services/implements/browser/ConfigServiceBrowserCompat";
import { InjectableServiceHub } from "@lib/services/implements/injectable/InjectableServiceHub";
import { BrowserUIService } from "@lib/services/implements/browser/BrowserUIService";
import type { ServiceInstances } from "@lib/services/ServiceHub";
import { BrowserAPIService } from "./implements/browser/BrowserAPIService";
import { BrowserDatabaseService } from "./implements/browser/BrowserDatabaseService";

export class BrowserServiceHub<T extends ServiceContext> extends InjectableServiceHub<T> {
    constructor() {
        const context = new ServiceContext() as T;
        const API = new BrowserAPIService(context);
        const appLifecycle = new InjectableAppLifecycleService(context);
        const conflict = new InjectableConflictService(context);
        const database = new BrowserDatabaseService(context);
        const fileProcessing = new InjectableFileProcessingService(context);
        const replication = new InjectableReplicationService(context);
        const replicator = new InjectableReplicatorService(context);
        const remote = new InjectableRemoteService(context);
        const setting = new InjectableSettingService(context);
        const tweakValue = new InjectableTweakValueService(context);
        const vault = new InjectableVaultService(context);
        const test = new InjectableTestService(context);
        const databaseEvents = new InjectableDatabaseEventService(context);
        const path = new InjectablePathService(context);
        const config = new ConfigServiceBrowserCompat<T>(context, vault);
        const ui = new BrowserUIService<T>(context, {
            appLifecycle,
            config,
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
        } satisfies Required<ServiceInstances<T>>;

        super(context, serviceInstancesToInit);
    }
}
