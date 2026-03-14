import type { SimpleStore } from "octagonal-wheels/databases/SimpleStoreBase";
import { type EntryDoc, type LOG_LEVEL, AutoAccepting, type P2PSyncSetting, REMOTE_P2P } from "../../common/types";
import { reactiveSource, type ReactiveSource } from "octagonal-wheels/dataobject/reactive";
import { EVENT_DATABASE_REBUILT, EVENT_SETTING_SAVED, EVENT_REQUEST_OPEN_P2P } from "../../events/coreEvents";
import { eventHub } from "../../hub/hub";
import type { Confirm } from "../../interfaces/Confirm";
import { LiveSyncTrysteroReplicator, type LiveSyncTrysteroReplicatorEnv } from "./LiveSyncTrysteroReplicator";
import { type P2PReplicationProgress } from "./TrysteroReplicator";
import {
    EVENT_ADVERTISEMENT_RECEIVED,
    EVENT_DEVICE_LEAVED,
    EVENT_P2P_CONNECTED,
    EVENT_P2P_DISCONNECTED,
    EVENT_P2P_REPLICATOR_PROGRESS,
    EVENT_REQUEST_STATUS,
} from "./TrysteroReplicatorP2PServer";
import type { InjectableServiceHub } from "../../services/InjectableServices";
import { EVENT_PLATFORM_UNLOADED } from "@lib/events/coreEvents";
import type { NecessaryServices } from "@lib/interfaces/ServiceModule";
import { Logger, LOG_LEVEL_NOTICE } from "../../common/logger";

export function addP2PEventHandlers(instance: LiveSyncTrysteroReplicator) {
    eventHub.onEvent(EVENT_ADVERTISEMENT_RECEIVED, (peer) => instance.onNewPeer(peer));
    eventHub.onEvent(EVENT_DEVICE_LEAVED, (peerId) => instance.onPeerLeaved(peerId));
    eventHub.onEvent(EVENT_REQUEST_STATUS, () => {
        instance.requestStatus();
    });
    eventHub.onEvent(EVENT_DATABASE_REBUILT, async () => {
        await instance.open();
    });
    eventHub.onEvent(EVENT_PLATFORM_UNLOADED, () => {
        void instance.close();
    });
    eventHub.onEvent(EVENT_SETTING_SAVED, async (_settings: P2PSyncSetting) => {
        await instance.open();
    });
}

export async function openP2PReplicator(instance: LiveSyncTrysteroReplicator) {
    if (!instance.server?.isServing) {
        await instance.open();
    }
}

export async function closeP2PReplicator(instance: LiveSyncTrysteroReplicator) {
    await instance.close();
}

export class P2PLogCollector {
    constructor() {
        eventHub.onEvent(EVENT_ADVERTISEMENT_RECEIVED, (data) => {
            this.p2pReplicationResult.set(data.peerId, {
                peerId: data.peerId,
                peerName: data.name,
                fetching: {
                    current: 0,
                    max: 0,
                    isActive: false,
                },
                sending: {
                    current: 0,
                    max: 0,
                    isActive: false,
                },
            });
            this.updateP2PReplicationLine();
        });
        eventHub.onEvent(EVENT_P2P_CONNECTED, () => {
            this.p2pReplicationResult.clear();
            this.updateP2PReplicationLine();
        });
        eventHub.onEvent(EVENT_P2P_DISCONNECTED, () => {
            this.p2pReplicationResult.clear();
            this.updateP2PReplicationLine();
        });
        eventHub.onEvent(EVENT_DEVICE_LEAVED, (peerId) => {
            this.p2pReplicationResult.delete(peerId);
            this.updateP2PReplicationLine();
        });
        eventHub.onEvent(EVENT_P2P_REPLICATOR_PROGRESS, (data) => {
            const prev = this.p2pReplicationResult.get(data.peerId) || {
                peerId: data.peerId,
                peerName: data.peerName,
                fetching: {
                    current: 0,
                    max: 0,
                    isActive: false,
                },
                sending: {
                    current: 0,
                    max: 0,
                    isActive: false,
                },
            };
            if ("fetching" in data) {
                if (data.fetching.isActive) {
                    prev.fetching = data.fetching;
                } else {
                    prev.fetching.isActive = false;
                }
            }
            if ("sending" in data) {
                if (data.sending.isActive) {
                    prev.sending = data.sending;
                } else {
                    prev.sending.isActive = false;
                }
            }
            this.p2pReplicationResult.set(data.peerId, prev);
            this.updateP2PReplicationLine();
        });
    }
    p2pReplicationResult = new Map<string, P2PReplicationProgress>();
    updateP2PReplicationLine() {
        const p2pReplicationResultX = [...this.p2pReplicationResult.values()].sort((a, b) =>
            a.peerId.localeCompare(b.peerId)
        );
        const renderProgress = (current: number, max: number) => {
            if (current == max) return `${current}`;
            return `${current} (${max})`;
        };
        const line = p2pReplicationResultX
            .map(
                (e) =>
                    `${e.fetching.isActive || e.sending.isActive ? "⚡" : "💤"} ${e.peerName} ↑ ${renderProgress(e.sending.current, e.sending.max)} ↓ ${renderProgress(e.fetching.current, e.fetching.max)} `
            )
            .join("\n");
        this.p2pReplicationLine.value = line;
    }
    p2pReplicationLine = reactiveSource("");
}

export interface P2PReplicatorBase {
    storeP2PStatusLine: ReactiveSource<string>;
    settings: P2PSyncSetting;
    _log(msg: any, level?: LOG_LEVEL): void;
    _notice(msg: any, key?: string): void;

    getSettings(): P2PSyncSetting;
    getDB: () => PouchDB.Database<EntryDoc>;
    confirm: Confirm;
    simpleStore(): SimpleStore<any>;
    handleReplicatedDocuments(docs: EntryDoc[]): Promise<boolean>;
    init(): Promise<this>;

    services: InjectableServiceHub;
}

export type UseP2PReplicatorResult = {
    replicator: LiveSyncTrysteroReplicator;
    p2pLogCollector: P2PLogCollector;
    storeP2PStatusLine: ReactiveSource<string>;
};

export type P2PViewFactory = (leaf: any) => any;

/**
 * ServiceFeature: P2P Replicator lifecycle management.
 * Binds a LiveSyncTrysteroReplicator to the host's lifecycle events,
 * following the same middleware style as useOfflineScanner.
 *
 * @param viewTypeAndFactory  Optional [viewType, factory] pair for registering the P2P pane view.
 *                            When provided, also registers commands and ribbon icon via services.API.
 */
export function useP2PReplicator(
    host: NecessaryServices<
        | "API"
        | "appLifecycle"
        | "setting"
        | "vault"
        | "database"
        | "databaseEvents"
        | "keyValueDB"
        | "replication"
        | "config"
        | "UI"
        | "replicator",
        never
    >,
    viewTypeAndFactory?: [viewType: string, factory: P2PViewFactory]
): UseP2PReplicatorResult {
    const env: LiveSyncTrysteroReplicatorEnv = { services: host.services as any };
    const replicator = new LiveSyncTrysteroReplicator(env);
    addP2PEventHandlers(replicator);

    const p2pLogCollector = new P2PLogCollector();
    const storeP2PStatusLine = reactiveSource("");
    p2pLogCollector.p2pReplicationLine.onChanged((line) => {
        storeP2PStatusLine.value = line.value;
    });

    // Lifecycle bindings
    host.services.appLifecycle.onResumed.addHandler(() => {
        const settings = host.services.setting.currentSettings();
        if (settings.P2P_Enabled && settings.P2P_AutoStart) {
            setTimeout(() => void replicator.open(), 100);
        }
        return Promise.resolve(true);
    });
    host.services.appLifecycle.onUnload.addHandler(async () => {
        await replicator.close();
        return true;
    });

    host.services.appLifecycle.onSuspending.addHandler(async () => {
        await replicator.close();
        return true;
    });

    host.services.databaseEvents.onDatabaseInitialisation.addHandler(async () => {
        await replicator.close();
        return true;
    });

    // Suspend extra sync handler
    host.services.setting.suspendExtraSync.addHandler(() => {
        const s = host.services.setting.currentSettings();
        s.P2P_Enabled = false;
        s.P2P_AutoAccepting = AutoAccepting.NONE;
        s.P2P_AutoBroadcast = false;
        s.P2P_AutoStart = false;
        s.P2P_AutoSyncPeers = "";
        s.P2P_AutoWatchPeers = "";
        return Promise.resolve(true);
    });

    // New replicator factory
    host.services.replicator.getNewReplicator.addHandler((settingOverride: Partial<any> = {}) => {
        const settings = { ...host.services.setting.currentSettings(), ...settingOverride };
        if (settings.remoteType == REMOTE_P2P) {
            return Promise.resolve(new LiveSyncTrysteroReplicator({ services: host.services as any }));
        }
        return undefined!;
    });

    // Register view, commands and ribbon if a view factory is provided
    if (viewTypeAndFactory) {
        const [viewType, factory] = viewTypeAndFactory;
        const openPane = () => host.services.API.showWindow(viewType);

        host.services.appLifecycle.onInitialise.addHandler(() => {
            host.services.API.registerWindow(viewType, factory);

            eventHub.onEvent(EVENT_REQUEST_OPEN_P2P, () => {
                void openPane();
            });

            host.services.API.addCommand({
                id: "open-p2p-replicator",
                name: "P2P Sync : Open P2P Replicator",
                callback: () => {
                    void openPane();
                },
            });
            host.services.API.addCommand({
                id: "p2p-establish-connection",
                name: "P2P Sync : Connect to the Signalling Server",
                checkCallback: (isChecking: boolean) => {
                    if (isChecking) return !(replicator.server?.isServing ?? false);
                    void replicator.open();
                },
            });
            host.services.API.addCommand({
                id: "p2p-close-connection",
                name: "P2P Sync : Disconnect from the Signalling Server",
                checkCallback: (isChecking: boolean) => {
                    if (isChecking) return replicator.server?.isServing ?? false;
                    Logger("Closing P2P Connection", LOG_LEVEL_NOTICE);
                    void replicator.close();
                },
            });
            host.services.API.addCommand({
                id: "replicate-now-by-p2p",
                name: "Replicate now by P2P",
                checkCallback: (isChecking: boolean) => {
                    const settings = host.services.setting.currentSettings();
                    if (isChecking) {
                        if (settings.remoteType == REMOTE_P2P) return false;
                        return replicator.server?.isServing ?? false;
                    }
                    void replicator.replicateFromCommand(false);
                },
            });
            host.services.API.addRibbonIcon("waypoints", "P2P Replicator", () => {
                void openPane();
            })?.addClass?.("livesync-ribbon-replicate-p2p");

            return Promise.resolve(true);
        });
    }

    return { replicator, p2pLogCollector, storeP2PStatusLine };
}
