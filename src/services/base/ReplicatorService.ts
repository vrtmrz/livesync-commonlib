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
import type { ObsidianLiveSyncSettings, RemoteDBSettings } from "@lib/common/types.ts";
import { ActiveReplicatorState } from "./ActiveReplicatorState.ts";
import type { RemoteResourceKind, RemoteResourceMap } from "@lib/replication/RemoteResource.ts";
import { resolveRemoteResource } from "./RemoteResourceResolver.ts";
import type { RemoteAdministrationRequest, RemoteAdministrationResult } from "@lib/replication/RemoteAdministration.ts";
import { runRemoteAdministrationWithContext } from "./RemoteAdministrationCoordinator.ts";

export interface ReplicatorServiceDependencies {
    settingService: SettingService;
    appLifecycleService: AppLifecycleService;
    databaseEventService: DatabaseEventService;
    activityRunner?: AsyncActivityRunner;
    registerLifecycleHandlers?: boolean;
}
/**
 * Own the active Replicator publication and its serialised lifecycle transitions.
 *
 * This service composes provider definitions, retires or reconciles active
 * instances when their configuration identity changes, and publishes the
 * provider and Replicator atomically. It does not select provider capabilities
 * for individual replication requests; `ReplicationService` owns that dispatch.
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
    private readonly _activeReplicatorState = new ActiveReplicatorState();
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
        const activeReplicator = this._activeReplicatorState.current?.replicator;
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
        const activeReplicator = this._activeReplicatorState.take();
        if (activeReplicator) {
            await Promise.resolve(activeReplicator.closeReplication());
        }
        // To flush e2ee salts, device id, and other information kept in the replicator instance, to avoid potential database corruption after reset.
        return true;
    }

    private async discardFailedReplicator(replicator: LiveSyncAbstractReplicator): Promise<void> {
        this._activeReplicatorState.discardIfCurrent(replicator);
        try {
            await Promise.resolve(replicator.closeReplication());
        } catch (error) {
            this._log("Failed to close a replicator after its initialisation failed.", LOG_LEVEL_VERBOSE);
            this._log(error, LOG_LEVEL_VERBOSE);
        }
    }

    private enqueueTransition<TResult>(operation: () => Promise<TResult>): Promise<TResult> {
        // A failed transition must not poison the queue. Later lifecycle events
        // still need an ordered opportunity to retire or construct an owner.
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
        return await this.createReplicatorForSetting(setting, settingOverride);
    }

    private async createReplicatorForSetting(
        setting: ObsidianLiveSyncSettings,
        legacySettingOverride: Partial<ObsidianLiveSyncSettings> = {}
    ): Promise<LiveSyncAbstractReplicator | undefined | false> {
        const provider = this.getProviderDefinition(setting);
        if (provider) {
            return await provider.create(setting);
        }
        return await this.legacyGetNewReplicator(legacySettingOverride);
    }

    private isCurrentProviderConfiguration(
        provider: ReplicatorProviderDefinition,
        configurationIdentity: string
    ): boolean {
        // Re-read effective settings at the publication boundary. Candidate
        // construction and host preparation may both have yielded meanwhile.
        const currentSetting = this.settingService.currentSettings();
        return (
            !!currentSetting &&
            this.getProviderDefinition(currentSetting) === provider &&
            provider.isConfigured(currentSetting) &&
            provider.configurationIdentity(currentSetting) === configurationIdentity
        );
    }

    private clearActiveReplicator(): LiveSyncAbstractReplicator | undefined {
        return this._activeReplicatorState.take();
    }

    private publishActiveReplicator(
        provider: ReplicatorProviderDefinition | undefined,
        replicator: LiveSyncAbstractReplicator,
        replicatorType: string,
        configurationIdentity: string | undefined
    ): void {
        this._activeReplicatorState.publish(provider, replicator, replicatorType, configurationIdentity);
    }

    private async rebindActiveReplicator(
        provider: ReplicatorProviderDefinition,
        replicator: LiveSyncAbstractReplicator,
        setting: ObsidianLiveSyncSettings,
        configurationIdentity: string,
        message: string
    ): Promise<boolean> {
        // Fence synchronous readers before provider-owned state begins changing.
        // Transition-aware acquisition continues waiting on the queue.
        this.clearActiveReplicator();
        try {
            const reconciliation = provider.sameKindReconciliation;
            if (reconciliation.kind !== "rebind") {
                throw new Error("A replace-only provider cannot rebind its active Replicator.");
            }
            await reconciliation.rebind(replicator, setting);
            if (!(await this.onBeforeReplicatorPublication())) {
                this._log(
                    "Failed to initialise the rebound replicator, onBeforeReplicatorPublication reported some problems."
                );
                await this.discardFailedReplicator(replicator);
                this._unresolvedErrorManager.showError(message, LOG_LEVEL_NOTICE);
                return false;
            }
            if (!this.isCurrentProviderConfiguration(provider, configurationIdentity)) {
                await this.discardFailedReplicator(replicator);
                this._unresolvedErrorManager.clearError(message);
                this._log(
                    "Discarded a rebound replicator whose configuration changed before publication.",
                    LOG_LEVEL_VERBOSE
                );
                return true;
            }
            this.replicationStatics.value = { ...DEFAULT_REPLICATION_STATICS };
            this.publishActiveReplicator(provider, replicator, provider.kind, configurationIdentity);
            this._unresolvedErrorManager.clearError(message);
            this._log(`Replicator (${provider.diagnosticName}) rebound and activated`, LOG_LEVEL_VERBOSE);
            return true;
        } catch (error) {
            await this.discardFailedReplicator(replicator);
            this._unresolvedErrorManager.showError(message, LOG_LEVEL_NOTICE);
            throw error;
        }
    }

    private async initialiseReplicatorNow() {
        const message = this.context.translate("Replicator.Message.InitialiseFatalError");
        const setting = this.settingService.currentSettings();
        if (!setting) {
            this.clearActiveReplicator();
            // Settings may not be available yet during early lifecycle.
            // Do not treat this as a fatal initialisation failure.
            this._unresolvedErrorManager.clearError(message);
            return true;
        }
        const replicatorType = setting.remoteType;
        const provider = this.getProviderDefinition(setting);
        let hasReplicatorConfig: boolean;
        let configurationIdentity: string | undefined;
        try {
            hasReplicatorConfig = provider ? provider.isConfigured(setting) : this._providerDefinitions.size === 0;
            configurationIdentity =
                provider && hasReplicatorConfig ? provider.configurationIdentity(setting) : undefined;
        } catch (error) {
            await this.disposeReplicatorNow("configuration transition");
            this._unresolvedErrorManager.showError(message, LOG_LEVEL_NOTICE);
            throw error;
        }

        if (!hasReplicatorConfig) {
            // Configuration changes are transitions too: fence and close an old
            // transport before forgetting it, rather than orphaning its listeners.
            await this.disposeReplicatorNow("configuration transition");
            this._unresolvedErrorManager.clearError(message);
            this._log("No remote replicator configuration found. Skipping replicator initialisation.");
            return true;
        }

        const activePublication = this._activeReplicatorState.current;
        const isSameProvider =
            replicatorType === activePublication?.replicatorType &&
            (!provider || activePublication.context?.provider === provider);
        if (isSameProvider && (!provider || configurationIdentity === activePublication?.configurationIdentity)) {
            // No need to change the replicator.
            this._unresolvedErrorManager.clearError(message);
            this._log("Active replicator has been kept", LOG_LEVEL_VERBOSE);
            return true;
        } else if (
            isSameProvider &&
            provider &&
            provider.sameKindReconciliation.kind === "rebind" &&
            activePublication
        ) {
            return await this.rebindActiveReplicator(
                provider,
                activePublication.replicator,
                setting,
                configurationIdentity!,
                message
            );
        } else {
            this._log("Acquiring new replicator");
            // Check existing replicator and close it if exists.
            const previousReplicator = this.clearActiveReplicator();
            if (previousReplicator) {
                await Promise.resolve(previousReplicator.closeReplication());
                this._log("Active replicator closed", LOG_LEVEL_VERBOSE);
            }
            const newReplicator = await this.createReplicatorForSetting(setting);
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
                if (!(await this.onBeforeReplicatorPublication())) {
                    this._log(
                        "Failed to initialise the replicator, onBeforeReplicatorPublication reported some problems."
                    );
                    await this.discardFailedReplicator(newReplicator);
                    this._unresolvedErrorManager.showError(message, LOG_LEVEL_NOTICE);
                    return false;
                }
                if (provider && !this.isCurrentProviderConfiguration(provider, configurationIdentity!)) {
                    await this.discardFailedReplicator(newReplicator);
                    this._unresolvedErrorManager.clearError(message);
                    this._log(
                        "Discarded a replicator whose configuration changed before publication.",
                        LOG_LEVEL_VERBOSE
                    );
                    return true;
                }
            } catch (error) {
                await this.discardFailedReplicator(newReplicator);
                this._unresolvedErrorManager.showError(message, LOG_LEVEL_NOTICE);
                throw error;
            }
            this.publishActiveReplicator(provider, newReplicator, replicatorType, configurationIdentity);
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
        return this._activeReplicatorState.current?.context;
    }

    async createRemoteResource<TKind extends RemoteResourceKind>(
        kind: TKind,
        setting: RemoteDBSettings
    ): Promise<RemoteResourceMap[TKind] | undefined> {
        const provider = this.getProviderDefinition(setting);
        if (!provider || !provider.isConfigured(setting)) {
            return undefined;
        }
        return await resolveRemoteResource(provider.remoteResources, kind, setting);
    }

    async runRemoteAdministration(request: RemoteAdministrationRequest): Promise<RemoteAdministrationResult> {
        const context = await this.acquireActiveReplicatorContext();
        const setting = { ...this.settingService.currentSettings() };
        return await runRemoteAdministrationWithContext(context, setting, request);
    }

    async acquireActiveReplicatorContext(): Promise<ActiveReplicatorContext | undefined> {
        // A transition may enqueue another transition while settling. Return
        // only after the observed promise is still the tail of the queue.
        while (true) {
            const transition = this._transition;
            await transition;
            if (transition === this._transition) {
                return this._activeReplicatorState.current?.context;
            }
        }
    }

    readonly onBeforeReplicatorPublication = handlers<IReplicatorService>().bailFirstFailure(
        "onBeforeReplicatorPublication"
    );

    /**
     * Get the currently active replicator instance.
     * If no active replicator, return undefined but that is the fatal situation (on Obsidian).
     */
    getActiveReplicator(): LiveSyncAbstractReplicator | undefined {
        const message = "No replicator has been activated or has not been initialised yet.";
        const activeReplicator = this._activeReplicatorState.current?.replicator;
        if (!activeReplicator) {
            this._unresolvedErrorManager.showError(message, LOG_LEVEL_NOTICE);
            return undefined;
        }
        this._unresolvedErrorManager.clearError(message);
        return activeReplicator;
    }

    replicationStatics = reactiveSource({ ...DEFAULT_REPLICATION_STATICS });
}
