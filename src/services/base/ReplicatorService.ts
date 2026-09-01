import type { ReplicatorInstance } from "@lib/replication/ReplicatorInstance";
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
import { CAPABILITY_SUPPORT_KINDS } from "@lib/replication/ProviderCapability.ts";
import type { ObsidianLiveSyncSettings, RemoteDBSettings } from "@lib/common/types.ts";
import {
    ActiveReplicatorState,
    type ActiveReplicatorPublication,
    type ActiveReplicatorRetirement,
} from "./ReplicatorService.activeReplicatorState.ts";
import type { RemoteResourceKind, RemoteResourceMap } from "@lib/replication/RemoteResource.ts";
import { resolveRemoteResource } from "./ReplicatorService.remoteResourceResolver.ts";
import type {
    CentralRemoteAdministrationRequest,
    CentralRemoteAdministrationResult,
} from "@lib/replication/CentralRemoteAdministration.ts";
import { runCentralRemoteAdministrationWithContext } from "./ReplicatorService.centralRemoteAdministration.ts";
import { asCopy } from "@lib/common/utils.object.ts";

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
 * This service composes provider definitions, retires active instances when
 * their configuration identity changes, and publishes the provider and
 * Replicator atomically. Remote administration is dispatched through the
 * admitted active context; `ReplicationService` owns synchronisation
 * readiness and replication dispatch.
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
            this.databaseEventService.onDatabaseInitialisation.addHandler(this.onCloseActiveReplication.bind(this));
            this.databaseEventService.onDatabaseInitialised.addHandler(this.reinitialiseReplicator.bind(this));
            this.databaseEventService.onDatabaseHasReady.addHandler(this.reinitialiseReplicator.bind(this));
            this.appLifecycleService.onSuspending.addHandler(this.suspendReplication.bind(this));
            this.appLifecycleService.onUnload.addHandler(this.onCloseActiveReplication.bind(this));
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

    /** Request a reversible transfer stop without retiring the active publication. */
    private async suspendReplication(): Promise<boolean> {
        return await this.enqueueTransition(async () => {
            // Suspension can precede Replicator initialisation during settings
            // migration. An absent publication is therefore an ordinary no-op.
            const publication = this._activeReplicatorState.current;
            if (publication) {
                await this.requestPublicationTransferStop(publication, "suspension");
            }
            return true;
        });
    }

    private async reinitialiseReplicator() {
        return await this.enqueueTransition(async () => {
            await this.disposeReplicatorNow();
            await yieldMicrotask();
            return await this.initialiseReplicatorNow();
        });
    }
    /** Request transfer cancellation for either a reversible pause or terminal retirement. */
    private async requestPublicationTransferStop(
        publication: ActiveReplicatorPublication,
        reason: "retirement" | "suspension"
    ): Promise<void> {
        try {
            const capability = publication.context?.provider.stopActiveTransfer;
            if (capability?.kind === CAPABILITY_SUPPORT_KINDS.SUPPORTED) {
                const outcome = await capability.run(publication.replicator);
                if (outcome.status !== "completed") {
                    this._log(
                        `Active Replicator transfer stop settled as '${outcome.status}' during ${reason}.`,
                        LOG_LEVEL_VERBOSE
                    );
                }
                return;
            }
            if (!publication.context) {
                await Promise.resolve(publication.replicator.terminateSync());
            }
        } catch (error) {
            // Retirement still proceeds to physical close when a cooperative
            // stop fails. Suspension keeps the publication for later resumption.
            this._log(`Failed to request active Replicator transfer cancellation during ${reason}.`, LOG_LEVEL_VERBOSE);
            this._log(error, LOG_LEVEL_VERBOSE);
        }
    }

    /** Fence new work, request cancellation, and drain only this publication's admitted tasks. */
    private async quiesceActiveReplicator(): Promise<ActiveReplicatorRetirement | undefined> {
        const retirement = this._activeReplicatorState.beginRetirement();
        if (!retirement) return undefined;

        await this.requestPublicationTransferStop(retirement.publication, "retirement");
        await retirement.waitForDemandSettlement();
        return retirement;
    }

    /** Close one drained publication and release its private retirement state. */
    private async closeRetiringReplicator(retirement: ActiveReplicatorRetirement): Promise<void> {
        await Promise.resolve(retirement.publication.replicator.closeReplication());
        retirement.complete();
    }

    private async disposeReplicatorNow(reason?: "configuration transition") {
        const retirement = await this.quiesceActiveReplicator();
        if (!retirement) return true;
        this._log(
            reason === "configuration transition"
                ? "Configuration changed, closing active replicator."
                : "Closing active replicator."
        );
        await this.closeRetiringReplicator(retirement);
        return true;
    }

    private async discardFailedReplicator(replicator: ReplicatorInstance): Promise<void> {
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

    private getProviderDefinition(
        setting: Pick<RemoteDBSettings, "remoteType">
    ): ReplicatorProviderDefinition | undefined {
        return this._providerDefinitions.get(setting.remoteType);
    }

    private async createReplicator(
        settingOverride: Partial<ObsidianLiveSyncSettings> = {}
    ): Promise<ReplicatorInstance | undefined | false> {
        const currentSettings = this.settingService.currentSettings();
        const setting = { ...currentSettings, ...settingOverride };
        return await this.createReplicatorForSetting(setting, settingOverride);
    }

    private async createReplicatorForSetting(
        setting: ObsidianLiveSyncSettings,
        legacySettingOverride: Partial<ObsidianLiveSyncSettings> = {}
    ): Promise<ReplicatorInstance | undefined | false> {
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

    private publishActiveReplicator(
        provider: ReplicatorProviderDefinition | undefined,
        replicator: ReplicatorInstance,
        replicatorType: string,
        configurationIdentity: string | undefined
    ): void {
        this._activeReplicatorState.publish(provider, replicator, replicatorType, configurationIdentity);
    }

    private async initialiseReplicatorNow() {
        const message = this.context.translate("Replicator.Message.InitialiseFatalError");
        const setting = this.settingService.currentSettings();
        if (!setting) {
            await this.disposeReplicatorNow("configuration transition");
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
        if (
            isSameProvider &&
            (!provider || configurationIdentity === activePublication?.context?.configurationIdentity)
        ) {
            // No need to change the replicator.
            this._unresolvedErrorManager.clearError(message);
            this._log("Active replicator has been kept", LOG_LEVEL_VERBOSE);
            return true;
        } else {
            this._log("Acquiring new replicator");
            await this.disposeReplicatorNow("configuration transition");
            if (activePublication) {
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
            // Host preparation clears state such as cached key-derivation
            // parameters before this candidate can become active.
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
                if (
                    provider &&
                    (configurationIdentity === undefined ||
                        !this.isCurrentProviderConfiguration(provider, configurationIdentity))
                ) {
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
     * Fence new work, drain admitted work, and close the active Replicator.
     *
     * The command is serialised with every other ownership transition. Callers
     * must not await it from inside `runWithActiveReplicatorContext()`, because
     * retirement waits for that admitted callback to settle.
     */
    async onCloseActiveReplication(): Promise<boolean> {
        return await this.enqueueTransition(() => this.disposeReplicatorNow());
    }

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

    /**
     * Return a non-owning synchronous view for lifecycle diagnostics and focused tests.
     *
     * Production work must use an admitted acquisition or callback boundary so that
     * the context cannot be retired while it is in use.
     */
    protected inspectActiveReplicatorContext(): ActiveReplicatorContext | undefined {
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

    /** Apply and verify one provider-declared action before permitting a later switch. */
    async runCentralRemoteAdministration(
        request: CentralRemoteAdministrationRequest
    ): Promise<CentralRemoteAdministrationResult> {
        const setting = asCopy(this.settingService.currentSettings());
        const result = await this.runWithActiveReplicatorContext((context) =>
            runCentralRemoteAdministrationWithContext(context, setting, request)
        );
        return result ?? (await runCentralRemoteAdministrationWithContext(undefined, setting, request));
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

    /**
     * Admit one callback against the publication ordered before later transitions.
     *
     * Release never enters the transition queue. The callback must not initiate
     * or await a settings, database, or Replicator lifecycle transition which
     * would wait for this same reservation.
     */
    async runWithActiveReplicatorContext<TResult>(
        task: (context: ActiveReplicatorContext) => TResult | PromiseLike<TResult>
    ): Promise<TResult | undefined> {
        const reservation = await this.enqueueTransition(async () => this._activeReplicatorState.reserve());
        if (!reservation) return undefined;

        try {
            return await task(reservation.context);
        } finally {
            reservation.release();
        }
    }

    readonly onBeforeReplicatorPublication = handlers<IReplicatorService>().bailFirstFailure(
        "onBeforeReplicatorPublication"
    );

    /**
     * Return the legacy unreserved view of the active Replicator.
     *
     * Missing active state retains its established Notice-level diagnostic.
     * New work must acquire or admit an `ActiveReplicatorContext` instead.
     */
    getActiveReplicator(): ReplicatorInstance | undefined {
        const message = "No replicator has been activated or has not been initialised yet.";
        const activeReplicator = this._activeReplicatorState.current?.replicator;
        if (!activeReplicator) {
            this._unresolvedErrorManager.showError(message, LOG_LEVEL_NOTICE);
            return undefined;
        }
        this._unresolvedErrorManager.clearError(message);
        return activeReplicator;
    }

    /**
     * Classify whether a compatibility active Replicator exists without
     * acquiring or returning it.
     *
     * This side-effect-free, non-owning predicate exists only for
     * compatibility-state classification. Work must acquire or admit an
     * `ActiveReplicatorContext` before using a Replicator.
     */
    hasActiveReplicator(): boolean {
        return this._activeReplicatorState.current !== undefined;
    }

    replicationStatics = reactiveSource({ ...DEFAULT_REPLICATION_STATICS });
}
