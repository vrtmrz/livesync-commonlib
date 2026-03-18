/**
 * Obsoleted: separated into non-UI things and UI things.
 */
import { AutoAccepting, REMOTE_P2P } from "../../common/types";
import { reactiveSource } from "octagonal-wheels/dataobject/reactive";
import { EVENT_REQUEST_OPEN_P2P } from "../../events/coreEvents";
import { eventHub } from "../../hub/hub";
import { LiveSyncTrysteroReplicator, type LiveSyncTrysteroReplicatorEnv } from "./LiveSyncTrysteroReplicator";
import type { NecessaryServices } from "@lib/interfaces/ServiceModule";
import { Logger, LOG_LEVEL_NOTICE, LOG_LEVEL_VERBOSE } from "../../common/logger";
import { P2PLogCollector } from "./P2PLogCollector";
import { addP2PEventHandlers } from "./addP2PEventHandlers";
import type { P2PPaneParams } from "./UseP2PReplicatorResult";

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
): P2PPaneParams {
    const env: LiveSyncTrysteroReplicatorEnv = { services: host.services as any };
    let replicator = new LiveSyncTrysteroReplicator(env);
    const activeReplicator = {
        get instance() {
            return replicator;
        },
    };
    addP2PEventHandlers(activeReplicator.instance);

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
    host.services.replicator.getNewReplicator.addHandler(async (settingOverride: Partial<any> = {}) => {
        const settings = { ...host.services.setting.currentSettings(), ...settingOverride };
        if (settings.remoteType == REMOTE_P2P) {
            // Returning replicator instance directly here
            // return Promise.resolve(replicator);
            try {
                await replicator.close();
            } catch (e) {
                Logger(`Error closing existing p2p replicator`);
                Logger(e, LOG_LEVEL_VERBOSE);
            }
            const newReplicator = new LiveSyncTrysteroReplicator({ services: host.services as any });
            replicator = newReplicator; // Update the replicator reference for lifecycle handlers
            return Promise.resolve(replicator);
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
