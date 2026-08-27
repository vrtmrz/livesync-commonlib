import type { LiveSyncAbstractReplicator } from "@lib/replication/LiveSyncAbstractReplicator";
import { firstResultFunction, handlers, type MultipleHandlerFunction } from "@lib/services/lib/HandlerUtils";
import type { IReplicatorService, ReplicatorFactoryCallback } from "./IService";
import { ServiceBase, type ServiceContext } from "./ServiceBase";
import type { SettingService } from "./SettingService";
import { createInstanceLogFunction } from "@lib/services/lib/logUtils";
import type { AppLifecycleService } from "./AppLifecycleService";
import { UnresolvedErrorManager } from "./UnresolvedErrorManager";
import { yieldMicrotask } from "octagonal-wheels/promises";
import type { DatabaseEventService } from "./DatabaseEventService";
import { LOG_LEVEL_NOTICE, LOG_LEVEL_VERBOSE } from "@lib/common/logger";
import { DEFAULT_REPLICATION_STATICS } from "@lib/common/models/shared.definition";
import { reactiveSource } from "octagonal-wheels/dataobject/reactive";
import {
    runWithOptionalActivity,
    type AsyncActivityOptions,
    type AsyncActivityRunner,
} from "@lib/interfaces/AsyncActivityRunner.ts";
import type {
    ActiveReplicatorContext,
    ReplicatorProviderDefinition,
    ReplicatorProviderDefinitionMap,
} from "@lib/replication/ReplicatorProvider.ts";
import type { ObsidianLiveSyncSettings } from "@lib/common/types.ts";

export interface ReplicatorServiceDependencies {
    settingService: SettingService;
    appLifecycleService: AppLifecycleService;
    databaseEventService: DatabaseEventService;
    activityRunner?: AsyncActivityRunner;
    registerLifecycleHandlers?: boolean;
}
/**
 * The ReplicatorService provides methods for managing replication.
 */
export abstract class ReplicatorService<T extends ServiceContext = ServiceContext>
    extends ServiceBase<T>
    implements IReplicatorService
{
    readonly boundedRemoteActivityCount = reactiveSource(0);
    readonly finiteReplicationActivityCount = reactiveSource(0);
    _log = createInstanceLogFunction("ReplicatorService");

    private settingService: SettingService;
    private databaseEventService: DatabaseEventService;
    private _activeReplicator: LiveSyncAbstractReplicator | undefined;
    private _replicatorType: string | undefined;
    private _activeReplicatorContext: ActiveReplicatorContext | undefined;
    private _providerDefinitions = new Map<ReplicatorProviderDefinition["kind"], ReplicatorProviderDefinition>();
    private _transition: Promise<unknown> = Promise.resolve();
    private appLifecycleService: AppLifecycleService;
    _unresolvedErrorManager: UnresolvedErrorManager;
    constructor(
        context: T,
        protected dependencies: ReplicatorServiceDependencies
    ) {
        super(context);
        this.appLifecycleService = dependencies.appLifecycleService;
        this._unresolvedErrorManager = new UnresolvedErrorManager(
            dependencies.appLifecycleService,
            this.context.events
        );
        this.settingService = dependencies.settingService;
        this.databaseEventService = dependencies.databaseEventService;
        if (dependencies.registerLifecycleHandlers ?? true) {
            this.settingService.onRealiseSetting.addHandler(this._initialiseReplicator.bind(this));
            this.databaseEventService.onResetDatabase.addHandler(this.disposeReplicator.bind(this));
            this.databaseEventService.onDatabaseInitialisation.addHandler(this.disposeReplicator.bind(this));
            this.databaseEventService.onDatabaseInitialised.addHandler(this.reinitialiseReplicator.bind(this));
            this.databaseEventService.onDatabaseHasReady.addHandler(this.reinitialiseReplicator.bind(this));
            this.appLifecycleService.onSuspending.addHandler(this.suspendReplication.bind(this));
        }
    }

    /**
     * Runs one finite remote operation while exposing its lifetime to host policy and status UI.
     * Continuous replication must not use this boundary.
     */
    async runBoundedRemoteActivity<TValue>(
        task: () => TValue | PromiseLike<TValue>,
        options?: AsyncActivityOptions
    ): Promise<TValue> {
        return await this.runRemoteActivity(task, options, false);
    }

    /** Runs one finite replication and exposes its document-delivery lifetime. */
    async runFiniteReplicationActivity<TValue>(
        task: () => TValue | PromiseLike<TValue>,
        options?: AsyncActivityOptions
    ): Promise<TValue> {
        return await this.runRemoteActivity(task, options, true);
    }

    private async runRemoteActivity<TValue>(
        task: () => TValue | PromiseLike<TValue>,
        options: AsyncActivityOptions | undefined,
        isFiniteReplication: boolean
    ): Promise<TValue> {
        this.boundedRemoteActivityCount.value++;
        if (isFiniteReplication) {
            this.finiteReplicationActivityCount.value++;
        }
        try {
            return await runWithOptionalActivity(this.dependencies.activityRunner, task, options);
        } finally {
            if (isFiniteReplication) {
                this.finiteReplicationActivityCount.value--;
            }
            this.boundedRemoteActivityCount.value--;
        }
    }

    private suspendReplication() {
        // During early lifecycle (e.g. settings migration), suspension can happen before
        // replicator initialisation. Avoid emitting unresolved-error noise in that case.
        const activeReplicator = this._activeReplicator;
        if (activeReplicator) {
            activeReplicator.closeReplication();
        }
        return Promise.resolve(true);
    }

    private async reinitialiseReplicator() {
        return await this.enqueueTransition(async () => {
            await this.disposeReplicatorNow();
            await yieldMicrotask();
            return await this.initialiseReplicatorNow();
        });
    }
    private async disposeReplicator() {
        return await this.enqueueTransition(() => this.disposeReplicatorNow());
    }
    private async disposeReplicatorNow(reason: "database reset" | "configuration transition" = "database reset") {
        this._log(
            reason === "database reset"
                ? "Detect database reset, closing active replicator if exists."
                : "Configuration changed, closing active replicator if exists."
        );
        const activeReplicator = this._activeReplicator;
        this._activeReplicator = undefined;
        this._replicatorType = undefined;
        this._activeReplicatorContext = undefined;
        if (activeReplicator) {
            await Promise.resolve(activeReplicator.closeReplication());
        }
        // To flush e2ee salts, device id, and other information kept in the replicator instance, to avoid potential database corruption after reset.
        return true;
    }

    private async discardFailedReplicator(replicator: LiveSyncAbstractReplicator): Promise<void> {
        if (this._activeReplicator === replicator) {
            this._activeReplicator = undefined;
            this._replicatorType = undefined;
            this._activeReplicatorContext = undefined;
        }
        try {
            await Promise.resolve(replicator.closeReplication());
        } catch (error) {
            this._log("Failed to close a replicator after its initialisation failed.", LOG_LEVEL_VERBOSE);
            this._log(error, LOG_LEVEL_VERBOSE);
        }
    }

    private enqueueTransition<TResult>(operation: () => Promise<TResult>): Promise<TResult> {
        const transition = this._transition.then(operation, operation);
        this._transition = transition.then(
            (): undefined => undefined,
            (): undefined => undefined
        );
        return transition;
    }

    private async _initialiseReplicator() {
        return await this.enqueueTransition(() => this.initialiseReplicatorNow());
    }

    private getProviderDefinition(setting: { remoteType: string }): ReplicatorProviderDefinition | undefined {
        return this._providerDefinitions.get(setting.remoteType as ReplicatorProviderDefinition["kind"]);
    }

    private async createReplicator(
        settingOverride: Partial<ObsidianLiveSyncSettings> = {}
    ): Promise<LiveSyncAbstractReplicator | undefined | false> {
        const currentSettings = this.settingService.currentSettings();
        const setting = { ...currentSettings, ...settingOverride };
        const provider = this.getProviderDefinition(setting);
        if (provider) {
            return await provider.create(setting);
        }
        return await this.legacyGetNewReplicator(settingOverride);
    }

    private async initialiseReplicatorNow() {
        const message = this.context.translate("Replicator.Message.InitialiseFatalError");
        const setting = this.settingService.currentSettings();
        if (!setting) {
            this._activeReplicator = undefined;
            this._replicatorType = undefined;
            this._activeReplicatorContext = undefined;
            // Settings may not be available yet during early lifecycle.
            // Do not treat this as a fatal initialisation failure.
            this._unresolvedErrorManager.clearError(message);
            return true;
        }
        const replicatorType = setting.remoteType;
        const provider = this.getProviderDefinition(setting);
        const hasReplicatorConfig = provider ? provider.isConfigured(setting) : this._providerDefinitions.size === 0;

        if (!hasReplicatorConfig) {
            // Configuration changes are transitions too: fence and close an old
            // transport before forgetting it, rather than orphaning its listeners.
            await this.disposeReplicatorNow("configuration transition");
            this._unresolvedErrorManager.clearError(message);
            this._log("No remote replicator configuration found. Skipping replicator initialisation.");
            return true;
        }

        if (
            replicatorType === this._replicatorType &&
            this._activeReplicator &&
            (!provider || this._activeReplicatorContext?.provider === provider)
        ) {
            // No need to change the replicator.
            this._unresolvedErrorManager.clearError(message);
            this._log("Active replicator has been kept", LOG_LEVEL_VERBOSE);
            return true;
        } else {
            this._log("Acquiring new replicator");
            // Check existing replicator and close it if exists.
            const previousReplicator = this._activeReplicator;
            this._activeReplicator = undefined;
            this._activeReplicatorContext = undefined;
            this._replicatorType = undefined;
            if (previousReplicator) {
                await Promise.resolve(previousReplicator.closeReplication());
                this._log("Active replicator closed", LOG_LEVEL_VERBOSE);
            }
            const newReplicator = await this.createReplicator();
            if (!newReplicator) {
                this._unresolvedErrorManager.showError(message, LOG_LEVEL_NOTICE);
                return false;
            }

            // Reset replication statics when replicator changes.
            this.replicationStatics.value = { ...DEFAULT_REPLICATION_STATICS };
            await yieldMicrotask();
            // Probably we need to clear all synchronising parameters handlers
            // Note that parameters handler keeps an key-deriving salt in memory,
            // so we need to clear them when the replicator changes, to avoid potential database corruption.
            try {
                if (!(await newReplicator.initializeDatabaseForReplication())) {
                    this._log("Failed to initialise the replicator's local node information.");
                    await this.discardFailedReplicator(newReplicator);
                    this._unresolvedErrorManager.showError(message, LOG_LEVEL_NOTICE);
                    return false;
                }
                if (!(await this.onReplicatorInitialised())) {
                    this._log("Failed to initialise the replicator, onReplicatorInitialised reported some problems.");
                    await this.discardFailedReplicator(newReplicator);
                    this._unresolvedErrorManager.showError(message, LOG_LEVEL_NOTICE);
                    return false;
                }
            } catch (error) {
                await this.discardFailedReplicator(newReplicator);
                this._unresolvedErrorManager.showError(message, LOG_LEVEL_NOTICE);
                throw error;
            }
            const activeProvider = provider ?? this.getProviderDefinition(setting);
            if (activeProvider) {
                this._activeReplicatorContext = { provider: activeProvider, replicator: newReplicator };
            }
            this._activeReplicator = newReplicator;
            this._replicatorType = replicatorType;
            const remoteTypeDisplay = provider?.diagnosticName ?? (replicatorType || "CouchDB");
            this._log(`Replicator (${remoteTypeDisplay}) initialised and activated`, LOG_LEVEL_VERBOSE);

            this._unresolvedErrorManager.clearError(message);
            return true;
        }
    }

    /**
     * Close the active replication if any.
     * Not used currently.
     */
    readonly onCloseActiveReplication = handlers<IReplicatorService>().anySuccess("onCloseActiveReplication");

    /**
     * Get a new replicator instance based on the provided settings.
     */
    private readonly legacyGetNewReplicator = firstResultFunction<ReplicatorFactoryCallback>("getNewReplicator");

    readonly getNewReplicator: MultipleHandlerFunction<ReplicatorFactoryCallback> = Object.assign(
        async (settingOverride: Partial<ObsidianLiveSyncSettings> = {}) => await this.createReplicator(settingOverride),
        {
            addHandler: (callback: ReplicatorFactoryCallback) => this.legacyGetNewReplicator.addHandler(callback),
            removeHandler: (callback: ReplicatorFactoryCallback) => this.legacyGetNewReplicator.removeHandler(callback),
        }
    );

    registerReplicatorProviderDefinitions(definitions: ReplicatorProviderDefinitionMap): void {
        for (const [kind, definition] of definitions) {
            const existing = this._providerDefinitions.get(kind);
            if (existing && existing !== definition) {
                throw new Error(`Replicator provider '${kind}' is already composed.`);
            }
            this._providerDefinitions.set(kind, definition);
        }
    }

    getActiveReplicatorContext(): ActiveReplicatorContext | undefined {
        return this._activeReplicatorContext;
    }

    readonly onReplicatorInitialised = handlers<IReplicatorService>().bailFirstFailure("onReplicatorInitialised");

    /**
     * Get the currently active replicator instance.
     * If no active replicator, return undefined but that is the fatal situation (on Obsidian).
     */
    getActiveReplicator(): LiveSyncAbstractReplicator | undefined {
        const message = "No replicator has been activated or has not been initialised yet.";
        const activeReplicator = this._activeReplicatorContext?.replicator ?? this._activeReplicator;
        if (!activeReplicator) {
            this._unresolvedErrorManager.showError(message, LOG_LEVEL_NOTICE);
            return undefined;
        }
        this._unresolvedErrorManager.clearError(message);
        return activeReplicator;
    }

    replicationStatics = reactiveSource({ ...DEFAULT_REPLICATION_STATICS });
}
