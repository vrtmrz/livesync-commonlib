import { KeyValueDBService } from "../../base/KeyValueDBService";
import type { ServiceContext } from "../../base/ServiceBase";
import { InjectableDatabaseService } from "../injectable/InjectableDatabaseService";

export class HeadlessDatabaseService<T extends ServiceContext> extends InjectableDatabaseService<T> {
    onOpenDatabase(vaultName: string): Promise<void> {
        return Promise.resolve();
    }
}

export class HeadlessKeyValueDBService<T extends ServiceContext> extends KeyValueDBService<T> {}
