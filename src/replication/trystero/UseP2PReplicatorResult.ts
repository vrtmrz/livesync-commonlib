import type { ReactiveSource } from "octagonal-wheels/dataobject/reactive_v2";
import type { LiveSyncTrysteroReplicator } from "./LiveSyncTrysteroReplicator";
import type { P2PLogCollector } from "./P2PLogCollector";

export type UseP2PReplicatorResult = {
    /**
     * The current replicator selected by the host lifecycle.
     *
     * Read this property at the point of use. Retaining a destructured value
     * across settings or database lifecycle events can target a closed,
     * replaced instance.
     */
    readonly replicator: LiveSyncTrysteroReplicator;
};
export type P2PPaneParams = {
    /** Current replicator; preserve the result object so its getter remains live. */
    readonly replicator: LiveSyncTrysteroReplicator;
    p2pLogCollector: P2PLogCollector;
    storeP2PStatusLine: ReactiveSource<string>;
};
