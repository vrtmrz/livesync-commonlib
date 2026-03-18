import { Logger, LOG_LEVEL_VERBOSE } from "octagonal-wheels/common/logger";
import { AutoAccepting, REMOTE_P2P } from "../../common/types";
import type { NecessaryServices } from "../../interfaces/ServiceModule";
import { LiveSyncTrysteroReplicator } from "./LiveSyncTrysteroReplicator";
import { type UseP2PReplicatorResult } from "./UseP2PReplicatorResult";
import { addP2PEventHandlers } from "./addP2PEventHandlers";

/**
 * ServiceFeature: P2P Replicator integration and lifecycle management.
 * Registers a LiveSyncTrysteroReplicator instance as the active replicator when P2P is enabled in settings,
 * and binds it to lifecycle events for proper initialization and cleanup.
 * @param host
 */

export function useP2PReplicatorFeature(
    host: NecessaryServices<"API" | "setting" | "replicator" | "appLifecycle" | "databaseEvents", never>
): UseP2PReplicatorResult {
    // Replicator instance should be single and shared across the plug-in.
    let replicator: LiveSyncTrysteroReplicator = new LiveSyncTrysteroReplicator({ services: host.services as any });
    const activeReplicator = {
        get replicator() {
            return replicator;
        },
    };
    addP2PEventHandlers(activeReplicator.replicator);

    host.services.replicator.getNewReplicator.addHandler(async (settingOverride: Partial<any> = {}) => {
        const settings = { ...host.services.setting.currentSettings(), ...settingOverride };
        if (settings.remoteType == REMOTE_P2P) {
            const existingReplicator = replicator;
            try {
                await existingReplicator?.close();
            } catch (e) {
                Logger(`Error closing existing p2p replicator`);
                Logger(e, LOG_LEVEL_VERBOSE);
            }
            const newReplicator = new LiveSyncTrysteroReplicator({ services: host.services as any });
            replicator = newReplicator; // Update the replicator reference for lifecycle handlers
            return replicator;
        }
        return undefined!;
    });

    // Lifecycle bindings (replication should be closed).

    host.services.appLifecycle.onUnload.addHandler(async () => {
        await replicator?.close();
        return true;
    });

    host.services.appLifecycle.onSuspending.addHandler(async () => {
        await replicator?.close();
        return true;
    });

    host.services.databaseEvents.onDatabaseInitialisation.addHandler(async () => {
        await replicator?.close();
        return true;
    });

    // And, reopen if auto-start is enabled when app is resumed.
    host.services.appLifecycle.onResumed.addHandler(() => {
        const settings = host.services.setting.currentSettings();
        if (settings.P2P_Enabled && settings.P2P_AutoStart) {
            setTimeout(() => void replicator?.open(), 100);
        }
        return Promise.resolve(true);
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

    return activeReplicator;
}
