import type { LOG_LEVEL } from "octagonal-wheels/common/logger";
import type { SimpleStore } from "octagonal-wheels/databases/SimpleStoreBase";
import type { ReactiveSource } from "octagonal-wheels/dataobject/reactive_v2";
import type { P2PSyncSetting, EntryDoc } from "../../common/types";
import type { Confirm } from "../../interfaces/Confirm";
import type { InjectableServiceHub } from "../../services/InjectableServices";

export interface P2PReplicatorBase {
    storeP2PStatusLine: ReactiveSource<string>;
    settings: P2PSyncSetting;
    _log(msg: any, level?: LOG_LEVEL): void;
    _notice(msg: any, key?: string): void;

    getSettings(): P2PSyncSetting;
    getDB: () => PouchDB.Database<EntryDoc>;
    confirm: Confirm;
    simpleStore(): SimpleStore<any>;
    handleReplicatedDocuments(docs: EntryDoc[]): Promise<boolean>;
    init(): Promise<this>;

    services: InjectableServiceHub;
}
