import {
    LOG_LEVEL_INFO,
    LOG_LEVEL_NOTICE,
    LOG_LEVEL_VERBOSE,
    type LOG_LEVEL,
    type ObsidianLiveSyncSettings,
} from "@lib/common/types";
import { handlers } from "@lib/services/lib/HandlerUtils";
import type {
    IAPIService,
    IDatabaseEventService,
    IDatabaseService,
    IFileProcessingService,
    IReplicationService,
    IReplicatorService,
    ISettingService,
} from "./IService";
import { ServiceBase, type ServiceContext } from "./ServiceBase";
import { reactiveSource } from "octagonal-wheels/dataobject/reactive";
import { createInstanceLogFunction, type LogFunction } from "../lib/logUtils";
import { $msg } from "../../common/i18n";
import type { LiveSyncAbstractReplicator } from "../../replication/LiveSyncAbstractReplicator";
import { UnresolvedErrorManager } from "./UnresolvedErrorManager";
import type { AppLifecycleService } from "./AppLifecycleService";
import { isLockAcquired, shareRunningResult } from "octagonal-wheels/concurrency/lock";

/**
 * Event-triggered replication interval forecasted time.
 */
const REPLICATION_ON_EVENT_FORECASTED_TIME = 5000;

export interface ReplicationServiceDependencies {
    APIService: IAPIService;
    settingService: ISettingService;
    appLifecycleService: AppLifecycleService;
    databaseEventService: IDatabaseEventService;
    databaseService: IDatabaseService;
    replicatorService: IReplicatorService;
    fileProcessingService: IFileProcessingService;
}
/**
 * The ReplicationService provides methods for managing replication processes.
 */
export abstract class ReplicationService<T extends ServiceContext = ServiceContext>
    extends ServiceBase<T>
    implements IReplicationService
{
    private _unresolvedErrorManager: UnresolvedErrorManager;

    showError(msg: string, max_log_level: LOG_LEVEL = LOG_LEVEL_NOTICE) {
        this._unresolvedErrorManager.showError(msg, max_log_level);
    }
    clearErrors() {
        this._unresolvedErrorManager.clearErrors();
    }

    _log: LogFunction;
    settingService: ISettingService;
    databaseEventService: IDatabaseEventService;
    appLifecycleService: AppLifecycleService;
    replicatorService: IReplicatorService;
    APIService: IAPIService;
    fileProcessing: IFileProcessingService;
    databaseService: IDatabaseService;
    constructor(context: T, dependencies: ReplicationServiceDependencies) {
        super(context);
        this.appLifecycleService = dependencies.appLifecycleService;
        this.settingService = dependencies.settingService;
        this.databaseEventService = dependencies.databaseEventService;
        this.replicatorService = dependencies.replicatorService;
        this.APIService = dependencies.APIService;
        this.fileProcessing = dependencies.fileProcessingService;
        this.databaseService = dependencies.databaseService;
        this._log = createInstanceLogFunction("ReplicationService", dependencies.APIService);
        this._unresolvedErrorManager = new UnresolvedErrorManager(dependencies.appLifecycleService);
    }
    /**
     * Process a synchronisation result document.
     */
    readonly processSynchroniseResult = handlers<IReplicationService>().anySuccess("processSynchroniseResult");

    /**
     * Process a synchronisation result document for optional entries i.e., hidden files.
     */
    readonly processOptionalSynchroniseResult = handlers<IReplicationService>().anySuccess(
        "processOptionalSynchroniseResult"
    );
    /**
     * Process an array of synchronisation result documents.
     * @param docs An array of documents to parse and handle.
     */
    readonly parseSynchroniseResult = handlers<IReplicationService>().all("parseSynchroniseResult");
    /**
     * Process a virtual document (e.g., for customisation sync).
     */
    readonly processVirtualDocument = handlers<IReplicationService>().anySuccess("processVirtualDocument");

    /**
     * An event triggered before starting replication.
     */
    readonly onBeforeReplicate = handlers<IReplicationService>().bailFirstFailure("onBeforeReplicate");

    /**
     *
     */
    readonly onCheckReplicationReady = handlers<IReplicationService>().bailFirstFailure("onCheckReplicationReady");

    /**
     *  Check if the replication is ready to start.
     * @param showMessage Whether to show messages to the user.
     */
    async isReplicationReady(showMessage: boolean = false): Promise<boolean> {
        if (!this.appLifecycleService.isReady()) {
            this._log(`Not ready`);
            return false;
        }
        const currentSettings = this.settingService.currentSettings();

        if (isLockAcquired("cleanup")) {
            this._log($msg("Replicator.Message.Cleaned"), LOG_LEVEL_NOTICE);
            return false;
        }

        if (currentSettings.versionUpFlash != "") {
            this._log($msg("Replicator.Message.VersionUpFlash"), LOG_LEVEL_NOTICE);
            return false;
        }

        if (!(await this.fileProcessing.commitPendingFileEvents())) {
            this.showError($msg("Replicator.Message.Pending"), LOG_LEVEL_NOTICE);
            return false;
        }

        if (!this.databaseService.managers.networkManager.isOnline) {
            this.showError("Network is offline", showMessage ? LOG_LEVEL_NOTICE : LOG_LEVEL_INFO);
            return false;
        }
        if (!(await this.onBeforeReplicate(showMessage))) {
            this.showError($msg("Replicator.Message.SomeModuleFailed"), LOG_LEVEL_NOTICE);
            return false;
        }
        this.clearErrors();
        return true;
    }

    onReplicationFailed = handlers<IReplicationService>().bailFirstFailure("onReplicationFailed");

    /**
     * perform replication. The actual replication logic should be implemented in the handler of this event.
     * @param showMessage
     */
    async performReplication(showMessage?: boolean): Promise<boolean | void> {
        const activeReplicator = this.replicatorService.getActiveReplicator();
        if (!activeReplicator) {
            this._log(`No active replicator found`, showMessage ? LOG_LEVEL_NOTICE : LOG_LEVEL_INFO);
            return false;
        }
        const settings = this.settingService.currentSettings();
        const ret = await activeReplicator.openReplication(settings, false, !!showMessage, false);
        if (!ret) {
            return await this.onReplicationFailed(showMessage);
        }
        return ret;
    }

    /**
     * Start the replication process.
     * @param showMessage Whether to show messages to the user.
     */
    async replicate(showMessage?: boolean): Promise<boolean | void> {
        try {
            const checkBeforeReplicate = await this.isReplicationReady(showMessage);
            if (!checkBeforeReplicate) return false;
            return await this.performReplication(showMessage);
        } finally {
            this.previousReplicated = Date.now();
        }
    }

    previousReplicated: number = 0;
    /**
     * Start the replication process triggered by an event (e.g., file change).
     * @param showMessage Whether to show messages to the user.
     */
    replicateByEvent(showMessage?: boolean): Promise<boolean | void> {
        // If triggered multiple times in a short time, we will only perform replication once.
        return shareRunningResult(`replication`, async () => {
            const currentSettings = this.settingService.currentSettings();
            const least = currentSettings.syncMinimumInterval;
            if (least > 0) {
                const now = Date.now();
                const elapsed = now - this.previousReplicated;
                if (elapsed < least) {
                    this._log(
                        `Replication triggered by event is rate limited. Elapsed: ${elapsed}ms, Least interval: ${least}ms`,
                        LOG_LEVEL_VERBOSE
                    );
                    return Promise.resolve(true);
                }
                // Update once.
                this.previousReplicated = now + REPLICATION_ON_EVENT_FORECASTED_TIME;
                return await this.replicate();
            }
            // No rate limit, replicate immediately, but serialised.
            return this.replicate();
        });
    }

    /**
     * Check if there is a connection failure with the remote database.
     */
    readonly checkConnectionFailure = handlers<IReplicationService>().firstResult("checkConnectionFailure");
    databaseQueueCount = reactiveSource(0);
    storageApplyingCount = reactiveSource(0);
    replicationResultCount = reactiveSource(0);

    getActiveReplicatorFor(usage: string) {
        const activeReplicator = this.replicatorService.getActiveReplicator();
        if (!activeReplicator) {
            this._log(`Active replicator not found during ${usage}`, LOG_LEVEL_NOTICE);
            return false;
        }
        return activeReplicator;
    }

    async replicateAllToRemote(
        showingNotice: boolean = false,
        sendChunksInBulkDisabled: boolean = false
    ): Promise<boolean> {
        if (!this.appLifecycleService.isReady()) return false;
        if (!(await this.onBeforeReplicate(showingNotice))) {
            this._log($msg("Replicator.Message.SomeModuleFailed"), LOG_LEVEL_NOTICE);
            return false;
        }
        const currentSettings = this.settingService.currentSettings();
        const activeReplicator = this.getActiveReplicatorFor("sending data to remote");
        if (!activeReplicator) {
            return false;
        }
        if (!sendChunksInBulkDisabled) {
            if (activeReplicator?.isChunkSendingSupported) {
                if (
                    (await this.APIService.confirm.askYesNoDialog(
                        "Do you want to send all chunks before replication?",
                        {
                            defaultOption: "No",
                            timeout: 20,
                        }
                    )) == "yes"
                ) {
                    await activeReplicator.sendChunks(currentSettings, undefined, true, 0);
                }
            }
        }
        const ret = await activeReplicator.replicateAllToServer(currentSettings, showingNotice);
        if (ret) return true;
        const checkResult = await this.checkConnectionFailure();
        if (checkResult == "CHECKAGAIN")
            return await activeReplicator.replicateAllToServer(currentSettings, showingNotice);
        return !checkResult;
    }

    async replicateAllFromRemote(showingNotice: boolean = false): Promise<boolean> {
        if (!this.appLifecycleService.isReady()) return false;
        const activeReplicator = this.getActiveReplicatorFor("fetching data from remote");
        if (!activeReplicator) {
            return false;
        }
        const currentSettings = this.settingService.currentSettings();
        const ret = await activeReplicator.replicateAllFromServer(currentSettings, showingNotice);
        if (ret) return true;
        const checkResult = await this.checkConnectionFailure();
        if (checkResult == "CHECKAGAIN")
            return await activeReplicator.replicateAllFromServer(currentSettings, showingNotice);
        return !checkResult;
    }

    private _getReplicatorAndPerform(
        action: string,
        perform: (setting: ObsidianLiveSyncSettings, replicator: LiveSyncAbstractReplicator) => Promise<void>
    ) {
        const activeReplicator = this.getActiveReplicatorFor(action);
        if (!activeReplicator) {
            return Promise.resolve();
        }
        const currentSettings = this.settingService.currentSettings();
        return perform(currentSettings, activeReplicator);
    }

    async markLocked(lockByClean: boolean = false): Promise<void> {
        return await this._getReplicatorAndPerform(
            "marking remote locked",
            async (currentSettings, activeReplicator) => {
                return await activeReplicator.markRemoteLocked(currentSettings, true, lockByClean);
            }
        );
    }

    async markUnlocked(): Promise<void> {
        return await this._getReplicatorAndPerform(
            "marking remote unlocked",
            async (currentSettings, activeReplicator) => {
                return await activeReplicator.markRemoteLocked(currentSettings, false, false);
            }
        );
    }

    async markResolved(): Promise<void> {
        return await this._getReplicatorAndPerform(
            "marking remote resolved",
            async (currentSettings, activeReplicator) => {
                return await activeReplicator.markRemoteResolved(currentSettings);
            }
        );
    }
}
