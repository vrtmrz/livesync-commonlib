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

type P2PRoomSessionBinding = {
    readonly database: PouchDB.Database<EntryDoc>;
    readonly enabled: boolean;
    readonly settings: ObsidianLiveSyncSettings;
    readonly deviceName: string;
    readonly signature: string;
};

type P2PRoomSessionFactory = (env: ReplicatorHostEnv) => P2PRoomSession;

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

    constructor(
        private readonly env: LiveSyncReplicatorEnv,
        private readonly createSession: P2PRoomSessionFactory = (sessionEnv) => new P2PRoomSession(sessionEnv)
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
            if (this.current?.host.isServing && this.bindingsMatch(this.activeBinding, binding)) {
                this.reconcileCurrentSessionPolicy(this.current);
                Logger("P2P replicator is already open.");
                return;
            }
            if (this.current) {
                await this.closeTransport();
            }

            let candidate: P2PRoomSession | undefined;
            try {
                candidate = this.createSession(this.buildSessionEnv(binding));
                await candidate.open();
                if (!candidate.host.isServing) {
                    throw new Error("The P2P room did not start serving.");
                }
                const currentBinding = this.getEffectiveBinding();
                if (!currentBinding.enabled || !this.hasRoomDemand() || !this.bindingsMatch(binding, currentBinding)) {
                    await candidate.retire();
                    return;
                }
                this.current = candidate;
                this.activeBinding = binding;
                this.reconcileCurrentSessionPolicy(candidate);
            } catch (error) {
                await candidate?.retire(error).catch((retirementError: unknown) => {
                    Logger(retirementError, LOG_LEVEL_VERBOSE);
                });
                Logger(error instanceof Error ? error.message : "Error while opening P2P connection", LOG_LEVEL_NOTICE);
                Logger(error, LOG_LEVEL_VERBOSE);
                this.current = undefined;
                this.activeBinding = undefined;
            }
        });
    }

    async close(): Promise<void> {
        this.persistentDemands.clear();
        this.finiteDemands.clear();
        await this.enqueueLifecycleOperation(async () => {
            await this.closeTransport();
        });
    }

    private hasRoomDemand(): boolean {
        return this.persistentDemands.size > 0 || this.finiteDemands.size > 0;
    }

    private enqueueLifecycleOperation(operation: () => Promise<void>): Promise<void> {
        const queued = this.lifecycleOperation.catch((): void => undefined).then(operation);
        this.lifecycleOperation = queued.catch((): void => undefined);
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

    /** Capture immutable session inputs while keeping policy live. */
    private getEffectiveBinding(): P2PRoomSessionBinding {
        const settings = {
            ...(this.env.services.setting.currentSettings() as ObsidianLiveSyncSettings),
        };
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
