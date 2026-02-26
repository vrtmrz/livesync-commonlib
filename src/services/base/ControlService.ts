// ControlService is meta-service.
//
// As the name suggests, it is responsible for multiple services related things.
// In the other word, it is orchestrating services.

import { LOG_LEVEL_URGENT } from "octagonal-wheels/common/logger";
import { createInstanceLogFunction } from "../lib/logUtils";
import type { APIService } from "./APIService";
import type { DatabaseService } from "./DatabaseService";
import type {
    IAppLifecycleService,
    IControlService,
    IFileProcessingService,
    IReplicatorService,
    ISettingService,
} from "./IService";
import { ServiceBase, type ServiceContext } from "./ServiceBase";
import { eventHub } from "../../hub/hub";
import { EVENT_PLATFORM_UNLOADED, EVENT_PLUGIN_UNLOADED } from "../../events/coreEvents";
import { cancelAllPeriodicTask, cancelAllTasks } from "octagonal-wheels/concurrency/task";
import { stopAllRunningProcessors } from "octagonal-wheels/concurrency/processor";
import { $msg } from "../../common/i18n";

// ControlService can depend on any service.
export interface ControlServiceDependencies {
    appLifecycleService: IAppLifecycleService;
    replicatorService: IReplicatorService;
    settingService: ISettingService;
    databaseService: DatabaseService;
    fileProcessingService: IFileProcessingService;
    APIService: APIService;
}

/**
 * The ControlService provides methods for controlling the overall behaviour of the plugin, such as applying settings or handling lifecycle events.
 */
export class ControlService<T extends ServiceContext = ServiceContext>
    extends ServiceBase<T>
    implements IControlService
{
    services: ControlServiceDependencies;
    _log: ReturnType<typeof createInstanceLogFunction>;
    _unloaded = false;

    /**
     * Check if the plug-in has been unloaded.
     */
    hasUnloaded(): boolean {
        return this._unloaded;
    }

    constructor(context: T, dependencies: ControlServiceDependencies) {
        super(context);
        this.services = dependencies;
        this._log = createInstanceLogFunction("ControlService", this.services.APIService);
    }

    /**
     * Apply current settings to reflect the changes immediately.
     * @returns
     */
    async applySettings() {
        await this.services.appLifecycleService.onSuspending();
        await this.services.settingService.onBeforeRealiseSetting();
        this.services.databaseService.localDatabase.refreshSettings();
        await this.services.fileProcessingService.commitPendingFileEvents();
        await this.services.settingService.onRealiseSetting();
        // disable all sync temporary.
        if (this.services.appLifecycleService.isSuspended()) return;
        await this.services.appLifecycleService.onResuming();
        await this.services.appLifecycleService.onResumed();
        await this.services.settingService.onSettingRealised();
    }

    private async _onLiveSyncUnload(): Promise<void> {
        eventHub.emitEvent(EVENT_PLUGIN_UNLOADED);
        await this.services.appLifecycleService.onBeforeUnload();
        await this.services.appLifecycleService.onAppUnload();
        cancelAllPeriodicTask();
        cancelAllTasks();
        stopAllRunningProcessors();
        await this.services.appLifecycleService.onUnload();
        this._unloaded = true;
        const localDatabase = this.services.databaseService.localDatabaseDirect;
        if (localDatabase != null) {
            const activeReplicator = this.services.replicatorService.getActiveReplicator();
            if (activeReplicator) {
                activeReplicator.closeReplication();
            }
            localDatabase.onunload();
            await localDatabase.close();
        }
        eventHub.emitEvent(EVENT_PLATFORM_UNLOADED);
        eventHub.offAll();
        this._log($msg("moduleLiveSyncMain.logUnloadingPlugin"));
        return;
    }

    /**
     * Called when the plugin is loaded. It will trigger the app lifecycle event onLoad.
     * Main process should be called in onReady.
     * @returns
     */
    async onLoad() {
        if (!(await this.services.appLifecycleService.onLoad())) {
            this._log("Self-hosted LiveSync cannot be initialised, exiting loading.", LOG_LEVEL_URGENT);
            return false;
        }
        return true;
    }
    /**
     * Main entry point of the plugin. It will trigger the app lifecycle event onReady.
     * Usually it should be called on `app.workspace.onLayoutReady`
     * @returns
     */
    async onReady() {
        return await this.services.appLifecycleService.onReady();
    }

    /**
     * On unload event of the plugin. It will trigger the app lifecycle event onUnload.
     * @returns
     */
    async onUnload() {
        return await this._onLiveSyncUnload();
    }
}
