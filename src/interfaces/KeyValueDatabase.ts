export interface KeyValueDatabase {
    get<T>(key: IDBValidKey): Promise<T>;
    set<T>(key: IDBValidKey, value: T): Promise<IDBValidKey>;
    del(key: IDBValidKey): Promise<void>;
    clear(): Promise<void>;
    keys(query?: IDBValidKey | IDBKeyRange, count?: number): Promise<IDBValidKey[]>;
    close(): Promise<void>;
    destroy(): Promise<void>;
}

/** Opens the key-value database owned by one service composition. */
export type KeyValueDatabaseFactory = (databaseKey: string) => Promise<KeyValueDatabase>;
