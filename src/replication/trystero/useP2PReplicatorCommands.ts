import { Logger, LOG_LEVEL_NOTICE } from "octagonal-wheels/common/logger";
import type { NecessaryServices } from "@lib/interfaces/ServiceModule";
import type { P2PServiceViews } from "@lib/p2p/P2PService";

/**
 * Register manual transport commands against the focused lifecycle view.
 * @param host
 */
export function useP2PReplicatorCommands(
    host: NecessaryServices<"API" | "setting", never>,
    result: Pick<P2PServiceViews, "transportLifecycle">
) {
    host.services.API.addCommand({
        id: "p2p-establish-connection",
        name: "P2P Sync : Connect to the Signalling Server",
        checkCallback: (isChecking: boolean) => {
            const lifecycle = result.transportLifecycle;
            if (isChecking) return !lifecycle.isConnected;
            void lifecycle.connect();
        },
    });
    host.services.API.addCommand({
        id: "p2p-close-connection",
        name: "P2P Sync : Disconnect from the Signalling Server",
        checkCallback: (isChecking: boolean) => {
            const lifecycle = result.transportLifecycle;
            if (isChecking) return lifecycle.isConnected;
            Logger("Closing P2P Connection", LOG_LEVEL_NOTICE);
            void lifecycle.disconnect();
        },
    });
}
