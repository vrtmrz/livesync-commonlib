/**
 * Compatibility composition for the former combined P2P feature.
 *
 * Replicator ownership and lifecycle now belong exclusively to
 * `useP2PReplicatorFeature`. This wrapper retains the former optional view
 * registration and return shape for downstream callers.
 */
import { REMOTE_P2P } from "@lib/common/types";
import { reactiveSource } from "octagonal-wheels/dataobject/reactive_v2";
import { EVENT_REQUEST_OPEN_P2P } from "@lib/events/coreEvents";
import type { NecessaryServices } from "@lib/interfaces/ServiceModule";
import { P2PLogCollector } from "./P2PLogCollector";
import type { P2PPaneParams } from "./UseP2PReplicatorResult";
import { useP2PReplicatorCommands } from "./useP2PReplicatorCommands";
import { useP2PReplicatorFeature } from "./useP2PReplicatorFeature";

export type P2PViewFactory = (leaf: unknown) => unknown;

/**
 * @deprecated Compose `useP2PReplicatorFeature` with host-specific commands
 * and UI instead. This wrapper remains for source compatibility.
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
        | "replicator"
        | "remote",
        never
    >,
    viewTypeAndFactory?: [viewType: string, factory: P2PViewFactory]
): P2PPaneParams {
    const activeReplicator = useP2PReplicatorFeature(host);
    const events = host.services.context.events;
    const p2pLogCollector = new P2PLogCollector(events);
    const storeP2PStatusLine = reactiveSource("");
    p2pLogCollector.p2pReplicationLine.onChanged((line) => {
        storeP2PStatusLine.value = line.value;
    });

    if (viewTypeAndFactory) {
        const [viewType, factory] = viewTypeAndFactory;
        const openPane = () => host.services.API.showWindow(viewType);
        useP2PReplicatorCommands(host, activeReplicator);

        host.services.appLifecycle.onInitialise.addHandler(() => {
            host.services.API.registerWindow(viewType, factory);
            events.onEvent(EVENT_REQUEST_OPEN_P2P, () => void openPane());

            host.services.API.addCommand({
                id: "open-p2p-replicator",
                name: "P2P Sync : Open P2P Replicator",
                callback: () => void openPane(),
            });
            host.services.API.addCommand({
                id: "replicate-now-by-p2p",
                name: "Replicate now by P2P",
                checkCallback: (isChecking: boolean) => {
                    const replicator = activeReplicator.replicator;
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
            })?.classList.add("livesync-ribbon-replicate-p2p");

            return Promise.resolve(true);
        });
    }

    return {
        get replicator() {
            return activeReplicator.replicator;
        },
        p2pLogCollector,
        storeP2PStatusLine,
    };
}
