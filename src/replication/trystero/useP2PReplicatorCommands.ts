import { Logger, LOG_LEVEL_NOTICE } from "octagonal-wheels/common/logger";
import { REMOTE_P2P } from "../../common/types";
import type { NecessaryServices } from "../../interfaces/ServiceModule";
import type { UseP2PReplicatorResult } from "./UseP2PReplicatorResult";

/**
 * ServiceFeature: Registers event handlers for P2P replication and manages the lifecycle of a LiveSyncTrysteroReplicator instance.
 * @param host
 */
export function useP2PReplicatorCommands(
    host: NecessaryServices<"API" | "setting", never>,
    { replicator }: UseP2PReplicatorResult
) {
    host.services.API.addCommand({
        id: "p2p-establish-connection",
        name: "P2P Sync : Connect to the Signalling Server",
        checkCallback: (isChecking: boolean) => {
            if (!replicator) return false;
            if (isChecking) return !(replicator.server?.isServing ?? false);
            void replicator.open();
        },
    });
    host.services.API.addCommand({
        id: "p2p-close-connection",
        name: "P2P Sync : Disconnect from the Signalling Server",
        checkCallback: (isChecking: boolean) => {
            if (!replicator) return false;
            if (isChecking) return replicator.server?.isServing ?? false;
            Logger("Closing P2P Connection", LOG_LEVEL_NOTICE);
            void replicator.close();
        },
    });
    host.services.API.addCommand({
        id: "replicate-now-by-p2p",
        name: "Replicate now by P2P",
        checkCallback: (isChecking: boolean) => {
            if (!replicator) return false;
            const settings = host.services.setting.currentSettings();
            if (isChecking) {
                if (settings.remoteType == REMOTE_P2P) return false;
                return replicator.server?.isServing ?? false;
            }
            void replicator.replicateFromCommand(false);
        },
    });
    host.services.API.addCommand({
        id: "force-replicate-now-by-p2p",
        name: "P2P Sync: Select peer to replicate with",
        checkCallback: (isChecking: boolean) => {
            if (!replicator) return false;
            const settings = host.services.setting.currentSettings();
            if (isChecking) {
                if (settings.remoteType == REMOTE_P2P) return false;
                return replicator.server?.isServing ?? false;
            }
            void replicator.rawReplicator?.replicateTo();
        },
    });
}
