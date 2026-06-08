import type { IServiceHub } from "../../services/base/IService";
import type { LiveSyncReplicatorEnv } from "../LiveSyncAbstractReplicator";

export interface LiveSyncJournalReplicatorEnv extends LiveSyncReplicatorEnv {
    // simpleStore: SimpleStore<CheckPointInfo | any>;
    // $$customFetchHandler: () => FetchHttpHandler | undefined;
    services: IServiceHub;
}
