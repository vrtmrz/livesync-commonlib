import type { SimpleStore } from "octagonal-wheels/databases/SimpleStoreBase";
import type { ServiceContext } from "../../base/ServiceBase";
import { InjectableDatabaseService } from "../injectable/InjectableDatabaseService";
import { SimpleStoreIDBv2 } from "octagonal-wheels/databases/SimpleStoreIDBv2";

export class BrowserDatabaseService<T extends ServiceContext> extends InjectableDatabaseService<T> {
    openSimpleStore<T>(kind: string) {
        return SimpleStoreIDBv2.open<T>(kind) as SimpleStore<T>;
    }
}
