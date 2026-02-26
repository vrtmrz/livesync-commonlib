import type { IDatabaseService, IPathService, IVaultService, openDatabaseParameters } from "./IService";
import { ServiceBase, type ServiceContext } from "./ServiceBase";
import { LiveSyncLocalDB } from "@lib/pouchdb/LiveSyncLocalDB";
import { handlers } from "../lib/HandlerUtils";
import { createInstanceLogFunction } from "@lib/services/lib/logUtils.ts";
import { PouchDB } from "@lib/pouchdb/pouchdb-browser.ts";
import { ExtraSuffixIndexedDB } from "@lib/common/models/shared.const.ts";
import { $msg } from "@lib/common/i18n.ts";
import type { SettingService } from "./SettingService";
import type { APIService } from "./APIService";

export type DatabaseServiceDependencies = {
    path: IPathService;
    vault: IVaultService;
    setting: SettingService;
    API: APIService;
};
/**
 * The DatabaseService provides methods for managing the local database.
 * Please note that each event of database lifecycle is handled in DatabaseEventService.
 */
export abstract class DatabaseService<T extends ServiceContext = ServiceContext>
    extends ServiceBase<T>
    implements IDatabaseService
{
    _log = createInstanceLogFunction("InjectableDatabaseService");

    constructor(context: T, dependencies: DatabaseServiceDependencies) {
        super(context);
        this.services = dependencies;
    }

    protected _localDatabase: LiveSyncLocalDB | null = null;

    protected services: DatabaseServiceDependencies;

    // Additional process when opening database, such as initialising managers or local database instance.
    onOpenDatabase = handlers<IDatabaseService>().bailFirstFailure("onOpenDatabase");

    /**
     * Called after the local database has been reset.
     */
    onDatabaseReset = handlers<IDatabaseService>().bailFirstFailure("onDatabaseReset");

    get localDatabase() {
        if (!this._localDatabase) {
            throw new Error("Local database is not ready yet.");
        }
        return this._localDatabase;
    }
    get localDatabaseDirect() {
        return this._localDatabase;
    }

    createPouchDBInstance<T extends object>(
        name?: string,
        options?: PouchDB.Configuration.DatabaseConfiguration
    ): PouchDB.Database<T> {
        const settings = this.services.setting.currentSettings();
        const optionPass = options ?? {};
        if (settings.useIndexedDBAdapter) {
            optionPass.adapter = "indexeddb";
            //@ts-ignore :missing def
            optionPass.purged_infos_limit = 1;
            return new PouchDB(name + ExtraSuffixIndexedDB, optionPass);
        }
        return new PouchDB(name, optionPass);
    }

    async openDatabase(params: openDatabaseParameters): Promise<boolean> {
        if (this._localDatabase != null) {
            await this._localDatabase.close();
        }
        const vaultName = this.services.vault.getVaultName();
        this._log($msg("moduleLocalDatabase.logWaitingForReady"));
        const env = {
            services: {
                ...this.services,
                ...params,
                database: this,
            },
        };
        this._localDatabase = new LiveSyncLocalDB(vaultName, env);
        await this.onOpenDatabase(vaultName);

        return await this.localDatabase.initializeDatabase();
    }

    isDatabaseReady(): boolean {
        return this._localDatabase != null && this._localDatabase.isReady;
    }

    async resetDatabase(): Promise<boolean> {
        if (!this._localDatabase) {
            return Promise.resolve(true);
        }
        return await this._localDatabase.resetDatabase();
    }
}
