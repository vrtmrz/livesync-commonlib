import {
    LOG_LEVEL_INFO,
    LOG_LEVEL_NOTICE,
    LOG_LEVEL_VERBOSE,
    type LOG_LEVEL,
    type ObsidianLiveSyncSettings,
    type RemoteDBSettings,
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
import { createInstanceLogFunction, type LogFunction } from "@lib/services/lib/logUtils";
import {
    CAPABILITY_SUPPORT_KINDS,
    NO_INTERACTION,
    CENTRAL_REMOTE_REPLICATION_READINESS,
    USER_INITIATED_REPLICATION_AUTHORITY,
    isActiveReplicatorContextBoundToSetting,
    isReplicationCompleted,
    replicationBlocked,
    replicationFailed,
    outcomeFromFiniteOpenReplication,
    type ActiveReplicatorContext,
    type ContinuousReplicationRequest,
    type ReplicationAttemptFailure,
    type ReplicationOutcome,
    type ReplicationReadinessRequirements,
    type UnattendedOneShotRequest,
    type UserInitiatedOneShotRequest,
} from "@lib/replication/ReplicatorProvider.ts";
import type { ReplicatorInstance } from "@lib/replication/ReplicatorInstance.ts";
import { UnresolvedErrorManager } from "./UnresolvedErrorManager";
import type { AppLifecycleService } from "./AppLifecycleService";
import { isLockAcquired, shareRunningResult } from "octagonal-wheels/concurrency/lock";
import {
    createReplicationReadinessEvaluator,
    type ReplicationReadinessEvaluator,
} from "./ReplicationService.readiness.ts";
import { TypedReplicationCoordinator } from "./ReplicationService.typedReplication.ts";
import { asCopy } from "@lib/common/utils.object.ts";

/**
 * Event-triggered replication interval forecasted time.
 */
const REPLICATION_ON_EVENT_FORECASTED_TIME = 5000;

const DIRECTIONAL_REPLICATION = Object.freeze({
    UPLOAD: "upload",
    DOWNLOAD: "download",
} as const);

type DirectionalReplication = (typeof DIRECTIONAL_REPLICATION)[keyof typeof DIRECTIONAL_REPLICATION];

const DIRECTIONAL_REPLICATION_ADMISSION = Object.freeze({
    ORDINARY: "ordinary",
    EXPLICIT_REBUILD: "explicit-rebuild",
} as const);

type DirectionalReplicationAdmission =
    (typeof DIRECTIONAL_REPLICATION_ADMISSION)[keyof typeof DIRECTIONAL_REPLICATION_ADMISSION];

interface DirectionalReplicationAdapter extends ReplicatorInstance {
    replicateAllToServer?(setting: RemoteDBSettings, showingNotice?: boolean): Promise<boolean>;
    replicateAllFromServer?(setting: RemoteDBSettings, showingNotice?: boolean): Promise<boolean>;
    replicateAllToServerWithOutcome?(setting: RemoteDBSettings, showingNotice?: boolean): Promise<ReplicationOutcome>;
    replicateAllFromServerWithOutcome?(setting: RemoteDBSettings, showingNotice?: boolean): Promise<ReplicationOutcome>;
}

interface LegacyCentralRemoteAdministrationAdapter extends ReplicatorInstance {
    markRemoteLocked(setting: RemoteDBSettings, locked: boolean, lockByClean: boolean): Promise<void>;
    markRemoteResolved(setting: RemoteDBSettings): Promise<void>;
}

function canUploadAll(replicator: ReplicatorInstance): replicator is DirectionalReplicationAdapter & {
    replicateAllToServer(setting: RemoteDBSettings, showingNotice?: boolean): Promise<boolean>;
} {
    return "replicateAllToServer" in replicator && typeof replicator.replicateAllToServer === "function";
}

function canUploadAllWithOutcome(replicator: ReplicatorInstance): replicator is DirectionalReplicationAdapter & {
    replicateAllToServerWithOutcome(setting: RemoteDBSettings, showingNotice?: boolean): Promise<ReplicationOutcome>;
} {
    return (
        "replicateAllToServerWithOutcome" in replicator &&
        typeof replicator.replicateAllToServerWithOutcome === "function"
    );
}

function canDownloadAll(replicator: ReplicatorInstance): replicator is DirectionalReplicationAdapter & {
    replicateAllFromServer(setting: RemoteDBSettings, showingNotice?: boolean): Promise<boolean>;
} {
    return "replicateAllFromServer" in replicator && typeof replicator.replicateAllFromServer === "function";
}

function canDownloadAllWithOutcome(replicator: ReplicatorInstance): replicator is DirectionalReplicationAdapter & {
    replicateAllFromServerWithOutcome(setting: RemoteDBSettings, showingNotice?: boolean): Promise<ReplicationOutcome>;
} {
    return (
        "replicateAllFromServerWithOutcome" in replicator &&
        typeof replicator.replicateAllFromServerWithOutcome === "function"
    );
}

function canAdministerLegacyCentralRemote(
    replicator: ReplicatorInstance
): replicator is LegacyCentralRemoteAdministrationAdapter {
    return (
        "markRemoteLocked" in replicator &&
        typeof replicator.markRemoteLocked === "function" &&
        "markRemoteResolved" in replicator &&
        typeof replicator.markRemoteResolved === "function"
    );
}

/** Request and await cooperative stop of the admitted publication's active transfer before a directional operation. */
async function stopActiveTransferForDirectionalReplication(
    context: ActiveReplicatorContext
): Promise<ReplicationOutcome> {
    const capability = context.provider.stopActiveTransfer;
    if (capability.kind !== CAPABILITY_SUPPORT_KINDS.SUPPORTED) {
        return replicationBlocked(capability.reason);
    }
    try {
        const outcome = await capability.run(context.replicator);
        // A failed stop is not a failed remote transfer and must not enter the
        // compatibility-retry path. Report it as unavailable for this attempt.
        return outcome.status === "failed" ? replicationBlocked("not-ready") : outcome;
    } catch {
        return replicationBlocked("not-ready");
    }
}

async function runDirectionalReplication(
    context: ActiveReplicatorContext,
    setting: RemoteDBSettings,
    direction: DirectionalReplication,
    showingNotice: boolean
): Promise<ReplicationOutcome> {
    if (!isActiveReplicatorContextBoundToSetting(context, setting)) {
        return replicationBlocked("not-ready");
    }
    const stopOutcome = await stopActiveTransferForDirectionalReplication(context);
    if (!isReplicationCompleted(stopOutcome)) return stopOutcome;

    try {
        let result: boolean | void;
        if (direction === DIRECTIONAL_REPLICATION.UPLOAD) {
            if (canUploadAllWithOutcome(context.replicator)) {
                return await context.replicator.replicateAllToServerWithOutcome(setting, showingNotice);
            }
            if (!canUploadAll(context.replicator)) return replicationBlocked("capability-not-applicable");
            result = await context.replicator.replicateAllToServer(setting, showingNotice);
        } else {
            if (canDownloadAllWithOutcome(context.replicator)) {
                return await context.replicator.replicateAllFromServerWithOutcome(setting, showingNotice);
            }
            if (!canDownloadAll(context.replicator)) return replicationBlocked("capability-not-applicable");
            result = await context.replicator.replicateAllFromServer(setting, showingNotice);
        }
        return outcomeFromFiniteOpenReplication(result);
    } catch (error) {
        return replicationFailed(error);
    }
}

export interface ReplicationServiceDependencies {
    APIService: IAPIService;
    settingService: ISettingService;
    appLifecycleService: AppLifecycleService;
    databaseService: IDatabaseService;
    replicatorService: IReplicatorService;
    fileProcessingService: IFileProcessingService;
}
/**
 * Host-facing replication façade for handlers, legacy entry points, and counters.
 *
 * Ordered readiness evaluation and typed capability dispatch are delegated to
 * focused collaborators. Handler objects remain on this service so existing
 * hosts retain their registration identity, priority ordering, and failure
 * semantics. Active Replicator ownership remains with `ReplicatorService`.
 */
export abstract class ReplicationService<T extends ServiceContext = ServiceContext>
    extends ServiceBase<T>
    implements IReplicationService
{
    private _unresolvedErrorManager: UnresolvedErrorManager;
    private readonly _evaluateReadiness: ReplicationReadinessEvaluator;
    private readonly _typedReplication: TypedReplicationCoordinator;

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
        this._evaluateReadiness = createReplicationReadinessEvaluator({
            gates: {
                isApplicationReady: () => this.appLifecycleService.isReady(),
                runPolicyChecks: (showMessage) => this.onCheckReplicationReady(showMessage),
                currentSettings: () => this.settingService.currentSettings(),
                isCleanupRunning: () => isLockAcquired("cleanup"),
                isOnline: () => this.APIService.isOnline,
            },
            preparation: {
                commitPendingFileEvents: () => this.fileProcessing.commitPendingFileEvents(),
                prepareCentralRemote: (showMessage) => this.onPrepareCentralRemoteReplication(showMessage),
                runBeforeReplicate: (showMessage) => this.onBeforeReplicate(showMessage),
            },
            diagnostics: {
                getUnresolvedMessages: () => this.appLifecycleService.getUnresolvedMessages(),
                translate: (key) => this.context.translate(key),
                log: this._log,
                showError: (message, maxLogLevel) => this.showError(message, maxLogLevel),
                clearErrors: () => this.clearErrors(),
            },
        });
        this._typedReplication = new TypedReplicationCoordinator({
            replicatorService: this.replicatorService,
            currentSettings: () => this.settingService.currentSettings(),
            checkReadiness: (showMessage, readiness) => this.isReplicationReady(showMessage, readiness),
            handleFailure: (request) => this.onReplicationFailed(request),
            recordFiniteAttempt: () => {
                this.previousReplicated = Date.now();
            },
        });
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

    /** Provider preparation which applies only to the central remote. */
    readonly onPrepareCentralRemoteReplication = handlers<IReplicationService>().bailFirstFailure(
        "onPrepareCentralRemoteReplication"
    );

    /**
     * Lightweight, repeatable policy checks shared by every replication entry point.
     * Handlers must remain idempotent because a high-level replication may cross
     * more than one entry point before work begins.
     */
    readonly onCheckReplicationReady = handlers<IReplicationService>().bailFirstFailure("onCheckReplicationReady");

    /**
     * Evaluate the ordered readiness conditions for an operation.
     *
     * This method does not acquire a Replicator or begin activity accounting.
     * Provider requirements select whether central-remote preparation applies.
     *
     * @param showMessage Whether condition-specific diagnostics may be prominent.
     * @param readiness Provider-owned preparation requirements.
     */
    async isReplicationReady(
        showMessage: boolean = false,
        readiness: ReplicationReadinessRequirements = CENTRAL_REMOTE_REPLICATION_READINESS
    ): Promise<boolean> {
        return (await this._evaluateReadiness({ showMessage, requirements: readiness })).ready;
    }

    onReplicationFailed = handlers<IReplicationService>().bailFirstFailure("onReplicationFailed");

    async replicateUserInitiated(
        request: UserInitiatedOneShotRequest = {
            trigger: "manual",
            interaction: USER_INITIATED_REPLICATION_AUTHORITY,
        }
    ): Promise<ReplicationOutcome> {
        return await this._typedReplication.runUserInitiated(request);
    }

    async replicateUnattended(request: UnattendedOneShotRequest): Promise<ReplicationOutcome> {
        return await this._typedReplication.runUnattended(request);
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
        return await this._typedReplication.startContinuous(request);
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
        return await this._typedReplication.stopActiveTransfer();
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
            return false;
        }
        return result;
    }

    /**
     * Start the replication process.
     * @param showMessage Whether to show messages to the user.
     */
    async replicate(showMessage?: boolean): Promise<boolean | void> {
        if (await this.replicatorService.acquireActiveReplicatorContext()) {
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
                return false;
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
    async replicateByEvent(showMessage?: boolean): Promise<boolean | void> {
        if (await this.replicatorService.acquireActiveReplicatorContext()) {
            return await this.replicateUnattendedByEvent({
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

    /**
     * Dispatch one directional full transfer through one admitted publication.
     *
     * Each attempt owns a separate reservation. Compatibility recovery runs
     * between those reservations, and a retry is admitted only when the exact
     * first-attempt context remains active. Both attempts use one detached
     * settings snapshot.
     */
    private async performDirectionalReplication(
        direction: DirectionalReplication,
        showingNotice: boolean,
        admission: DirectionalReplicationAdmission = DIRECTIONAL_REPLICATION_ADMISSION.ORDINARY
    ): Promise<boolean> {
        if (direction === DIRECTIONAL_REPLICATION.UPLOAD && !(await this.onBeforeReplicate(showingNotice))) {
            this._log(this.context.translate("Replicator.Message.SomeModuleFailed"), LOG_LEVEL_NOTICE);
            return false;
        }
        const detachedSetting = asCopy(this.settingService.currentSettings());
        if (admission === DIRECTIONAL_REPLICATION_ADMISSION.EXPLICIT_REBUILD) {
            // The confirmed recovery may run while ordinary replication stays
            // paused. Authorise only this detached attempt; persistence and
            // explicit compatibility acknowledgement remain unchanged.
            detachedSetting.versionUpFlash = "";
        }
        const setting = Object.freeze(detachedSetting);
        let expectedContext: ActiveReplicatorContext | undefined;
        const run = async (): Promise<ReplicationOutcome> => {
            const admitted = await this.replicatorService.runWithActiveReplicatorContext((context) => {
                if (expectedContext && context !== expectedContext) {
                    return replicationBlocked("not-ready");
                }
                expectedContext ??= context;
                return runDirectionalReplication(context, setting, direction, showingNotice);
            });
            if (admitted) return admitted;
            this._log(`Active replicator not found during directional ${direction}`, LOG_LEVEL_NOTICE);
            return replicationBlocked("no-active-replicator");
        };
        const outcome = await run();
        if (isReplicationCompleted(outcome)) return true;
        if (outcome.status !== "failed") return false;

        const failedContext = expectedContext;
        if (!failedContext) return false;
        const failure = Object.freeze({ context: failedContext, setting, outcome }) satisfies ReplicationAttemptFailure;
        const checkResult = await this.checkConnectionFailure(failure);
        return checkResult === "CHECKAGAIN" && isReplicationCompleted(await run());
    }

    async replicateAllToRemote(showingNotice: boolean = false): Promise<boolean> {
        if (!this.appLifecycleService.isReady()) return false;
        return await this.performDirectionalReplication(DIRECTIONAL_REPLICATION.UPLOAD, showingNotice);
    }

    async replicateAllFromRemote(showingNotice: boolean = false): Promise<boolean> {
        if (!this.appLifecycleService.isReady()) return false;
        return await this.performDirectionalReplication(DIRECTIONAL_REPLICATION.DOWNLOAD, showingNotice);
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
        return await this.performDirectionalReplication(
            DIRECTIONAL_REPLICATION.UPLOAD,
            showingNotice,
            DIRECTIONAL_REPLICATION_ADMISSION.EXPLICIT_REBUILD
        );
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
        return await this.performDirectionalReplication(
            DIRECTIONAL_REPLICATION.DOWNLOAD,
            showingNotice,
            DIRECTIONAL_REPLICATION_ADMISSION.EXPLICIT_REBUILD
        );
    }

    private getActiveReplicatorFor(usage: string) {
        const activeReplicator = this.replicatorService.getActiveReplicator();
        if (!activeReplicator) {
            this._log(`Active replicator not found during ${usage}`, LOG_LEVEL_NOTICE);
            return false;
        }
        return activeReplicator;
    }

    private _getReplicatorAndPerform(
        action: string,
        perform: (
            setting: ObsidianLiveSyncSettings,
            replicator: LegacyCentralRemoteAdministrationAdapter
        ) => Promise<void>
    ) {
        const activeReplicator = this.getActiveReplicatorFor(action);
        if (!activeReplicator) return Promise.resolve();
        if (!canAdministerLegacyCentralRemote(activeReplicator)) {
            this._log(`Active replicator does not support ${action}`, LOG_LEVEL_NOTICE);
            return Promise.resolve();
        }
        return perform(this.settingService.currentSettings(), activeReplicator);
    }

    async markLocked(lockByClean: boolean = false): Promise<void> {
        return await this._getReplicatorAndPerform(
            "marking remote locked",
            async (currentSettings, activeReplicator) =>
                await activeReplicator.markRemoteLocked(currentSettings, true, lockByClean)
        );
    }

    async markUnlocked(): Promise<void> {
        return await this._getReplicatorAndPerform(
            "marking remote unlocked",
            async (currentSettings, activeReplicator) =>
                await activeReplicator.markRemoteLocked(currentSettings, false, false)
        );
    }

    async markResolved(): Promise<void> {
        return await this._getReplicatorAndPerform(
            "marking remote resolved",
            async (currentSettings, activeReplicator) => await activeReplicator.markRemoteResolved(currentSettings)
        );
    }
}
