import { Logger } from "@lib/common/logger";
import {
    LOG_LEVEL_NOTICE,
    LOG_LEVEL_VERBOSE,
    SETTING_KEY_P2P_DEVICE_NAME,
    type ObsidianLiveSyncSettings,
} from "@lib/common/types";
import {
    hasValidP2PTurnServerUrl,
    normaliseP2PConnectionPath,
    normaliseP2PMaxWirePayloadBytes,
} from "@lib/common/models/setting.p2p";
import { P2PConnectionPaths } from "@lib/common/models/setting.const";
import type { AsyncActivityOptions } from "@lib/interfaces/AsyncActivityRunner";
import type { LiveSyncReplicatorEnv } from "@lib/replication/LiveSyncAbstractReplicator";
import type { EntryDoc } from "@lib/common/types";
import { P2PRoomSession } from "./P2PRoomSession";
import type { ReplicatorHostEnv } from "./types";

type P2PRoomSessionBinding = {
    readonly database: PouchDB.Database<EntryDoc>;
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

/**
 * Owns the one published P2P room session used by a stable P2P service.
 *
 * Compatibility facades may observe and operate on the published session, but
 * they do not own its construction, replacement, or retirement.
 */
export class P2PRoomSessionOwner implements P2PRoomSessionAccess {
    private current?: P2PRoomSession;
    private lifecycleOperation: Promise<void> = Promise.resolve();
    private shouldBeOpen = false;
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

    async open(): Promise<void> {
        if (!this.env.services.setting.currentSettings().P2P_Enabled) {
            Logger(this.env.services.context.translate("P2P.NotEnabled"), LOG_LEVEL_NOTICE);
            return;
        }
        this.shouldBeOpen = true;
        await this.enqueueLifecycleOperation(async () => {
            if (!this.shouldBeOpen) return;
            const binding = this.getEffectiveBinding();
            if (this.current?.host.isServing && this.bindingsMatch(this.activeBinding, binding)) {
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
                if (!this.shouldBeOpen || !this.bindingsMatch(binding, this.getEffectiveBinding())) {
                    await candidate.retire();
                    return;
                }
                this.current = candidate;
                this.activeBinding = binding;
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
        this.shouldBeOpen = false;
        await this.enqueueLifecycleOperation(async () => {
            await this.closeTransport();
        });
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

    /** Capture every input whose change invalidates session-owned resources. */
    private getEffectiveBinding(): P2PRoomSessionBinding {
        const settings = {
            ...(this.env.services.setting.currentSettings() as ObsidianLiveSyncSettings),
        };
        const configuredPath = normaliseP2PConnectionPath(settings.P2P_connectionPath);
        const effectivePath =
            configuredPath === P2PConnectionPaths.Relay && hasValidP2PTurnServerUrl(settings.P2P_turnServers ?? "")
                ? P2PConnectionPaths.Relay
                : P2PConnectionPaths.Automatic;
        const deviceName =
            this.env.services.config.getSmallConfig(SETTING_KEY_P2P_DEVICE_NAME) ||
            this.env.services.vault.getVaultName();
        return {
            database: this.env.services.database.localDatabase.localDatabase,
            settings,
            deviceName,
            signature: JSON.stringify([
                settings.P2P_Enabled,
                settings.P2P_ActiveRemoteConfigurationId,
                settings.P2P_AppID,
                settings.P2P_roomID,
                settings.P2P_passphrase,
                settings.P2P_relays,
                settings.P2P_turnServers,
                settings.P2P_turnUsername,
                settings.P2P_turnCredential,
                normaliseP2PMaxWirePayloadBytes(settings.P2P_maxWirePayloadBytes),
                effectivePath,
                settings.P2P_useDiagRTC ?? false,
                settings.P2P_AutoStart,
                settings.P2P_AutoBroadcast,
                settings.P2P_AutoSyncPeers,
                settings.P2P_AutoWatchPeers,
                settings.P2P_SyncOnReplication,
                settings.P2P_AutoAccepting,
                settings.P2P_AutoAcceptingPeers,
                settings.P2P_AutoDenyingPeers,
                settings.P2P_IsHeadless ?? false,
                deviceName,
            ]),
        };
    }

    private buildSessionEnv(binding: P2PRoomSessionBinding): ReplicatorHostEnv {
        const services = this.env.services;
        return {
            events: services.context.events,
            translate: services.context.translate,
            settings: binding.settings,
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
                services.replication.onCheckReplicationReady(showMessage),
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
