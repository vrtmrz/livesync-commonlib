import { FlagFilesHumanReadable } from "@lib/common/models/redflag.const";
import { REMOTE_COUCHDB, REMOTE_MINIO } from "@lib/common/models/setting.const";
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
import type { ControlService } from "@lib/services/base/ControlService";
import { fetchChangesForInitialSync } from "@lib/pouchdb/StreamingFetch";
import { getConfiguredFunctionsForEncryption } from "@lib/pouchdb/encryption";
import { AuthorizationHeaderGenerator, generateCredentialObject } from "@lib/replication/httplib";
import { sizeToHumanReadable } from "octagonal-wheels/number";

const FAST_FETCH_CHECKPOINT_KEY = "fast-fetch-checkpoint";
const FAST_FETCH_RETRY_DELAYS = [2000, 5000, 10000, 20000];

type FastFetchCheckpoint = {
    remote: string;
    sequence: number | string;
};

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
        await this.replicator.runBoundedRemoteActivity(() => this.performRemoteRebuild(), {
            label: "rebuild-remote",
        });
        await this.informOptionalFeatures();
    }

    private async performRemoteRebuild() {
        await this.setting.suspendExtraSync();
        await this.setting.applyPartial({
            isConfigured: true,
            notifyThresholdOfRemoteStorageSize: DEFAULT_SETTINGS.notifyThresholdOfRemoteStorageSize,
        });
        // this.core.settings.isConfigured = true;
        // this.core.settings.notifyThresholdOfRemoteStorageSize = DEFAULT_SETTINGS.notifyThresholdOfRemoteStorageSize;
        await this.control.applySettings();
        await this.replication.markLocked();
        await this._tryResetRemoteDatabase();
        await this.replication.markLocked();
        await delay(500);
        // await this.askUsingOptionalFeature({ enableOverwrite: true });
        await delay(1000);
        await this.replication.replicateAllToRemote(true);
        await delay(1000);
        await this.replication.replicateAllToRemote(true, true);
    }
    $rebuildRemote(): Promise<void> {
        return this.rebuildRemote();
    }

    async rebuildEverything() {
        await this.replicator.runBoundedRemoteActivity(() => this.performRebuildEverything(), {
            label: "rebuild-everything",
        });
        await this.informOptionalFeatures();
    }

    private async performRebuildEverything() {
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
        await this.replication.markLocked();
        await this._tryResetRemoteDatabase();
        await this.replication.markLocked();
        await delay(500);
        // We do not have any other devices' data, so we do not need to ask for overwriting.
        // await this.askUsingOptionalFeature({ enableOverwrite: false });
        await delay(1000);
        await this.replication.replicateAllToRemote(true);
        await delay(1000);
        await this.replication.replicateAllToRemote(true, true);
    }

    $rebuildEverything(): Promise<void> {
        return this.rebuildEverything();
    }

    $fetchLocal(makeLocalChunkBeforeSync?: boolean, preventMakeLocalFilesBeforeSync?: boolean): Promise<void> {
        return this.fetchLocal(makeLocalChunkBeforeSync, preventMakeLocalFilesBeforeSync);
    }

    $fetchLocalDBFast(autoResume: boolean): Promise<void> {
        return this.fetchLocalDBFast(autoResume);
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
    async suspendReflectingDatabase(ignoreMinIO: boolean = false) {
        const settings = this.setting.currentSettings();
        if (settings.doNotSuspendOnFetching) return;
        if (!ignoreMinIO && settings.remoteType == REMOTE_MINIO) return;
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
    async resumeReflectingDatabase(ignoreMinIO: boolean = false) {
        const settings = this.setting.currentSettings();
        if (settings.doNotSuspendOnFetching) return;
        if (!ignoreMinIO && settings.remoteType == REMOTE_MINIO) return;
        this._log(`Database and storage reflection has been resumed!`, LOG_LEVEL_NOTICE);
        await this.setting.applyPartial({
            suspendParseReplicationResult: false,
            suspendFileWatching: false,
        });
        await this.vault.scanVault(true);
        await this.replication.onBeforeReplicate(false); //TODO: Check actual need of this.
        await this.setting.saveSettingData();
    }

    async fetchLocal(makeLocalChunkBeforeSync?: boolean, preventMakeLocalFilesBeforeSync?: boolean, autoResume = true) {
        await this.setting.suspendExtraSync();
        // await this.askUseNewAdapter();
        await this.setting.applyPartial({
            isConfigured: true,
            notifyThresholdOfRemoteStorageSize: DEFAULT_SETTINGS.notifyThresholdOfRemoteStorageSize,
        });
        const settings = this.setting.currentSettings();
        if (settings.maxMTimeForReflectEvents > 0) {
            const date = new Date(settings.maxMTimeForReflectEvents);

            const ask = `Your settings restrict file reflection times to no later than ${date.toLocaleString()}.

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
        await this.replicator.runBoundedRemoteActivity(
            () => this.performFetchLocal(makeLocalChunkBeforeSync, preventMakeLocalFilesBeforeSync, autoResume),
            { label: "rebuild-fetch" }
        );
    }

    private async performFetchLocal(
        makeLocalChunkBeforeSync?: boolean,
        preventMakeLocalFilesBeforeSync?: boolean,
        autoResume = true
    ) {
        // If autoResume is disabled, do not suspend reflection even for Minio.
        await this.suspendReflectingDatabase(!autoResume);
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
        await this.replication.markResolved();
        await delay(500);
        await this.replication.replicateAllFromRemote(true);
        await delay(1000);
        await this.replication.replicateAllFromRemote(true);
        if (autoResume) {
            await this.finishRebuild();
        }
    }

    async fetchLocalDBFast(autoResume: boolean) {
        await this.setting.suspendExtraSync();
        await this.setting.applyPartial({
            isConfigured: true,
            notifyThresholdOfRemoteStorageSize: DEFAULT_SETTINGS.notifyThresholdOfRemoteStorageSize,
        });
        const settings = this.setting.currentSettings();
        if (settings.remoteType !== REMOTE_COUCHDB) {
            this._log(
                "Fast database fetch is available only for CouchDB remote. Falling back to standard fetch.",
                LOG_LEVEL_NOTICE
            );
            await this.fetchLocal(false, true, autoResume);
            return;
        }

        await this.replicator.runBoundedRemoteActivity(() => this.performFetchLocalDBFast(settings, autoResume), {
            label: "fast-fetch",
        });
    }

    private async performFetchLocalDBFast(settings: ReturnType<SettingService["currentSettings"]>, autoResume: boolean) {
        const remote =
            settings.couchDB_URI.replace(/\/+$/, "") +
            (settings.couchDB_DBNAME == "" ? "" : "/" + settings.couchDB_DBNAME);
        let checkpoint = this.getFastFetchCheckpoint(remote);

        await this.suspendReflectingDatabase();
        await this.control.applySettings();
        let since = checkpoint?.sequence ?? "0";
        if (checkpoint) {
            this._log(
                `Resuming fast database fetch from sequence: ${checkpoint.sequence}`,
                LOG_LEVEL_NOTICE,
                "fetch-init-resume"
            );
        } else {
            await this.resetLocalDatabase();
            await delay(1000);
        }
        await this.database.openDatabase({
            databaseEvents: this.databaseEvents,
            replicator: this.replicator,
        });
        this.appLifecycle.markIsReady();

        let localDB = this.database.localDatabase.localDatabase;
        if (checkpoint && (await localDB.info()).doc_count == 0) {
            this._log(
                "Fast fetch checkpoint found, but the local database is empty. Starting from the beginning.",
                LOG_LEVEL_NOTICE,
                "fetch-init-resume"
            );
            this.clearFastFetchCheckpoint();
            await this.resetLocalDatabase();
            await delay(1000);
            await this.database.openDatabase({
                databaseEvents: this.databaseEvents,
                replicator: this.replicator,
            });
            localDB = this.database.localDatabase.localDatabase;
            since = "0";
        }
        const replicator = this.replicator.getActiveReplicator() ?? (await this.replicator.getNewReplicator());
        if (!replicator) {
            throw new Error("No active replicator found for fast fetch.");
        }
        const salt = () => replicator.getReplicationPBKDF2Salt(settings);
        const enc = getConfiguredFunctionsForEncryption(
            settings.passphrase,
            false,
            false,
            salt,
            settings.E2EEAlgorithm
        );

        const authHeader = await new AuthorizationHeaderGenerator().getAuthorizationHeader(
            generateCredentialObject(settings)
        );

        for (let attempt = 0; ; attempt++) {
            try {
                await fetchChangesForInitialSync(
                    localDB,
                    remote,
                    authHeader,
                    enc.outgoing,
                    since,
                    (progress) => {
                        this._log(
                            `Fast fetch progress: ${progress.totalValidFetched} / ${progress.docsToFetch}\nTotal bytes fetched: ${sizeToHumanReadable(progress.totalBytes)}`,
                            LOG_LEVEL_NOTICE,
                            "fetch-init-progress"
                        );
                    },
                    (sequence) => this.saveFastFetchCheckpoint(remote, sequence)
                );
                break;
            } catch (ex) {
                if (attempt >= FAST_FETCH_RETRY_DELAYS.length) throw ex;
                checkpoint = this.getFastFetchCheckpoint(remote);
                since = checkpoint?.sequence ?? since;
                this._log(
                    `Fast fetch interrupted. Retrying from sequence: ${since}`,
                    LOG_LEVEL_NOTICE,
                    "fetch-init-resume"
                );
                await delay(FAST_FETCH_RETRY_DELAYS[attempt]);
            }
        }

        const allDocs = await localDB.allDocs({ include_docs: false });
        this._log(
            `Fast database fetch completed. Total documents in local database: ${allDocs.total_rows}`,
            LOG_LEVEL_NOTICE,
            "fetch-init-complete"
        );

        await this.replication.markResolved();
        if (autoResume) {
            await this.resumeReflectingDatabase(true);
        }
        this.clearFastFetchCheckpoint();
    }

    /**
     * Finish rebuild process with resuming the reflection.
     *
     * @param ignoreMinIO Whether to ignore minio for resuming the reflection.
     */
    async finishRebuild(ignoreMinIO: boolean = true) {
        await this.resumeReflectingDatabase(ignoreMinIO);
    }

    /**
     * Fetch local database with making all chunks.
     * This is a wrapper for {@link fetchLocal} with makeLocalChunkBeforeSync = true.
     *
     * @returns
     */
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

    private getFastFetchCheckpoint(remote: string): FastFetchCheckpoint | undefined {
        const rawCheckpoint = this.setting.getSmallConfig(FAST_FETCH_CHECKPOINT_KEY);
        if (!rawCheckpoint) return undefined;

        try {
            const checkpoint = JSON.parse(rawCheckpoint) as Partial<FastFetchCheckpoint>;
            if (checkpoint.remote === remote && checkpoint.sequence !== undefined) {
                return {
                    remote,
                    sequence: checkpoint.sequence,
                };
            }
        } catch {
            // Ignore invalid checkpoints and start cleanly.
        }
        this.clearFastFetchCheckpoint();
        return undefined;
    }

    private saveFastFetchCheckpoint(remote: string, sequence: number | string) {
        this.setting.setSmallConfig(FAST_FETCH_CHECKPOINT_KEY, JSON.stringify({ remote, sequence }));
    }

    private clearFastFetchCheckpoint() {
        this.setting.deleteSmallConfig(FAST_FETCH_CHECKPOINT_KEY);
    }
}
