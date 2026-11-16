import { withLock } from "octagonal-wheels/concurrency/lock";
import type { IDatabaseService, IPathService, IVaultService, openDatabaseParameters } from "./IService";
import { ServiceBase, type ServiceContext } from "./ServiceBase";
import { LiveSyncLocalDB } from "@lib/pouchdb/LiveSyncLocalDB";
import { handlers } from "@lib/services/lib/HandlerUtils";
import { createInstanceLogFunction } from "@lib/services/lib/logUtils.ts";
import type PouchDB from "pouchdb-core";
import type { PouchDBConstructor } from "@lib/pouchdb/PouchDBConstructor.ts";
import { ExtraSuffixIndexedDB, SuffixDatabaseName } from "@lib/common/models/shared.const.ts";
import type { SettingService } from "./SettingService";
import type { APIService } from "./APIService";
import type { ObsidianLiveSyncSettings } from "@lib/common/models/setting.type";
import { LOG_LEVEL_VERBOSE } from "@lib/common/logger";

type DatabaseSelection = {
    vaultName: string;
    name: string;
    options: PouchDB.Configuration.DatabaseConfiguration;
};

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
    private readonly databaseLock = Symbol("local-database-lifecycle");
    private closingRequested = false;
    private databaseSelection: DatabaseSelection | undefined;

    /** Observes a failed local operation; handlers must not retry that operation. */
    readonly onLocalDatabaseError = handlers<IDatabaseService>().allSettled("onLocalDatabaseError");

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

    private selectDatabase(): DatabaseSelection {
        const vaultName = this.services.vault.getVaultName();
        const resolved = this.modifyDatabaseOptions(
            this.services.setting.currentSettings(),
            vaultName + SuffixDatabaseName,
            {}
        );
        return { vaultName, ...resolved };
    }

    private isSelectedDatabase(selection: DatabaseSelection): boolean {
        const current = this.selectDatabase();
        return current.name === selection.name && current.options.adapter === selection.options.adapter;
    }

    async openDatabase(params: openDatabaseParameters): Promise<boolean> {
        return await withLock(this.databaseLock, async () => {
            this.closingRequested = false;
            return await this.openDatabaseUnlocked(params);
        });
    }

    /** Replace only the failed lifetime; a queued duplicate cannot close its replacement. */
    async reopenDatabase(database: LiveSyncLocalDB, params: openDatabaseParameters): Promise<boolean> {
        return await withLock(this.databaseLock, async () => {
            if (this.closingRequested || this._localDatabase !== database) {
                return false;
            }
            const selection = this.databaseSelection;
            if (!selection || !this.isSelectedDatabase(selection)) {
                return false;
            }
            database.isReady = false;
            if (
                params.databaseEvents?.onBeforeDatabaseRecovery &&
                !(await params.databaseEvents.onBeforeDatabaseRecovery())
            ) {
                return false;
            }
            if (this.closingRequested || this._localDatabase !== database || !this.isSelectedDatabase(selection)) {
                return false;
            }
            return await this.openDatabaseUnlocked(params, selection);
        });
    }

    /** Check only an initialised, currently owned Pouch. This does not construct a Pouch instance. */
    async canReadCurrentDatabaseInfo(): Promise<boolean> {
        const database = this._localDatabase;
        if (this.closingRequested || !database?.isReady || !database.localDatabase) {
            return false;
        }
        await database.localDatabase.info();
        return !this.closingRequested && this._localDatabase === database && database.isReady;
    }

    /** Closing participates in the same owner lock as opening and recovery. */
    async closeDatabase(): Promise<void> {
        this.closingRequested = true;
        await withLock(this.databaseLock, async () => {
            const database = this._localDatabase;
            if (database) {
                database.onunload();
                await database.close();
                if (this._localDatabase === database) {
                    this._localDatabase = null;
                }
            }
        });
    }

    private async openDatabaseUnlocked(
        params: openDatabaseParameters,
        selection = this.selectDatabase()
    ): Promise<boolean> {
        if (this._localDatabase != null) {
            await this._localDatabase.close();
        }
        const { vaultName } = selection;
        this._log(this.context.translate("moduleLocalDatabase.logWaitingForReady"));
        const env = {
            services: {
                context: this.context,
                ...this.services,
                ...params,
                database: this,
            },
        };
        const selectedDatabase = new LiveSyncLocalDB(vaultName, env, {
            createPouchDBInstance: <T extends object>(
                _name?: string,
                options?: PouchDB.Configuration.DatabaseConfiguration
            ) => new this.services.pouchDB<T>(selection.name, { ...options, ...selection.options }),
        });
        this.databaseSelection = selection;
        this._localDatabase = selectedDatabase;
        try {
            await this.onOpenDatabase(vaultName);
            const initialised = await selectedDatabase.initializeDatabase();
            if (!initialised && this._localDatabase === selectedDatabase) {
                this._localDatabase = null;
            }
            return initialised;
        } catch (error) {
            if (this._localDatabase === selectedDatabase) {
                this._localDatabase = null;
            }
            throw error;
        }
    }

    isDatabaseReady(): boolean {
        return !this.closingRequested && this._localDatabase != null && this._localDatabase.isReady;
    }

    private async discardFailedActiveDatabase(database: LiveSyncLocalDB): Promise<void> {
        if (this._localDatabase === database) {
            this._localDatabase = null;
        }
        try {
            await database.close();
        } catch (error) {
            this._log("Failed to close the active database after a rejected lifecycle transition.", LOG_LEVEL_VERBOSE);
            this._log(error, LOG_LEVEL_VERBOSE);
        }
    }

    async resetDatabase(): Promise<boolean> {
        const selected = this._localDatabase;
        return await withLock(this.databaseLock, () => {
            if (this._localDatabase !== selected) {
                return false;
            }
            return this.resetDatabaseUnlocked();
        });
    }

    private async resetDatabaseUnlocked(): Promise<boolean> {
        if (!this._localDatabase) {
            return Promise.resolve(true);
        }
        const activeDatabase = this._localDatabase;
        try {
            if (!(await activeDatabase.resetDatabase())) {
                await this.discardFailedActiveDatabase(activeDatabase);
                return false;
            }
            if (!(await this.onDatabaseReset())) {
                await this.discardFailedActiveDatabase(activeDatabase);
                return false;
            }
            return true;
        } catch (error) {
            await this.discardFailedActiveDatabase(activeDatabase);
            throw error;
        }
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
