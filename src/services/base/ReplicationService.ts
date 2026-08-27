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
    IDatabaseService,
    IFileProcessingService,
    IReplicationService,
    IReplicatorService,
    ISettingService,
} from "./IService";
import { ServiceBase, type ServiceContext } from "./ServiceBase";
import { reactiveSource } from "octagonal-wheels/dataobject/reactive";
import { createInstanceLogFunction, MARK_LOG_NETWORK_ERROR, type LogFunction } from "@lib/services/lib/logUtils";
import type { LiveSyncAbstractReplicator } from "@lib/replication/LiveSyncAbstractReplicator";
import {
    NO_INTERACTION,
    USER_INITIATED_REPLICATION_AUTHORITY,
    replicationBlocked,
    replicationFailed,
    type ActiveReplicatorContext,
    type CapabilitySupport,
    type ContinuousReplicationRequest,
    type InteractionAuthority,
    type ReplicationOutcome,
    type UnattendedOneShotRequest,
    type UserInitiatedOneShotRequest,
} from "@lib/replication/ReplicatorProvider.ts";
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
    appLifecycleService: AppLifecycleService;
    replicatorService: IReplicatorService;
    APIService: IAPIService;
    fileProcessing: IFileProcessingService;
    databaseService: IDatabaseService;
    constructor(context: T, dependencies: ReplicationServiceDependencies) {
        super(context);
        this.appLifecycleService = dependencies.appLifecycleService;
        this.settingService = dependencies.settingService;
        this.replicatorService = dependencies.replicatorService;
        this.APIService = dependencies.APIService;
        this.fileProcessing = dependencies.fileProcessingService;
        this.databaseService = dependencies.databaseService;
        this._log = createInstanceLogFunction("ReplicationService", dependencies.APIService);
        this._unresolvedErrorManager = new UnresolvedErrorManager(
            dependencies.appLifecycleService,
            this.context.events
        );
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
     * Lightweight, repeatable policy checks shared by every replication entry point.
     * Handlers must remain idempotent because a high-level replication may cross
     * more than one entry point before work begins.
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
        if (!(await this.onCheckReplicationReady(showMessage))) {
            return false;
        }
        const currentSettings = this.settingService.currentSettings();

        if (isLockAcquired("cleanup")) {
            this._log(this.context.translate("Replicator.Message.Cleaned"), LOG_LEVEL_NOTICE);
            return false;
        }

        if (currentSettings.versionUpFlash != "") {
            this._log(this.context.translate("Replicator.Message.VersionUpFlash"), LOG_LEVEL_NOTICE);
            return false;
        }

        if (!(await this.fileProcessing.commitPendingFileEvents())) {
            this.showError(this.context.translate("Replicator.Message.Pending"), LOG_LEVEL_NOTICE);
            return false;
        }

        if (!this.APIService.isOnline) {
            this.showError("Network is offline", showMessage ? LOG_LEVEL_NOTICE : LOG_LEVEL_INFO);
            return false;
        }
        if (!(await this.onBeforeReplicate(showMessage))) {
            // check for tagged network errors for filtering by NetworkWarningStyles
            const hasNetworkError = (await this.appLifecycleService.getUnresolvedMessages())
                .flat()
                .some((e) => typeof e == "string" && e.indexOf(MARK_LOG_NETWORK_ERROR) !== -1);
            if (!hasNetworkError) {
                this.showError(this.context.translate("Replicator.Message.SomeModuleFailed"), LOG_LEVEL_NOTICE);
            } else {
                this._log(this.context.translate("Replicator.Message.SomeModuleFailed"), LOG_LEVEL_INFO);
            }
            return false;
        }
        this.clearErrors();
        return true;
    }

    onReplicationFailed = handlers<IReplicationService>().bailFirstFailure("onReplicationFailed");

    private capabilityBlocked<TRole>(capability: CapabilitySupport<TRole>): ReplicationOutcome | undefined {
        if (capability.kind === "supported") return undefined;
        return replicationBlocked(capability.reason);
    }

    private async runFiniteActivity(
        run: () => Promise<ReplicationOutcome>,
        interaction: InteractionAuthority,
        showMessage: boolean
    ): Promise<ReplicationOutcome> {
        try {
            const result = await this.replicatorService.runFiniteReplicationActivity(run, { label: "replication" });
            if (result.status === "failed") {
                await this.onReplicationFailed(showMessage, interaction);
            }
            return result;
        } catch (error) {
            const result = replicationFailed(error);
            await this.onReplicationFailed(showMessage, interaction);
            return result;
        }
    }

    private async runUserInitiatedRole(
        context: ActiveReplicatorContext,
        request: UserInitiatedOneShotRequest,
        showMessage: boolean
    ): Promise<ReplicationOutcome> {
        const capability = context.provider.userInitiatedOneShot;
        const blocked = this.capabilityBlocked(capability);
        if (blocked) return blocked;
        if (capability.kind !== "supported") return replicationBlocked("capability-not-implemented");
        const settings = this.settingService.currentSettings();
        return await this.runFiniteActivity(
            () => capability.run(context.replicator, settings, request),
            request.interaction,
            showMessage
        );
    }

    private async runUnattendedRole(
        context: ActiveReplicatorContext,
        request: UnattendedOneShotRequest
    ): Promise<ReplicationOutcome> {
        const capability = context.provider.unattendedOneShot;
        const blocked = this.capabilityBlocked(capability);
        if (blocked) return blocked;
        if (capability.kind !== "supported") return replicationBlocked("capability-not-implemented");
        const settings = this.settingService.currentSettings();
        return await this.runFiniteActivity(
            () => capability.run(context.replicator, settings, request),
            NO_INTERACTION,
            false
        );
    }

    private async runContinuousRole(
        context: ActiveReplicatorContext,
        request: ContinuousReplicationRequest
    ): Promise<ReplicationOutcome> {
        const capability = context.provider.continuous;
        const blocked = this.capabilityBlocked(capability);
        if (blocked) return blocked;
        if (capability.kind !== "supported") return replicationBlocked("capability-not-implemented");
        try {
            return await capability.run(context.replicator, this.settingService.currentSettings(), request);
        } catch (error) {
            return replicationFailed(error);
        }
    }

    private async checkTypedReplicationReady(
        showMessage: boolean,
        contextOverride?: ActiveReplicatorContext
    ): Promise<ActiveReplicatorContext | ReplicationOutcome> {
        const context = contextOverride ?? this.replicatorService.getActiveReplicatorContext?.();
        if (!context) {
            return this.replicatorService.getActiveReplicator()
                ? replicationBlocked("provider-not-composed")
                : replicationBlocked("no-active-replicator");
        }
        if (!(await this.isReplicationReady(showMessage))) return replicationBlocked("not-ready");
        return context;
    }

    async replicateUserInitiated(
        request: UserInitiatedOneShotRequest = {
            trigger: "manual",
            interaction: USER_INITIATED_REPLICATION_AUTHORITY,
        }
    ): Promise<ReplicationOutcome> {
        const showMessage = request.interaction.kind === "permitted" && request.interaction.permissions.failureRecovery;
        const ready = await this.checkTypedReplicationReady(showMessage);
        if ("status" in ready) return ready;
        const outcome = await this.runUserInitiatedRole(ready, request, showMessage);
        this.previousReplicated = Date.now();
        return outcome;
    }

    async replicateUnattended(request: UnattendedOneShotRequest): Promise<ReplicationOutcome> {
        if (request.interaction.kind !== NO_INTERACTION.kind) {
            return replicationBlocked("interaction-required");
        }
        const ready = await this.checkTypedReplicationReady(false);
        if ("status" in ready) return ready;
        const outcome = await this.runUnattendedRole(ready, request);
        this.previousReplicated = Date.now();
        return outcome;
    }

    replicateUnattendedByEvent(request: UnattendedOneShotRequest): Promise<ReplicationOutcome> {
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
                    return replicationBlocked("rate-limited");
                }
                this.previousReplicated = now + REPLICATION_ON_EVENT_FORECASTED_TIME;
            }
            return await this.replicateUnattended(request);
        });
    }

    async startContinuous(request: ContinuousReplicationRequest): Promise<ReplicationOutcome> {
        if (request.interaction.kind !== NO_INTERACTION.kind) {
            return replicationBlocked("interaction-required");
        }
        const context = this.replicatorService.getActiveReplicatorContext?.();
        if (!context) {
            return this.replicatorService.getActiveReplicator()
                ? replicationBlocked("provider-not-composed")
                : replicationBlocked("no-active-replicator");
        }
        const capability = context.provider.continuous;
        const unsupported = this.capabilityBlocked(capability);
        if (unsupported) return unsupported;
        const ready = await this.checkTypedReplicationReady(false, context);
        if ("status" in ready) return ready;
        return await this.runContinuousRole(ready, request);
    }

    /**
     * Stop finite transfer work on the active provider without entering the
     * replication readiness or activity accounting paths.
     *
     * The provider and replicator are obtained together so that a concurrent
     * replacement cannot pair a capability from one provider with a
     * replicator from another. Stopping is an operator action, not a failed
     * replication, so it does not invoke failure-recovery handlers.
     */
    async stopActiveTransfer(): Promise<ReplicationOutcome> {
        const context = this.replicatorService.getActiveReplicatorContext?.();
        if (!context) {
            return this.replicatorService.getActiveReplicator()
                ? replicationBlocked("provider-not-composed")
                : replicationBlocked("no-active-replicator");
        }

        const capability = context.provider.stopActiveTransfer;
        const blocked = this.capabilityBlocked(capability);
        if (blocked) return blocked;
        if (capability.kind !== "supported") return replicationBlocked("capability-not-implemented");
        try {
            return await capability.run(context.replicator);
        } catch (error) {
            return replicationFailed(error);
        }
    }

    private async performReplicationRequest(showMessage?: boolean): Promise<boolean | void> {
        const activeReplicator = this.replicatorService.getActiveReplicator();
        if (!activeReplicator) {
            this._log(`No active replicator found`, showMessage ? LOG_LEVEL_NOTICE : LOG_LEVEL_INFO);
            return false;
        }
        const settings = this.settingService.currentSettings();
        return await activeReplicator.openReplication(settings, false, !!showMessage, false);
    }

    /**
     * Perform replication and handle a failed result.
     * @param showMessage Whether to show replication progress messages.
     */
    async performReplication(showMessage?: boolean): Promise<boolean | void> {
        const result = await this.performReplicationRequest(showMessage);
        if (!result) {
            return await this.onReplicationFailed(
                showMessage,
                showMessage ? USER_INITIATED_REPLICATION_AUTHORITY : NO_INTERACTION
            );
        }
        return result;
    }

    /**
     * Start the replication process.
     * @param showMessage Whether to show messages to the user.
     */
    async replicate(showMessage?: boolean): Promise<boolean | void> {
        if (this.replicatorService.getActiveReplicatorContext?.()) {
            const outcome = showMessage
                ? await this.replicateUserInitiated()
                : await this.replicateUnattended({
                      trigger: "database-event",
                      interaction: NO_INTERACTION,
                  });
            return outcome.status === "completed";
        }
        try {
            const checkBeforeReplicate = await this.isReplicationReady(showMessage);
            if (!checkBeforeReplicate) return false;
            const result = await this.replicatorService.runFiniteReplicationActivity(
                () => this.performReplicationRequest(showMessage),
                { label: "replication" }
            );
            if (!result) {
                return await this.onReplicationFailed(
                    showMessage,
                    showMessage ? USER_INITIATED_REPLICATION_AUTHORITY : NO_INTERACTION
                );
            }
            return result;
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
        if (this.replicatorService.getActiveReplicatorContext?.()) {
            return this.replicateUnattendedByEvent({
                trigger: "database-event",
                interaction: NO_INTERACTION,
            }).then((outcome) => outcome.status === "completed");
        }
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

    private async performReplicateAllToRemote(showingNotice: boolean): Promise<boolean> {
        if (!(await this.onBeforeReplicate(showingNotice))) {
            this._log(this.context.translate("Replicator.Message.SomeModuleFailed"), LOG_LEVEL_NOTICE);
            return false;
        }
        const currentSettings = this.settingService.currentSettings();
        const activeReplicator = this.getActiveReplicatorFor("sending data to remote");
        if (!activeReplicator) {
            return false;
        }
        const ret = await activeReplicator.replicateAllToServer(currentSettings, showingNotice);
        if (ret) return true;
        const checkResult = await this.checkConnectionFailure();
        if (checkResult == "CHECKAGAIN")
            return await activeReplicator.replicateAllToServer(currentSettings, showingNotice);
        return !checkResult;
    }

    private async performReplicateAllFromRemote(showingNotice: boolean): Promise<boolean> {
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

    async replicateAllToRemote(showingNotice: boolean = false): Promise<boolean> {
        if (!this.appLifecycleService.isReady()) return false;
        return await this.performReplicateAllToRemote(showingNotice);
    }

    async replicateAllFromRemote(showingNotice: boolean = false): Promise<boolean> {
        if (!this.appLifecycleService.isReady()) return false;
        return await this.performReplicateAllFromRemote(showingNotice);
    }

    /**
     * Perform a full upload owned by an active rebuild while the physical database is ready.
     *
     * This concrete maintenance entry point is intentionally absent from `IReplicationService`;
     * it is not a general application-readiness bypass.
     */
    async replicateAllToRemoteForRebuild(showingNotice: boolean = false): Promise<boolean> {
        if (!this.databaseService.isDatabaseReady()) {
            this._log("The selected local database is not ready for the rebuild upload.", LOG_LEVEL_NOTICE);
            return false;
        }
        return await this.performReplicateAllToRemote(showingNotice);
    }

    /**
     * Perform a full download owned by an active rebuild while the physical database is ready.
     *
     * This concrete maintenance entry point is intentionally absent from `IReplicationService`;
     * it is not a general application-readiness bypass.
     */
    async replicateAllFromRemoteForRebuild(showingNotice: boolean = false): Promise<boolean> {
        if (!this.databaseService.isDatabaseReady()) {
            this._log("The selected local database is not ready for the rebuild download.", LOG_LEVEL_NOTICE);
            return false;
        }
        return await this.performReplicateAllFromRemote(showingNotice);
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
