import type { ReactiveSource } from "octagonal-wheels/dataobject/reactive_v2";
import type { LiveSyncTrysteroReplicator } from "./LiveSyncTrysteroReplicator";
import type { P2PLogCollector } from "./P2PLogCollector";
import type { P2PServiceViews } from "@lib/p2p/P2PService";

export type UseP2PReplicatorResult = P2PServiceViews & {
    /**
     * Compatibility facade retained while existing panes migrate to the
     * focused service views.
     *
     * This facade is stable for the service lifetime, but it is not the active
     * provider adapter. New consumers must request only the service view which
     * they need.
     *
     * @deprecated Use the focused P2P service views instead.
     */
    readonly replicator: LiveSyncTrysteroReplicator;
};
export type P2PPaneParams = {
    /** @deprecated Migrate panes to the focused P2P service views. */
    readonly replicator: LiveSyncTrysteroReplicator;
    p2pLogCollector: P2PLogCollector;
    storeP2PStatusLine: ReactiveSource<string>;
};
