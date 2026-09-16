import { Logger } from "@lib/common/logger";
import {
    LOG_LEVEL_NOTICE,
    LOG_LEVEL_VERBOSE,
    SETTING_KEY_P2P_DEVICE_NAME,
    hasManagedP2PTurnConfiguration,
    omitP2PRuntimeSettings,
    type ObsidianLiveSyncSettings,
    type P2PSyncSetting,
} from "@lib/common/types";
import { P2PConnectionPaths } from "@lib/common/models/setting.const";
import { normaliseP2PConnectionPath } from "@lib/common/models/setting.p2p";
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

type P2PRoomSessionBinding = {
    readonly database: PouchDB.Database<EntryDoc>;
    readonly enabled: boolean;
    readonly settings: ObsidianLiveSyncSettings;
    readonly deviceName: string;
    readonly signature: string;
};

type P2PRoomSessionFactory = (env: ReplicatorHostEnv) => P2PRoomSession;

type PendingP2PSettingsPreparation = {
    readonly signature: string;
    readonly controller: AbortController;
};

/** Prepare connection-only P2P settings for one room generation. */
export type PrepareP2PSettings = (settings: Readonly<P2PSyncSetting>, signal: AbortSignal) => Promise<P2PSyncSetting>;

export interface P2PRoomSessionOwnerOptions {
    readonly prepareP2PSettings?: PrepareP2PSettings;
}

class StaleRoomReconciliationError extends Error {}

const P2P_ROOM_OPEN_TIMEOUT_MS = 30_000;
export const P2P_SETTINGS_PREPARATION_TIMEOUT_MS = 30_000;
export const P2P_ICE_SERVER_EXPIRY_MARGIN_MS = 30_000;

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
    private pendingPreparation?: PendingP2PSettingsPreparation;
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
        this.fencePreparationForCurrentSettings(enabled);
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
        this.fencePreparationForCurrentSettings(true);
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
            const binding = this.getEffectiveBinding();
            if (
                this.current?.host.isServing &&
                this.bindingsMatch(this.activeBinding, binding) &&
                this.connectionSettingsRemainUsable(this.activeBinding?.settings)
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
                const connectionSettings = await this.prepareConnectionSettings(binding, operationGeneration);
                this.assertReconciliationCurrent(binding, operationGeneration, connectionSettings);
                const connectionBinding = { ...binding, settings: connectionSettings };
                candidate = this.createSession(this.buildSessionEnv(connectionBinding));
                if (hasManagedP2PTurnConfiguration(binding.settings)) {
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
                    !this.connectionSettingsRemainUsable(connectionSettings)
                ) {
                    await candidate.retire();
                    return;
                }
                this.current = candidate;
                this.activeBinding = connectionBinding;
                this.reconcileCurrentSessionPolicy(candidate);
            } catch (error) {
                await candidate?.retire(error).catch((retirementError: unknown) => {
                    if (hasManagedP2PTurnConfiguration(binding.settings)) {
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
                if (hasManagedP2PTurnConfiguration(binding.settings)) {
                    Logger("The managed P2P room could not be prepared or opened.", LOG_LEVEL_NOTICE);
                    Logger("Managed P2P room failure details were omitted.", LOG_LEVEL_VERBOSE);
                    throw new Error("The managed P2P room could not be prepared or opened.");
                }
                Logger(error instanceof Error ? error.message : "Error while opening P2P connection", LOG_LEVEL_NOTICE);
                Logger(error, LOG_LEVEL_VERBOSE);
            }
        });
    }

    async close(): Promise<void> {
        this.persistentDemands.clear();
        this.finiteDemands.clear();
        this.invalidatePreparation();
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

    private connectionSettingsRemainUsable(settings: P2PSyncSetting | undefined): boolean {
        if (!settings) return false;
        const managed = hasManagedP2PTurnConfiguration(settings);
        const iceServers = settings.P2P_iceServers;
        if (iceServers === undefined) return !managed;
        if (!this.hasUsableIceServer(iceServers)) return false;
        const hasTurnServer = this.hasUsableTurnServer(iceServers);
        if (managed && !hasTurnServer) return false;
        if (normaliseP2PConnectionPath(settings.P2P_connectionPath) === P2PConnectionPaths.Relay && !hasTurnServer) {
            return false;
        }
        const expiresAt = settings.P2P_iceServersExpiresAt;
        if (expiresAt === undefined) return !managed;
        return Number.isFinite(expiresAt) && expiresAt > Date.now() + P2P_ICE_SERVER_EXPIRY_MARGIN_MS;
    }

    private fencePreparationForCurrentSettings(enabled: boolean): void {
        if (!enabled) {
            this.invalidatePreparation();
            return;
        }
        const pendingChanged =
            this.pendingPreparation !== undefined &&
            this.pendingPreparation.signature !== this.getEffectiveBinding().signature;
        if (pendingChanged) this.invalidatePreparation();
    }

    private invalidatePreparation(): void {
        this.runtimeGeneration += 1;
        const pending = this.pendingPreparation;
        this.pendingPreparation = undefined;
        if (pending && !pending.controller.signal.aborted) {
            pending.controller.abort(new Error("The P2P settings preparation was cancelled."));
        }
    }

    private async prepareConnectionSettings(
        binding: P2PRoomSessionBinding,
        operationGeneration: number
    ): Promise<ObsidianLiveSyncSettings> {
        const managed = hasManagedP2PTurnConfiguration(binding.settings);
        const prepare = this.options.prepareP2PSettings;
        if (!prepare) {
            if (managed) throw new Error("The selected managed TURN configuration is not supported by this host.");
            return binding.settings;
        }

        const controller = new AbortController();
        const pending: PendingP2PSettingsPreparation = {
            signature: binding.signature,
            controller,
        };
        this.pendingPreparation = pending;
        try {
            const prepared = await this.prepareWithDeadline(prepare, binding.settings, controller);
            if (prepared.P2P_iceServers === undefined && prepared.P2P_iceServersExpiresAt === undefined) {
                if (managed) throw new Error("The prepared managed TURN settings do not include ICE servers.");
                return binding.settings;
            }
            const iceServers = this.copyPreparedIceServers(prepared.P2P_iceServers);
            const expiresAt = prepared.P2P_iceServersExpiresAt;
            const connectionSettings: ObsidianLiveSyncSettings = {
                ...binding.settings,
                P2P_iceServers: iceServers,
                P2P_iceServersExpiresAt: expiresAt,
            };
            if (!this.connectionSettingsRemainUsable(connectionSettings)) {
                throw new Error("The prepared managed TURN settings are missing usable ICE servers or expiry.");
            }
            this.assertReconciliationCurrent(binding, operationGeneration, connectionSettings);
            return connectionSettings;
        } finally {
            if (this.pendingPreparation === pending) {
                this.pendingPreparation = undefined;
            }
        }
    }

    private prepareWithDeadline(
        prepare: PrepareP2PSettings,
        settings: P2PSyncSetting,
        controller: AbortController
    ): Promise<P2PSyncSetting> {
        const preparation = Promise.resolve().then(() => prepare(Object.freeze({ ...settings }), controller.signal));
        return new Promise<P2PSyncSetting>((resolve, reject) => {
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
                        controller.signal.reason instanceof Error
                            ? controller.signal.reason
                            : new Error("The P2P settings preparation was cancelled.")
                    )
                );
            const timeout = globalThis.setTimeout(() => {
                controller.abort(new Error("The P2P settings preparation timed out."));
            }, P2P_SETTINGS_PREPARATION_TIMEOUT_MS);
            controller.signal.addEventListener("abort", onAbort, { once: true });
            if (controller.signal.aborted) onAbort();
            preparation.then(
                (prepared) => finish(() => resolve(prepared)),
                () => finish(() => reject(new Error("The P2P settings preparation failed.")))
            );
        });
    }

    private copyPreparedIceServers(iceServers: readonly RTCIceServer[] | undefined): readonly RTCIceServer[] {
        if (!Array.isArray(iceServers) || iceServers.length === 0) return [];
        return iceServers.map((server) => ({
            urls: typeof server.urls === "string" ? server.urls : [...server.urls],
            ...(server.username === undefined ? {} : { username: server.username }),
            ...(server.credential === undefined ? {} : { credential: server.credential }),
        }));
    }

    private hasUsableIceServer(iceServers: readonly RTCIceServer[] | undefined): boolean {
        return (
            Array.isArray(iceServers) &&
            iceServers.some((server) => {
                const urls = typeof server?.urls === "string" ? [server.urls] : server?.urls;
                return Array.isArray(urls) && urls.some((url) => typeof url === "string" && url.trim().length > 0);
            })
        );
    }

    private hasUsableTurnServer(iceServers: readonly RTCIceServer[] | undefined): boolean {
        return (
            Array.isArray(iceServers) &&
            iceServers.some((server) => {
                const urls = typeof server?.urls === "string" ? [server.urls] : server?.urls;
                return Array.isArray(urls) && urls.some((url) => typeof url === "string" && /^turns?:/iu.test(url));
            })
        );
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
        connectionSettings?: P2PSyncSetting
    ): void {
        if (operationGeneration !== this.runtimeGeneration || !this.hasRoomDemand()) {
            throw new StaleRoomReconciliationError();
        }
        const currentBinding = this.getEffectiveBinding();
        if (!currentBinding.enabled) throw new StaleRoomReconciliationError();
        if (binding && !this.bindingsMatch(binding, currentBinding)) throw new StaleRoomReconciliationError();
        if (connectionSettings && !this.connectionSettingsRemainUsable(connectionSettings)) {
            throw new StaleRoomReconciliationError();
        }
    }

    /** Capture immutable session inputs while keeping policy live. */
    private getEffectiveBinding(): P2PRoomSessionBinding {
        const settings = omitP2PRuntimeSettings({
            ...this.env.services.setting.currentSettings(),
        }) as ObsidianLiveSyncSettings;
        const deviceName =
            this.env.services.config.getSmallConfig(SETTING_KEY_P2P_DEVICE_NAME) ||
            this.env.services.vault.getVaultName();
        const database = this.env.services.database.localDatabase.localDatabase;
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
        };
    }

    /** Apply policy which can change without retiring the room session. */
    private reconcileCurrentSessionPolicy(session: P2PRoomSession): void {
        session.replicator.reconcileAutoBroadcast(this.env.services.setting.currentSettings().P2P_AutoBroadcast);
    }

    private buildSessionEnv(binding: P2PRoomSessionBinding): ReplicatorHostEnv {
        const services = this.env.services;
        return {
            events: services.context.events,
            translate: services.context.translate,
            settings: binding.settings,
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
