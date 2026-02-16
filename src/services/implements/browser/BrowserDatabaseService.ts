import type { ServiceContext } from "../../base/ServiceBase";
import { InjectableDatabaseService } from "../injectable/InjectableDatabaseService";
import { KeyValueDBService } from "../../base/KeyValueDBService";

export class BrowserDatabaseService<T extends ServiceContext> extends InjectableDatabaseService<T> {
    onOpenDatabase(vaultName: string): Promise<void> {
        return Promise.resolve();
    }
}

export class BrowserKeyValueDBService<T extends ServiceContext> extends KeyValueDBService<T> {}
