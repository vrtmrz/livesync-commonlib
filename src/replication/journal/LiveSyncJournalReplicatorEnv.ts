// import type { IServiceHub } from "@lib/services/base/IService";
import type { LiveSyncReplicatorEnv } from "@lib/replication/LiveSyncAbstractReplicator";

// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- We want this to be extendable in the future without breaking changes.
export interface LiveSyncJournalReplicatorEnv extends LiveSyncReplicatorEnv {
    // simpleStore: SimpleStore<CheckPointInfo | any>;
    // $$customFetchHandler: () => FetchHttpHandler | undefined;
    // services: IServiceHub;
}
