import { deleteDB, openDB, type IDBPDatabase } from "idb";
import { serialized } from "octagonal-wheels/concurrency/lock";

import { LOG_LEVEL_VERBOSE, Logger } from "@lib/common/logger";
import type { KeyValueDatabase, KeyValueDatabaseFactory } from "@lib/interfaces/KeyValueDatabase";

/** Creates an IndexedDB factory with a cache owned by the caller. */
export function createIndexedDBKeyValueDatabaseFactory(): KeyValueDatabaseFactory {
    const databaseCache = new Map<string, IndexedDBKeyValueDatabase>();

    return async (databaseKey: string): Promise<KeyValueDatabase> =>
        await serialized(`OpenKeyValueDatabase-${databaseKey}`, async () => {
            const cachedDatabase = databaseCache.get(databaseKey);
            if (cachedDatabase) {
                if (!cachedDatabase.isDestroyed) return cachedDatabase;
                await cachedDatabase.ensuredDestroyed;
                databaseCache.delete(databaseKey);
            }

            const database = new IndexedDBKeyValueDatabase(databaseKey);
            try {
                await database.getIsReady();
                databaseCache.set(databaseKey, database);
                return database;
            } catch (error) {
                databaseCache.delete(databaseKey);
                throw error;
            }
        });
}

/** Key-value adapter backed by one IndexedDB object store. */
export class IndexedDBKeyValueDatabase implements KeyValueDatabase {
    protected databasePromise: Promise<IDBPDatabase<unknown>> | null = null;
    protected readonly databaseKey: string;
    protected readonly storeKey: string;
    protected destroyed = false;
    protected destroyedPromise: Promise<void> | null = null;

    constructor(databaseKey: string) {
        this.databaseKey = databaseKey;
        this.storeKey = databaseKey;
    }

    get isDestroyed(): boolean {
        return this.destroyed;
    }

    get ensuredDestroyed(): Promise<void> {
        return this.destroyedPromise ?? Promise.resolve();
    }

    async getIsReady(): Promise<boolean> {
        await this.ensureDatabase();
        return !this.destroyed;
    }

    protected ensureDatabase(): Promise<IDBPDatabase<unknown>> {
        if (this.destroyed) throw new Error("Database is destroyed");
        if (this.databasePromise) return this.databasePromise;

        this.databasePromise = openDB(this.databaseKey, undefined, {
            upgrade: (database) => {
                if (!database.objectStoreNames.contains(this.storeKey)) {
                    return database.createObjectStore(this.storeKey);
                }
            },
            blocking: (currentVersion, blockedVersion) => {
                Logger(
                    `Blocking database open for ${this.databaseKey}: currentVersion=${currentVersion}, blockedVersion=${blockedVersion}`,
                    LOG_LEVEL_VERBOSE
                );
                void this.closeDatabase(true);
            },
            blocked: (currentVersion, blockedVersion) => {
                Logger(
                    `Database open blocked for ${this.databaseKey}: currentVersion=${currentVersion}, blockedVersion=${blockedVersion}`,
                    LOG_LEVEL_VERBOSE
                );
            },
            terminated: () => {
                Logger(`Database connection terminated for ${this.databaseKey}`, LOG_LEVEL_VERBOSE);
                this.databasePromise = null;
            },
        }).catch((error: unknown) => {
            this.databasePromise = null;
            throw error;
        });
        return this.databasePromise;
    }

    protected async closeDatabase(setDestroyed = false): Promise<void> {
        if (this.databasePromise) {
            const databasePromise = this.databasePromise;
            this.databasePromise = null;
            try {
                const database = await databasePromise;
                database.close();
            } catch (error) {
                Logger("Error closing database");
                Logger(error, LOG_LEVEL_VERBOSE);
            }
        }
        if (setDestroyed) {
            this.destroyed = true;
            this.destroyedPromise = Promise.resolve();
        }
    }

    protected get database(): Promise<IDBPDatabase<unknown>> {
        if (this.destroyed) return Promise.reject(new Error("Database is destroyed"));
        return this.ensureDatabase();
    }

    async get<T>(key: IDBValidKey): Promise<T> {
        return (await (await this.database).get(this.storeKey, key)) as T;
    }

    async set<T>(key: IDBValidKey, value: T): Promise<IDBValidKey> {
        await (await this.database).put(this.storeKey, value, key);
        return key;
    }

    async del(key: IDBValidKey): Promise<void> {
        await (await this.database).delete(this.storeKey, key);
    }

    async clear(): Promise<void> {
        await (await this.database).clear(this.storeKey);
    }

    async keys(query?: IDBValidKey | IDBKeyRange, count?: number): Promise<IDBValidKey[]> {
        return await (await this.database).getAllKeys(this.storeKey, query, count);
    }

    async close(): Promise<void> {
        await this.closeDatabase();
    }

    async destroy(): Promise<void> {
        this.destroyed = true;
        this.destroyedPromise = (async () => {
            await this.closeDatabase();
            await deleteDB(this.databaseKey, {
                blocked: () => Logger(`Database delete blocked for ${this.databaseKey}`),
            });
        })();
        await this.destroyedPromise;
    }
}
