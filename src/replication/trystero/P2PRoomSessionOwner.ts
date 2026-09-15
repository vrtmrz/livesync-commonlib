import { Logger } from "@lib/common/logger";
import {
    LOG_LEVEL_NOTICE,
    LOG_LEVEL_VERBOSE,
    SETTING_KEY_P2P_DEVICE_NAME,
    type ObsidianLiveSyncSettings,
} from "@lib/common/types";
import type { AsyncActivityOptions } from "@lib/interfaces/AsyncActivityRunner";
import type { LiveSyncReplicatorEnv } from "@lib/replication/LiveSyncAbstractReplicator";
import type { EntryDoc } from "@lib/common/types";
import { P2PRoomSession } from "./P2PRoomSession";
import type { ReplicatorHostEnv } from "./types";
import { P2PAutomationCoordinator } from "./P2PAutomationCoordinator";
import { PEER_REPLICATION_READINESS } from "@lib/replication/ReplicatorProvider";
import { getP2PReplicatorConfigurationIdentity } from "./p2pReplicatorConfigurationIdentity";
import {
    ACTIVE_P2P_RELAY_BINDING_CONFLICT,
    activeP2PRelayBindingCovers,
    type P2PConnectionProbeAdmissionResult,
    type P2PConnectionProbeSettings,
} from "./P2PConnectionProbeAdmission";
import {
    ICE_SERVER_ACQUISITION_TIMEOUT_MS,
    ICE_SERVER_MINIMUM_REMAINING_LIFETIME_MS,
    IceServerSourceError,
    getIceServerSourceIdentity,
    resolveIceServerSelection,
    toSafeIceServerSourceError,
    validateIceServerConfiguration,
    type IceServerConfiguration,
    type IceServerSource,
    type IceServerSourceFactoryCatalogue,
    type ResolvedIceServerSelection,
} from "@lib/p2p/IceServerSource";

type P2PRoomSessionBinding = {
    readonly database: PouchDB.Database<EntryDoc>;
    readonly enabled: boolean;
    readonly settings: ObsidianLiveSyncSettings;
    readonly deviceName: string;
    readonly signature: string;
    readonly iceServerSelection: ResolvedIceServerSelection;
};

type P2PRoomSessionFactory = (env: ReplicatorHostEnv) => P2PRoomSession;

type CachedIceServerConfiguration = {
    readonly sourceIdentity: string;
    readonly configuration: IceServerConfiguration;
};

type PendingIceServerAcquisition = {
    readonly sourceIdentity: string;
    readonly controller: AbortController;
};

export interface P2PRoomSessionOwnerOptions {
    readonly iceServerSources?: IceServerSourceFactoryCatalogue;
}

class StaleRoomReconciliationError extends Error {}

const P2P_ROOM_OPEN_TIMEOUT_MS = 30_000;

/** Session operations shared by the stable service and its compatibility facade. */
export interface P2PRoomSessionAccess {
    readonly currentSession: P2PRoomSession | undefined;
    readonly isConnected: boolean;
    cancelActiveTransfers(): void;
    open(): Promise<void>;
    close(): Promise<void>;
}

/** Persistent reasons for which the service keeps a P2P room available. */
export type P2PPersistentRoomDemand = "explicit" | "automatic" | "rebuild-continuation";

/**
 * Owns the one published P2P room session used by a stable P2P service.
 *
 * Compatibility facades may observe and operate on the published session, but
 * they do not own its construction, replacement, or retirement.
 */
export class P2PRoomSessionOwner implements P2PRoomSessionAccess {
    private current?: P2PRoomSession;
    private lifecycleOperation: Promise<void> = Promise.resolve();
    private readonly persistentDemands = new Set<P2PPersistentRoomDemand>();
    private readonly finiteDemands = new Set<symbol>();
    private readonly automationCoordinator = new P2PAutomationCoordinator();
    private activeBinding?: P2PRoomSessionBinding;
    private cachedIceServerConfiguration?: CachedIceServerConfiguration;
    private pendingIceServerAcquisition?: PendingIceServerAcquisition;
    private runtimeGeneration = 0;

    constructor(
        private readonly env: LiveSyncReplicatorEnv,
        private readonly createSession: P2PRoomSessionFactory = (sessionEnv) => new P2PRoomSession(sessionEnv),
        private readonly options: P2PRoomSessionOwnerOptions = {}
    ) {}

    get currentSession(): P2PRoomSession | undefined {
        return this.current;
    }

    get isConnected(): boolean {
        return this.current?.host.isServing ?? false;
    }

    cancelActiveTransfers(): void {
        this.current?.cancelActiveTransfers();
    }

    /** Retire automatic baseline history owned by the previous app lifecycle. */
    beginAutomationLifecycle(): void {
        this.automationCoordinator.beginLifecycle();
    }

    async open(): Promise<void> {
        await this.setPersistentDemand("explicit", true);
    }

    /** Reconcile one long-lived reason for keeping the room available. */
    async setPersistentDemand(demand: P2PPersistentRoomDemand, active: boolean): Promise<void> {
        const enabled = this.env.services.setting.currentSettings().P2P_Enabled;
        if (active && enabled) {
            this.persistentDemands.add(demand);
        } else {
            this.persistentDemands.delete(demand);
        }
        if (active && !enabled) {
            Logger(this.env.services.context.translate("P2P.NotEnabled"), LOG_LEVEL_NOTICE);
        }
        this.fenceCredentialStateForCurrentSettings(enabled);
        await this.reconcileTransport();
    }

    /**
     * Keep the room available only for the lifetime of one finite operation.
     *
     * The token is internal to the owner. Releasing it cannot close a room
     * retained by another finite operation or by a persistent policy demand.
     */
    async runWithFiniteDemand<T>(task: (session: P2PRoomSession) => T | PromiseLike<T>): Promise<T> {
        if (!this.env.services.setting.currentSettings().P2P_Enabled) {
            throw new Error("P2P is not enabled.");
        }
        const demand = Symbol("p2p-finite-room-demand");
        this.finiteDemands.add(demand);
        this.fenceCredentialStateForCurrentSettings(true);
        try {
            await this.reconcileTransport();
            if (!this.finiteDemands.has(demand)) {
                throw new Error("The P2P room demand was retired before the operation started.");
            }
            const session = this.current;
            if (!session?.host.isServing) {
                throw new Error("The P2P room could not be opened for the finite operation.");
            }
            return await task(session);
        } finally {
            if (this.finiteDemands.delete(demand)) {
                await this.reconcileTransport();
            }
        }
    }

    /** Arbitrate a complete signalling probe on the room lifecycle queue. */
    runConnectionProbe<T>(
        trialSettings: P2PConnectionProbeSettings,
        runOwnedTrial: () => Promise<T>
    ): Promise<P2PConnectionProbeAdmissionResult<T>> {
        return this.enqueueLifecycleOperation(async () => {
            const current = this.current;
            const activeBinding = this.activeBinding;
            if (current?.host.isServing && activeBinding) {
                if (activeP2PRelayBindingCovers(activeBinding.settings, trialSettings)) {
                    return { status: "observed-active" };
                }
                return {
                    status: "blocked",
                    reason: ACTIVE_P2P_RELAY_BINDING_CONFLICT,
                };
            }
            if (current) {
                await this.closeTransport();
            }
            return {
                status: "trial",
                result: await runOwnedTrial(),
            };
        });
    }

    private async reconcileTransport(): Promise<void> {
        await this.enqueueLifecycleOperation(async () => {
            if (!this.env.services.setting.currentSettings().P2P_Enabled) {
                this.persistentDemands.clear();
                this.finiteDemands.clear();
            }
            if (!this.hasRoomDemand()) {
                await this.closeTransport();
                return;
            }
            let binding: P2PRoomSessionBinding;
            try {
                binding = this.getEffectiveBinding();
            } catch (error) {
                const safeError = toSafeIceServerSourceError(error);
                await this.closeTransport();
                this.reportIceServerSourceError(safeError);
                throw safeError;
            }
            if (
                this.current?.host.isServing &&
                this.bindingsMatch(this.activeBinding, binding) &&
                this.credentialsRemainUsable(binding.iceServerSelection)
            ) {
                this.reconcileCurrentSessionPolicy(this.current);
                Logger("P2P replicator is already open.");
                return;
            }
            if (this.current) {
                await this.closeTransport();
            }

            let candidate: P2PRoomSession | undefined;
            const operationGeneration = this.runtimeGeneration;
            try {
                const iceServerConfiguration = await this.resolveIceServerConfiguration(
                    binding.iceServerSelection,
                    operationGeneration
                );
                this.assertReconciliationCurrent(binding, operationGeneration, iceServerConfiguration);
                candidate = this.createSession(this.buildSessionEnv(binding, iceServerConfiguration));
                if (binding.iceServerSelection.kind === "managed") {
                    await this.withRoomOpenDeadline(candidate.open());
                } else {
                    await candidate.open();
                }
                if (!candidate.host.isServing) {
                    throw new Error("The P2P room did not start serving.");
                }
                const currentBinding = this.getEffectiveBinding();
                if (
                    !currentBinding.enabled ||
                    !this.hasRoomDemand() ||
                    !this.bindingsMatch(binding, currentBinding) ||
                    operationGeneration !== this.runtimeGeneration ||
                    !this.configurationRemainsUsable(iceServerConfiguration)
                ) {
                    await candidate.retire();
                    return;
                }
                this.current = candidate;
                this.activeBinding = binding;
                this.reconcileCurrentSessionPolicy(candidate);
            } catch (error) {
                await candidate?.retire(error).catch((retirementError: unknown) => {
                    if (binding.iceServerSelection.kind === "managed") {
                        Logger("The managed P2P room could not be retired cleanly.", LOG_LEVEL_VERBOSE);
                    } else {
                        Logger(retirementError, LOG_LEVEL_VERBOSE);
                    }
                });
                this.current = undefined;
                this.activeBinding = undefined;
                if (error instanceof StaleRoomReconciliationError || operationGeneration !== this.runtimeGeneration) {
                    return;
                }
                if (error instanceof IceServerSourceError) {
                    this.reportIceServerSourceError(error);
                    throw error;
                }
                if (binding.iceServerSelection.kind === "managed") {
                    Logger("The P2P room could not be opened with the acquired ICE credentials.", LOG_LEVEL_NOTICE);
                    Logger("Managed P2P room opening failed; error details were omitted.", LOG_LEVEL_VERBOSE);
                    return;
                }
                Logger(error instanceof Error ? error.message : "Error while opening P2P connection", LOG_LEVEL_NOTICE);
                Logger(error, LOG_LEVEL_VERBOSE);
            }
        });
    }

    async close(): Promise<void> {
        this.persistentDemands.clear();
        this.finiteDemands.clear();
        this.invalidateCredentialRuntimeState();
        await this.enqueueLifecycleOperation(async () => {
            await this.closeTransport();
        });
    }

    private hasRoomDemand(): boolean {
        return this.persistentDemands.size > 0 || this.finiteDemands.size > 0;
    }

    private enqueueLifecycleOperation<T>(operation: () => Promise<T>): Promise<T> {
        const queued = this.lifecycleOperation.catch((): void => undefined).then(operation);
        this.lifecycleOperation = queued.then(
            (): void => undefined,
            (): void => undefined
        );
        return queued;
    }

    private async closeTransport(): Promise<void> {
        const session = this.current;
        this.current = undefined;
        this.activeBinding = undefined;
        if (session) {
            await session.retire();
        }
    }

    private bindingsMatch(current: P2PRoomSessionBinding | undefined, candidate: P2PRoomSessionBinding): boolean {
        return current?.database === candidate.database && current.signature === candidate.signature;
    }

    private credentialsRemainUsable(selection: ResolvedIceServerSelection): boolean {
        if (selection.kind === "manual") return true;
        const cached = this.cachedIceServerConfiguration;
        return cached?.sourceIdentity === selection.identity && this.configurationRemainsUsable(cached.configuration);
    }

    private configurationRemainsUsable(configuration: IceServerConfiguration | undefined): boolean {
        if (configuration === undefined || configuration.expiresAt === null) return true;
        return configuration.expiresAt > Date.now() + ICE_SERVER_MINIMUM_REMAINING_LIFETIME_MS;
    }

    private fenceCredentialStateForCurrentSettings(enabled: boolean): void {
        if (!enabled) {
            this.invalidateCredentialRuntimeState();
            return;
        }
        let sourceIdentity: string;
        try {
            sourceIdentity = getIceServerSourceIdentity(
                this.env.services.setting.currentSettings().P2P_iceServerSource
            );
        } catch {
            this.invalidateCredentialRuntimeState();
            return;
        }
        const cacheChanged =
            this.cachedIceServerConfiguration !== undefined &&
            this.cachedIceServerConfiguration.sourceIdentity !== sourceIdentity;
        const pendingChanged =
            this.pendingIceServerAcquisition !== undefined &&
            this.pendingIceServerAcquisition.sourceIdentity !== sourceIdentity;
        if (cacheChanged || pendingChanged) this.invalidateCredentialRuntimeState();
    }

    private invalidateCredentialRuntimeState(): void {
        this.runtimeGeneration += 1;
        this.cachedIceServerConfiguration = undefined;
        const pending = this.pendingIceServerAcquisition;
        this.pendingIceServerAcquisition = undefined;
        if (pending && !pending.controller.signal.aborted) {
            pending.controller.abort(
                new IceServerSourceError("unavailable", "The ICE server acquisition was cancelled.", true)
            );
        }
    }

    private async resolveIceServerConfiguration(
        selection: ResolvedIceServerSelection,
        operationGeneration: number
    ): Promise<IceServerConfiguration | undefined> {
        if (selection.kind === "manual") return undefined;

        const cached = this.cachedIceServerConfiguration;
        if (cached?.sourceIdentity === selection.identity && this.configurationRemainsUsable(cached.configuration)) {
            return cached.configuration;
        }
        this.cachedIceServerConfiguration = undefined;

        let source: IceServerSource;
        try {
            source = selection.factory(selection.configuration);
            if (!source || typeof source.acquire !== "function") {
                throw new IceServerSourceError(
                    "configuration",
                    "The ICE server source factory returned an invalid source.",
                    false
                );
            }
        } catch (error) {
            throw toSafeIceServerSourceError(error);
        }

        const controller = new AbortController();
        const pending: PendingIceServerAcquisition = {
            sourceIdentity: selection.identity,
            controller,
        };
        this.pendingIceServerAcquisition = pending;
        try {
            const acquired = await this.acquireWithDeadline(source, controller);
            const validated = validateIceServerConfiguration(acquired, { managed: true });
            this.assertReconciliationCurrent(undefined, operationGeneration, validated, selection.identity);
            this.cachedIceServerConfiguration = {
                sourceIdentity: selection.identity,
                configuration: validated,
            };
            return validated;
        } finally {
            if (this.pendingIceServerAcquisition === pending) {
                this.pendingIceServerAcquisition = undefined;
            }
        }
    }

    private acquireWithDeadline(source: IceServerSource, controller: AbortController): Promise<IceServerConfiguration> {
        const acquisition = Promise.resolve()
            .then(() => source.acquire(controller.signal))
            .catch((error: unknown) => {
                throw toSafeIceServerSourceError(error);
            });
        return new Promise<IceServerConfiguration>((resolve, reject) => {
            let settled = false;
            const finish = (operation: () => void) => {
                if (settled) return;
                settled = true;
                globalThis.clearTimeout(timeout);
                controller.signal.removeEventListener("abort", onAbort);
                operation();
            };
            const onAbort = () =>
                finish(() =>
                    reject(
                        controller.signal.reason instanceof IceServerSourceError
                            ? controller.signal.reason
                            : new IceServerSourceError("unavailable", "The ICE server acquisition was cancelled.", true)
                    )
                );
            const timeout = globalThis.setTimeout(() => {
                controller.abort(
                    new IceServerSourceError("unavailable", "The ICE server acquisition timed out.", true)
                );
            }, ICE_SERVER_ACQUISITION_TIMEOUT_MS);
            controller.signal.addEventListener("abort", onAbort, { once: true });
            if (controller.signal.aborted) onAbort();
            acquisition.then(
                (configuration) => finish(() => resolve(configuration)),
                (error: unknown) => finish(() => reject(toSafeIceServerSourceError(error)))
            );
        });
    }

    private async withRoomOpenDeadline(opening: Promise<void>): Promise<void> {
        let timeout: ReturnType<typeof globalThis.setTimeout> | undefined;
        try {
            await Promise.race([
                opening,
                new Promise<never>((_resolve, reject) => {
                    timeout = globalThis.setTimeout(
                        () => reject(new Error("The P2P room opening timed out.")),
                        P2P_ROOM_OPEN_TIMEOUT_MS
                    );
                }),
            ]);
        } finally {
            if (timeout !== undefined) globalThis.clearTimeout(timeout);
        }
    }

    private assertReconciliationCurrent(
        binding: P2PRoomSessionBinding | undefined,
        operationGeneration: number,
        configuration?: IceServerConfiguration,
        sourceIdentity?: string
    ): void {
        if (operationGeneration !== this.runtimeGeneration || !this.hasRoomDemand()) {
            throw new StaleRoomReconciliationError();
        }
        const currentBinding = this.getEffectiveBinding();
        if (!currentBinding.enabled) throw new StaleRoomReconciliationError();
        if (binding && !this.bindingsMatch(binding, currentBinding)) throw new StaleRoomReconciliationError();
        if (sourceIdentity !== undefined && currentBinding.iceServerSelection.identity !== sourceIdentity) {
            throw new StaleRoomReconciliationError();
        }
        if (!this.configurationRemainsUsable(configuration)) throw new StaleRoomReconciliationError();
    }

    private reportIceServerSourceError(error: IceServerSourceError): void {
        Logger(error.message, LOG_LEVEL_NOTICE);
        Logger(
            {
                name: error.name,
                code: error.code,
                retryable: error.retryable,
                message: error.message,
            },
            LOG_LEVEL_VERBOSE
        );
    }

    /** Capture immutable session inputs while keeping policy live. */
    private getEffectiveBinding(): P2PRoomSessionBinding {
        const settings = {
            ...this.env.services.setting.currentSettings(),
        };
        const deviceName =
            this.env.services.config.getSmallConfig(SETTING_KEY_P2P_DEVICE_NAME) ||
            this.env.services.vault.getVaultName();
        const database = this.env.services.database.localDatabase.localDatabase;
        if (
            settings.P2P_iceServerSource === undefined &&
            typeof settings.encryptedP2PIceServerSource === "string" &&
            settings.encryptedP2PIceServerSource !== ""
        ) {
            throw new IceServerSourceError(
                "configuration",
                "The encrypted ICE server source configuration is not available.",
                false
            );
        }
        const iceServerSelection = resolveIceServerSelection(
            settings.P2P_iceServerSource,
            this.options.iceServerSources
        );
        this.automationCoordinator.reconcileIdentity(
            JSON.stringify([
                settings.P2P_AppID || "self-hosted-livesync",
                settings.P2P_roomID,
                settings.P2P_passphrase,
            ]),
            database
        );
        return {
            database,
            enabled: settings.P2P_Enabled,
            settings,
            deviceName,
            signature: JSON.stringify([getP2PReplicatorConfigurationIdentity(settings), deviceName]),
            iceServerSelection,
        };
    }

    /** Apply policy which can change without retiring the room session. */
    private reconcileCurrentSessionPolicy(session: P2PRoomSession): void {
        session.replicator.reconcileAutoBroadcast(this.env.services.setting.currentSettings().P2P_AutoBroadcast);
    }

    private buildSessionEnv(
        binding: P2PRoomSessionBinding,
        iceServerConfiguration?: IceServerConfiguration
    ): ReplicatorHostEnv {
        const services = this.env.services;
        return {
            events: services.context.events,
            translate: services.context.translate,
            settings: binding.settings,
            iceServers: iceServerConfiguration?.iceServers,
            currentSettings: () => services.setting.currentSettings(),
            db: binding.database,
            get simpleStore() {
                return services.keyValueDB.openSimpleStore("p2p-sync");
            },
            deviceName: binding.deviceName,
            get platform() {
                return services.API.getPlatform();
            },
            get confirm() {
                return services.API.confirm;
            },
            runFiniteReplicationActivity: <T>(task: () => T | PromiseLike<T>, options?: AsyncActivityOptions) =>
                services.replicator.runFiniteReplicationActivity(task, options),
            canStartOrdinaryReplication: (showMessage: boolean = false) =>
                services.replication.isReplicationReady(showMessage, PEER_REPLICATION_READINESS),
            automationCoordinator: this.automationCoordinator,
            processReplicatedDocs: async (docs) => {
                const currentSettings = services.setting.currentSettings();
                if (currentSettings.suspendParseReplicationResult) {
                    const docLength = docs.length;
                    if (docLength > 0) {
                        Logger(
                            `P2P sync, but parseReplicationResult is suspended. Ignoring ${docLength} documents.`,
                            LOG_LEVEL_VERBOSE
                        );
                    }
                    return;
                }
                await services.replication.parseSynchroniseResult(docs);
            },
        };
    }
}
