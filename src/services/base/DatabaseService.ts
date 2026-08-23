import type { IDatabaseService, IPathService, IVaultService, openDatabaseParameters } from "./IService";
import { ServiceBase, type ServiceContext } from "./ServiceBase";
import { LiveSyncLocalDB } from "@lib/pouchdb/LiveSyncLocalDB";
import { handlers } from "@lib/services/lib/HandlerUtils";
import { createInstanceLogFunction } from "@lib/services/lib/logUtils.ts";
import type PouchDB from "pouchdb-core";
import type { PouchDBConstructor } from "@lib/pouchdb/PouchDBConstructor.ts";
import { ExtraSuffixIndexedDB } from "@lib/common/models/shared.const.ts";
import type { SettingService } from "./SettingService";
import type { APIService } from "./APIService";
import type { ObsidianLiveSyncSettings } from "@lib/common/models/setting.type";

export type DatabaseServiceDependencies = {
    /** PouchDB with the adapters required by the host runtime already registered. */
    pouchDB: PouchDBConstructor;
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

    /** Called after the active database has been reset and successfully reinitialised. */
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

    protected modifyDatabaseOptions(
        settings: ObsidianLiveSyncSettings,
        name: string,
        options: PouchDB.Configuration.DatabaseConfiguration
    ): {
        name: string;
        options: PouchDB.Configuration.DatabaseConfiguration;
    } {
        const optionPass = { ...options };
        if (settings.useIndexedDBAdapter) {
            optionPass.adapter = "indexeddb";
            //@ts-ignore :missing def
            optionPass.purged_infos_limit = 1;
            return {
                name: name + ExtraSuffixIndexedDB,
                options: optionPass,
            };
        }
        return {
            name: name,
            options: optionPass,
        };
    }

    createPouchDBInstance<T extends object>(
        name?: string,
        options?: PouchDB.Configuration.DatabaseConfiguration
    ): PouchDB.Database<T> {
        const settings = this.services.setting.currentSettings();
        const optionPass = this.modifyDatabaseOptions(settings, name ?? "", options ?? {});
        return new this.services.pouchDB(optionPass.name, optionPass.options);
    }

    async openDatabase(params: openDatabaseParameters): Promise<boolean> {
        if (this._localDatabase != null) {
            await this._localDatabase.close();
        }
        const vaultName = this.services.vault.getVaultName();
        this._log(this.context.translate("moduleLocalDatabase.logWaitingForReady"));
        const env = {
            services: {
                context: this.context,
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
        if (!(await this._localDatabase.resetDatabase())) {
            return false;
        }
        return await this.onDatabaseReset();
    }

    /**
     * Reset the database selected by the current settings.
     *
     * A `LiveSyncLocalDB` captures its name when constructed, so changing a
     * suffix does not retarget the active instance. This operation selects and
     * opens the settings-derived database before resetting it when necessary.
     * The formerly active physical database is closed but not destroyed.
     */
    async resetDatabaseForCurrentSettings(params: openDatabaseParameters): Promise<boolean> {
        const selectedDatabaseName = this.services.vault.getVaultName();
        if (this._localDatabase?.dbname !== selectedDatabaseName) {
            if (!(await this.openDatabase(params))) {
                return false;
            }
            if (this._localDatabase?.dbname !== selectedDatabaseName) {
                return false;
            }
        }
        return await this.resetDatabase();
    }
}
