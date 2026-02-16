import type { IDatabaseService, openDatabaseParameters } from "./IService";
import { ServiceBase, type ServiceContext } from "./ServiceBase";
import type { LiveSyncManagers } from "../../managers/LiveSyncManagers";
import type { LiveSyncLocalDB } from "../../pouchdb/LiveSyncLocalDB";

/**
 * The DatabaseService provides methods for managing the local database.
 * Please note that each event of database lifecycle is handled in DatabaseEventService.
 */
export abstract class DatabaseService<T extends ServiceContext = ServiceContext>
    extends ServiceBase<T>
    implements IDatabaseService
{
    abstract get localDatabase(): LiveSyncLocalDB;
    abstract get managers(): LiveSyncManagers;
    /**
     * Create a new PouchDB instance.
     * @param name Optional name for the database instance.
     * @param options Optional configuration options for the database.
     */
    abstract createPouchDBInstance<T extends object>(
        name?: string,
        options?: PouchDB.Configuration.DatabaseConfiguration
    ): PouchDB.Database<T>;

    // Additional process when opening database, such as initializing managers or local database instance.
    abstract onOpenDatabase(vaultName: string): Promise<void>;
    /**
     * Open the local database.
     */
    abstract openDatabase(params: openDatabaseParameters): Promise<boolean>;

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
