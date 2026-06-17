import type { IServiceHub } from "@lib/services/base/IService";
import type { LiveSyncReplicatorEnv } from "@lib/replication/LiveSyncAbstractReplicator";

export interface LiveSyncJournalReplicatorEnv extends LiveSyncReplicatorEnv {
    // simpleStore: SimpleStore<CheckPointInfo | any>;
    // $$customFetchHandler: () => FetchHttpHandler | undefined;
    services: IServiceHub;
}
