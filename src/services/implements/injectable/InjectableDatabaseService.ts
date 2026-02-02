import type { SimpleStore } from "octagonal-wheels/databases/SimpleStoreBase";
import { DatabaseService } from "../../base/DatabaseService";
import type { IDatabaseService } from "../../base/IService";
import type { ServiceContext } from "../../base/ServiceBase";
import { handlers } from "../../lib/HandlerUtils";

export abstract class InjectableDatabaseService<T extends ServiceContext> extends DatabaseService<T> {
    // _throughHole: ThroughHole;
    createPouchDBInstance = handlers<IDatabaseService>().binder("createPouchDBInstance") as (<T extends object>(
        name?: string,
        options?: PouchDB.Configuration.DatabaseConfiguration
    ) => PouchDB.Database<T>) & {
        setHandler: (handler: IDatabaseService["createPouchDBInstance"], override?: boolean) => void;
    };
    abstract openSimpleStore<T>(kind: string): SimpleStore<T>;

    openDatabase = handlers<IDatabaseService>().binder("openDatabase");
    resetDatabase = handlers<IDatabaseService>().binder("resetDatabase");
    isDatabaseReady = handlers<IDatabaseService>().binder("isDatabaseReady");
}
