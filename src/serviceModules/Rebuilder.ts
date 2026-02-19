import { FlagFilesHumanReadable } from "@lib/common/models/redflag.const";
import { REMOTE_MINIO } from "@lib/common/models/setting.const";
import { DEFAULT_SETTINGS } from "@lib/common/models/setting.const.defaults";
import type { IFileHandler } from "@lib/interfaces/FileHandler";
import type { APIService } from "@lib/services/base/APIService";
import type { AppLifecycleService } from "@lib/services/base/AppLifecycleService";
import type { DatabaseEventService } from "@lib/services/base/DatabaseEventService";
import type { DatabaseService } from "@lib/services/base/DatabaseService";
import type { RemoteService } from "@lib/services/base/RemoteService";
import type { ReplicationService } from "@lib/services/base/ReplicationService";
import type { ReplicatorService } from "@lib/services/base/ReplicatorService";
import type { SettingService } from "@lib/services/base/SettingService";
import type { VaultService } from "@lib/services/base/VaultService";
import type { UIService } from "@lib/services/implements/base/UIService";
import type { Rebuilder } from "@lib/interfaces/DatabaseRebuilder";
import type { StorageAccess } from "@lib/interfaces/StorageAccess";
import { LOG_LEVEL_NOTICE, LOG_LEVEL_VERBOSE } from "octagonal-wheels/common/logger";
import { delay } from "octagonal-wheels/promises";
import { eventHub } from "@lib/hub/hub";
import { EVENT_DATABASE_REBUILT } from "@lib/events/coreEvents";
import { ServiceModuleBase } from "@lib/serviceModules/ServiceModuleBase";
import type { ControlService } from "../services/base/ControlService";

export interface ServiceRebuilderDependencies {
    appLifecycle: AppLifecycleService;
    API: APIService;
    UI: UIService;
    setting: SettingService;
    remote: RemoteService;
    databaseEvents: DatabaseEventService;
    storageAccess: StorageAccess;
    replicator: ReplicatorService;
    vault: VaultService;
    replication: ReplicationService;
    database: DatabaseService;
    fileHandler: IFileHandler;
    control: ControlService;
}

export class ServiceRebuilder extends ServiceModuleBase<ServiceRebuilderDependencies> implements Rebuilder {
    private appLifecycle: AppLifecycleService;
    private API: APIService;
    private UI: UIService;
    private setting: SettingService;
    private remote: RemoteService;
    private databaseEvents: DatabaseEventService;
    private storageAccess: StorageAccess;
    private replicator: ReplicatorService;
    private vault: VaultService;
    private replication: ReplicationService;
    private database: DatabaseService;
    private fileHandler: IFileHandler;
    private control: ControlService;
    constructor(services: ServiceRebuilderDependencies) {
        super(services);
        this.appLifecycle = services.appLifecycle;
        this.API = services.API;
        this.UI = services.UI;
        this.setting = services.setting;
        this.remote = services.remote;
        this.databaseEvents = services.databaseEvents;
        this.storageAccess = services.storageAccess;
        this.replicator = services.replicator;
        this.vault = services.vault;
        this.replication = services.replication;
        this.database = services.database;
        this.fileHandler = services.fileHandler;
        this.control = services.control;
        services.database.onDatabaseReset.addHandler(this._onResetLocalDatabase.bind(this));
        // services.remote.tryResetDatabase.setHandler(this._tryResetRemoteDatabase.bind(this));
        // services.remote.tryCreateDatabase.setHandler(this._tryCreateRemoteDatabase.bind(this));
        services.setting.suspendAllSync.addHandler(this._allSuspendAllSync.bind(this));
    }

    async $performRebuildDB(
        method: "localOnly" | "remoteOnly" | "rebuildBothByThisDevice" | "localOnlyWithChunks"
    ): Promise<void> {
        if (method == "localOnly") {
            await this.$fetchLocal();
        }
        if (method == "localOnlyWithChunks") {
            await this.$fetchLocal(true);
        }
        if (method == "remoteOnly") {
            await this.$rebuildRemote();
        }
        if (method == "rebuildBothByThisDevice") {
            await this.$rebuildEverything();
        }
    }

    async informOptionalFeatures() {
        await this.UI.showMarkdownDialog(
            "All optional features are disabled",
            `Customisation Sync and Hidden File Sync will all be disabled.
Please enable them from the settings screen after setup is complete.`,
            ["OK"]
        );
    }
    async askUsingOptionalFeature(opt: { enableFetch?: boolean; enableOverwrite?: boolean }) {
        if (
            (await this.UI.confirm.askYesNoDialog(
                "Do you want to enable extra features? If you are new to Self-hosted LiveSync, try the core feature first!",
                { title: "Enable extra features", defaultOption: "No", timeout: 15 }
            )) == "yes"
        ) {
            await this.setting.suggestOptionalFeatures(opt);
        }
    }

    async rebuildRemote() {
        await this.setting.suspendExtraSync();
        await this.setting.applyPartial({
            isConfigured: true,
            notifyThresholdOfRemoteStorageSize: DEFAULT_SETTINGS.notifyThresholdOfRemoteStorageSize,
        });
        // this.core.settings.isConfigured = true;
        // this.core.settings.notifyThresholdOfRemoteStorageSize = DEFAULT_SETTINGS.notifyThresholdOfRemoteStorageSize;
        await this.control.applySettings();
        await this.remote.markLocked();
        await this._tryResetRemoteDatabase();
        await this.remote.markLocked();
        await delay(500);
        // await this.askUsingOptionalFeature({ enableOverwrite: true });
        await delay(1000);
        await this.remote.replicateAllToRemote(true);
        await delay(1000);
        await this.remote.replicateAllToRemote(true, true);
        await this.informOptionalFeatures();
    }
    $rebuildRemote(): Promise<void> {
        return this.rebuildRemote();
    }

    async rebuildEverything() {
        await this.setting.suspendExtraSync();
        // await this.askUseNewAdapter();
        await this.setting.applyPartial({
            isConfigured: true,
            notifyThresholdOfRemoteStorageSize: DEFAULT_SETTINGS.notifyThresholdOfRemoteStorageSize,
        });
        await this.control.applySettings();
        await this.resetLocalDatabase();
        await delay(1000);
        await this.databaseEvents.initialiseDatabase(true, true, true);
        await this.remote.markLocked();
        await this._tryResetRemoteDatabase();
        await this.remote.markLocked();
        await delay(500);
        // We do not have any other devices' data, so we do not need to ask for overwriting.
        // await this.askUsingOptionalFeature({ enableOverwrite: false });
        await delay(1000);
        await this.remote.replicateAllToRemote(true);
        await delay(1000);
        await this.remote.replicateAllToRemote(true, true);
        await this.informOptionalFeatures();
    }

    $rebuildEverything(): Promise<void> {
        return this.rebuildEverything();
    }

    $fetchLocal(makeLocalChunkBeforeSync?: boolean, preventMakeLocalFilesBeforeSync?: boolean): Promise<void> {
        return this.fetchLocal(makeLocalChunkBeforeSync, preventMakeLocalFilesBeforeSync);
    }

    async scheduleRebuild(): Promise<void> {
        try {
            await this.storageAccess.writeFileAuto(FlagFilesHumanReadable.REBUILD_ALL, "");
        } catch (ex) {
            this._log(`Could not create ${FlagFilesHumanReadable.REBUILD_ALL}`, LOG_LEVEL_NOTICE);
            this._log(ex, LOG_LEVEL_VERBOSE);
        }
        this.appLifecycle.performRestart();
    }
    async scheduleFetch(): Promise<void> {
        try {
            await this.storageAccess.writeFileAuto(FlagFilesHumanReadable.FETCH_ALL, "");
        } catch (ex) {
            this._log(`Could not create ${FlagFilesHumanReadable.FETCH_ALL}`, LOG_LEVEL_NOTICE);
            this._log(ex, LOG_LEVEL_VERBOSE);
        }
        this.appLifecycle.performRestart();
    }

    private async _tryResetRemoteDatabase(): Promise<void> {
        const currentReplicator = this.replicator.getActiveReplicator();
        const settings = this.setting.currentSettings();
        if (!currentReplicator) {
            this._log("No active replicator found when trying to reset remote database.", LOG_LEVEL_NOTICE);
            return;
        }
        await currentReplicator.tryResetRemoteDatabase(settings);
    }

    // private async _tryCreateRemoteDatabase(): Promise<void> {
    //     const currentReplicator = this.replicator.getActiveReplicator();
    //     const settings = this.setting.currentSettings();
    //     if (!currentReplicator) {
    //         this._log("No active replicator found when trying to create remote database.", LOG_LEVEL_NOTICE);
    //         return;
    //     }
    //     await currentReplicator.tryCreateRemoteDatabase(settings);
    // }

    private _onResetLocalDatabase(): Promise<boolean> {
        this.storageAccess.clearTouched();
        return Promise.resolve(true);
    }

    async suspendAllSync() {
        await this.setting.applyPartial({
            liveSync: false,
            periodicReplication: false,
            syncOnSave: false,
            syncOnEditorSave: false,
            syncOnStart: false,
            syncOnFileOpen: false,
            syncAfterMerge: false,
        });
        await this.setting.suspendExtraSync();
    }
    async suspendReflectingDatabase() {
        const settings = this.setting.currentSettings();
        if (settings.doNotSuspendOnFetching) return;
        if (settings.remoteType == REMOTE_MINIO) return;
        this._log(
            `Suspending reflection: Database and storage changes will not be reflected in each other until completely finished the fetching.`,
            LOG_LEVEL_NOTICE
        );
        await this.setting.applyPartial({
            suspendParseReplicationResult: true,
            suspendFileWatching: true,
        });
        await this.setting.saveSettingData();
    }
    async resumeReflectingDatabase() {
        const settings = this.setting.currentSettings();
        if (settings.doNotSuspendOnFetching) return;
        if (settings.remoteType == REMOTE_MINIO) return;
        this._log(`Database and storage reflection has been resumed!`, LOG_LEVEL_NOTICE);
        await this.setting.applyPartial({
            suspendParseReplicationResult: false,
            suspendFileWatching: false,
        });
        await this.vault.scanVault(true);
        await this.replication.onBeforeReplicate(false); //TODO: Check actual need of this.
        await this.setting.saveSettingData();
    }

    async fetchLocal(makeLocalChunkBeforeSync?: boolean, preventMakeLocalFilesBeforeSync?: boolean) {
        await this.setting.suspendExtraSync();
        // await this.askUseNewAdapter();
        await this.setting.applyPartial({
            isConfigured: true,
            notifyThresholdOfRemoteStorageSize: DEFAULT_SETTINGS.notifyThresholdOfRemoteStorageSize,
        });
        const settings = this.setting.currentSettings();
        if (settings.maxMTimeForReflectEvents > 0) {
            const date = new Date(settings.maxMTimeForReflectEvents);

            const ask = `Your settings restrict file reflection times to no later than ${date}.

**This is a recovery configuration.**

This operation should only be performed on an empty vault.
Are you sure you wish to proceed?`;
            const PROCEED = "I understand, proceed";
            const CANCEL = "Cancel operation";
            const CLEARANDPROCEED = "Clear restriction and proceed";
            const choices = [PROCEED, CLEARANDPROCEED, CANCEL] as const;
            const ret = await this.UI.confirm.askSelectStringDialogue(ask, choices, {
                title: "Confirm restricted fetch",
                defaultAction: CANCEL,
                timeout: 0,
            });
            if (ret == CLEARANDPROCEED) {
                await this.setting.applyPartial({ maxMTimeForReflectEvents: 0 });
                await this.setting.saveSettingData();
            }
            if (ret == CANCEL) {
                return;
            }
        }
        await this.suspendReflectingDatabase();
        await this.control.applySettings();
        await this.resetLocalDatabase();
        await delay(1000);
        await this.database.openDatabase({
            databaseEvents: this.databaseEvents,
            replicator: this.replicator,
        });
        // this.core.isReady = true;
        this.appLifecycle.markIsReady();
        if (makeLocalChunkBeforeSync) {
            await this.fileHandler.createAllChunks(true);
        } else if (!preventMakeLocalFilesBeforeSync) {
            await this.databaseEvents.initialiseDatabase(true, true, true);
        } else {
            // Do not create local file entries before sync (Means use remote information)
        }
        await this.remote.markResolved();
        await delay(500);
        await this.remote.replicateAllFromRemote(true);
        await delay(1000);
        await this.remote.replicateAllFromRemote(true);
        await this.resumeReflectingDatabase();
        await this.informOptionalFeatures();
        // No longer enable
        // await this.askUsingOptionalFeature({ enableFetch: true });
    }
    async fetchLocalWithRebuild() {
        return await this.fetchLocal(true);
    }

    private async _allSuspendAllSync(): Promise<boolean> {
        await this.suspendAllSync();
        return true;
    }

    async resetLocalDatabase() {
        const settings = this.setting.currentSettings();
        if (settings.isConfigured && settings.additionalSuffixOfDatabaseName == "") {
            // Discard the non-suffixed database
            await this.database.resetDatabase();
        }
        const suffix = this.API.getAppID() || "";
        await this.setting.applyPartial({ additionalSuffixOfDatabaseName: suffix });
        await this.database.resetDatabase();
        eventHub.emitEvent(EVENT_DATABASE_REBUILT);
    }
}
