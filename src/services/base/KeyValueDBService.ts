import type { SimpleStore } from "@lib/common/utils";
import type { IKeyValueDBService, IVaultService } from "./IService";
import { ServiceBase, type ServiceContext } from "./ServiceBase";
import type { KeyValueDatabase } from "../../interfaces/KeyValueDatabase";
import { OpenKeyValueDatabase } from "@/common/KeyValueDB";
import { delay, yieldMicrotask } from "octagonal-wheels/promises";
import { LOG_LEVEL_NOTICE, LOG_LEVEL_VERBOSE } from "../../common/logger";
import { createInstanceLogFunction } from "../lib/logUtils";
import type { InjectableDatabaseEventService } from "../implements/injectable/InjectableDatabaseEventService";
import type { AppLifecycleServiceBase } from "../implements/injectable/InjectableAppLifecycleService";

export interface KeyValueDBDependencies<T extends ServiceContext = ServiceContext> {
    databaseEvents: InjectableDatabaseEventService<T>;
    vault: IVaultService;
    appLifecycle: AppLifecycleServiceBase<T>;
}
/**
 * The KeyValueDBService provides methods for managing the local key-value database.
 * Please note that each event of database lifecycle is handled in DatabaseEventService.
 */
export abstract class KeyValueDBService<T extends ServiceContext = ServiceContext>
    extends ServiceBase<T>
    implements IKeyValueDBService
{
    private _kvDB: KeyValueDatabase | undefined;
    private _simpleStore: SimpleStore<any> | undefined;
    get simpleStore() {
        if (!this._simpleStore) {
            throw new Error("SimpleStore is not initialized yet");
        }
        return this._simpleStore;
    }
    get kvDB() {
        if (!this._kvDB) {
            throw new Error("KeyValueDB is not initialized yet");
        }
        return this._kvDB;
    }

    private databaseEvents: InjectableDatabaseEventService<T>;
    private vault: IVaultService;
    private appLifecycle: AppLifecycleServiceBase<T>;
    private _log = createInstanceLogFunction("KeyValueDBService");

    private async _everyOnResetDatabase(any: unknown): Promise<boolean> {
        try {
            const kvDBKey = "queued-files";
            await this._kvDB?.del(kvDBKey);
            // localStorage.removeItem(lsKey);
            await this._kvDB?.destroy();
            await yieldMicrotask();
            this._kvDB = await OpenKeyValueDatabase(this.vault.getVaultName() + "-livesync-kv");
            await delay(100);
        } catch (e) {
            this._kvDB = undefined!;
            this._log("Failed to reset KeyValueDB", LOG_LEVEL_NOTICE);
            this._log(e, LOG_LEVEL_VERBOSE);
            return false;
        }
        return true;
    }

    private async tryCloseKvDB() {
        try {
            await this._kvDB?.close();
            return true;
        } catch (e) {
            this._log("Failed to close KeyValueDB", LOG_LEVEL_VERBOSE);
            this._log(e);
            return false;
        }
    }
    private async openKeyValueDB(): Promise<boolean> {
        await delay(10);
        try {
            await this.tryCloseKvDB();
            await delay(10);
            await yieldMicrotask();
            this._kvDB = await OpenKeyValueDatabase(this.vault.getVaultName() + "-livesync-kv");
            await yieldMicrotask();
            await delay(100);
        } catch (e) {
            this._kvDB = undefined!;
            this._log("Failed to open KeyValueDB", LOG_LEVEL_NOTICE);
            this._log(e, LOG_LEVEL_VERBOSE);
            return false;
        }
        return true;
    }
    // Called when another database; LiveSyncLocalDB, is being unloaded.
    // We need to close our KeyValueDB to avoid IndexedDB locking issues.
    private async _onOtherDatabaseUnload() {
        if (this._kvDB) await this.tryCloseKvDB();
        return Promise.resolve(true);
    }
    // Also, Called when another database; LiveSyncLocalDB, is being closed.
    // We need to close our KeyValueDB to avoid IndexedDB locking issues.
    private async _onOtherDatabaseClose() {
        if (this._kvDB) await this.tryCloseKvDB();
        return Promise.resolve(true);
    }

    private _everyOnInitializeDatabase(any: unknown): Promise<boolean> {
        return this.openKeyValueDB();
    }

    private async _everyOnloadAfterLoadSettings(): Promise<boolean> {
        if (!(await this.openKeyValueDB())) {
            return false;
        }
        this._simpleStore = this.openSimpleStore<any>("os");
        return Promise.resolve(true);
    }

    constructor(context: T, dependencies: KeyValueDBDependencies<T>) {
        super(context);
        this.databaseEvents = dependencies.databaseEvents;
        this.vault = dependencies.vault;
        this.appLifecycle = dependencies.appLifecycle;
        this.databaseEvents.onResetDatabase.addHandler(this._everyOnResetDatabase.bind(this));
        this.appLifecycle.onSettingLoaded.addHandler(this._everyOnloadAfterLoadSettings.bind(this));
        this.databaseEvents.onDatabaseInitialisation.addHandler(this._everyOnInitializeDatabase.bind(this));
        this.databaseEvents.onUnloadDatabase.addHandler(this._onOtherDatabaseUnload.bind(this));
        this.databaseEvents.onCloseDatabase.addHandler(this._onOtherDatabaseClose.bind(this));
    }

    openSimpleStore<T>(kind: string) {
        const getDB = () => {
            if (!this._kvDB) {
                throw new Error("KeyValueDB is not initialized yet");
            }
            return this._kvDB;
        };
        const prefix = `${kind}-`;
        return {
            get: async (key: string): Promise<T> => {
                return await getDB().get(`${prefix}${key}`);
            },
            set: async (key: string, value: any): Promise<void> => {
                await getDB().set(`${prefix}${key}`, value);
            },
            delete: async (key: string): Promise<void> => {
                await getDB().del(`${prefix}${key}`);
            },
            keys: async (
                from: string | undefined,
                to: string | undefined,
                count?: number | undefined
            ): Promise<string[]> => {
                const ret = await getDB().keys(
                    IDBKeyRange.bound(`${prefix}${from || ""}`, `${prefix}${to || ""}`),
                    count
                );
                return ret
                    .map((e) => e.toString())
                    .filter((e) => e.startsWith(prefix))
                    .map((e) => e.substring(prefix.length));
            },
            db: Promise.resolve(getDB()),
        } satisfies SimpleStore<T>;
    }
}
