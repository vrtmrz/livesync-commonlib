// import { AbstractModule } from "../AbstractModule";
import { PouchDB } from "@lib/pouchdb/pouchdb-browser";
// import type { LiveSyncCore } from "../../main";
// import { ExtraSuffixIndexedDB } from "../../lib/src/common/types";
import { DatabaseService } from "../../base/DatabaseService";
import type {
    IDatabaseService,
    IPathService,
    ISettingService,
    IVaultService,
    openDatabaseParameters,
} from "../../base/IService";
import type { ServiceContext } from "../../base/ServiceBase";
import { handlers } from "../../lib/HandlerUtils";
import { LiveSyncLocalDB } from "@/lib/src/pouchdb/LiveSyncLocalDB";
import { createInstanceLogFunction } from "../../lib/logUtils";
import { LiveSyncManagers } from "@/lib/src/managers/LiveSyncManagers";
import { $msg } from "@/lib/src/common/i18n";
import { ExtraSuffixIndexedDB } from "@/lib/src/common/models/shared.const";

export type DatabaseServiceDependencies = {
    path: IPathService;
    vault: IVaultService;
    setting: ISettingService;
};

export abstract class InjectableDatabaseService<T extends ServiceContext> extends DatabaseService<T> {
    _log = createInstanceLogFunction("InjectableDatabaseService");

    protected _localDatabase: LiveSyncLocalDB | null = null;
    protected _managers: LiveSyncManagers | null = null;

    protected services: DatabaseServiceDependencies;

    constructor(context: T, dependencies: DatabaseServiceDependencies) {
        super(context);
        this.services = dependencies;
    }

    get localDatabase() {
        if (!this._localDatabase) {
            throw new Error("Local database is not ready yet.");
        }
        return this._localDatabase;
    }
    get managers() {
        if (!this._managers) {
            throw new Error("Managers are not ready yet.");
        }
        return this._managers;
    }

    resetDatabase = handlers<IDatabaseService>().binder("resetDatabase");

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
        const getDB = () => this.localDatabase.localDatabase;
        const getSettings = () => this.services.setting.currentSettings();
        this._managers = new LiveSyncManagers({
            get database() {
                return getDB();
            },
            getActiveReplicator: () => params.replicator.getActiveReplicator()!,
            id2path: this.services.path.id2path.bind(this.services.path),
            path2id: this.services.path.path2id.bind(this.services.path),
            get settings() {
                return getSettings();
            },
        });
        const env = {
            services: {
                ...this.services,
                ...params,
                database: this,
            },
            managers: this.managers,
        };
        this._localDatabase = new LiveSyncLocalDB(vaultName, env);
        await this.onOpenDatabase(vaultName);

        return await this.localDatabase.initializeDatabase();
    }

    isDatabaseReady(): boolean {
        return this._localDatabase != null && this._localDatabase.isReady;
    }
}
