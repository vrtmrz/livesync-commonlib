import { Logger, LOG_LEVEL_NOTICE } from "octagonal-wheels/common/logger";
import type { NecessaryServices } from "@lib/interfaces/ServiceModule";
import type { UseP2PReplicatorResult } from "./UseP2PReplicatorResult";

/**
 * ServiceFeature: Registers event handlers for P2P replication and manages the lifecycle of a LiveSyncTrysteroReplicator instance.
 * @param host
 */
export function useP2PReplicatorCommands(
    host: NecessaryServices<"API" | "setting", never>,
    result: UseP2PReplicatorResult
) {
    host.services.API.addCommand({
        id: "p2p-establish-connection",
        name: "P2P Sync : Connect to the Signalling Server",
        checkCallback: (isChecking: boolean) => {
            const replicator = result.replicator;
            if (!replicator) return false;
            if (isChecking) return !(replicator.server?.isServing ?? false);
            void replicator.open();
        },
    });
    host.services.API.addCommand({
        id: "p2p-close-connection",
        name: "P2P Sync : Disconnect from the Signalling Server",
        checkCallback: (isChecking: boolean) => {
            const replicator = result.replicator;
            if (!replicator) return false;
            if (isChecking) return replicator.server?.isServing ?? false;
            Logger("Closing P2P Connection", LOG_LEVEL_NOTICE);
            void replicator.close();
        },
    });
}
