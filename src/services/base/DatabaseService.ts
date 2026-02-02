import type { SimpleStore } from "@lib/common/utils";
import type { IDatabaseService } from "./IService";
import { ServiceBase, type ServiceContext } from "./ServiceBase";

/**
 * The DatabaseService provides methods for managing the local database.
 * Please note that each event of database lifecycle is handled in DatabaseEventService.
 */
export abstract class DatabaseService<T extends ServiceContext = ServiceContext>
    extends ServiceBase<T>
    implements IDatabaseService
{
    /**
     * Create a new PouchDB instance.
     * @param name Optional name for the database instance.
     * @param options Optional configuration options for the database.
     */
    abstract createPouchDBInstance<T extends object>(
        name?: string,
        options?: PouchDB.Configuration.DatabaseConfiguration
    ): PouchDB.Database<T>;

    /**
     * Open the local database.
     */
    abstract openDatabase(): Promise<boolean>;

    /**
     * Open a simple store for storing key-value pairs.
     * @param kind The kind of simple store to open.
     */
    abstract openSimpleStore<T>(kind: string): SimpleStore<T>;

    /**
     * Discard the local database.
     * Please note that this *DOES* delete the database contents perfectly.
     */
    abstract resetDatabase(): Promise<boolean>;

    /**
     * Check if the local database is ready.
     */
    abstract isDatabaseReady(): boolean;
}
