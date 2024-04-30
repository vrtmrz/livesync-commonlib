// Due to strict constraints, they may have to be hidden once in order to save memory,

import type { SimpleStore } from "./utils";

export const PREFIX_TRENCH = "trench"
export const PREFIX_EPHEMERAL = "ephemeral"
export const PREFIX_PERMANENT = "permanent"
let idx = 0;
let series = `${Date.now()}`;
function generateId(prefix: string) {
    idx++
    if (idx > 10000) {
        series = `${Date.now()}`;
        idx = 0;
    }
    const paddedIdx = idx + 10000000;
    return `${PREFIX_TRENCH}-${prefix}-${series}-${paddedIdx}`;
}

function createRange(prefix: string, series: string) {
    return [`${PREFIX_TRENCH}-${prefix}-${series}-`, `${PREFIX_TRENCH}-${prefix}-${series}.`];
}
function createId(prefix: string, series: string, idx: number) {
    const paddedIdx = idx + 10000000;
    return `${PREFIX_TRENCH}-${prefix}-${series}-${paddedIdx}`;
}

const indexes = new Map<string, number>();
export type Evacuated<T> = () => Promise<T>

const inProgress = new Set<string>();
const failed = new Map<string, number>();

export class Trench {
    _db: SimpleStore<any>;
    _flushTask: Promise<void> | undefined = undefined;
    constructor(db: SimpleStore<any>, flushExistItems = true) {
        this._db = db;
        if (flushExistItems) {
            this._flushTask = (async () => {
                const keys = await db.keys(`${PREFIX_TRENCH}-${PREFIX_EPHEMERAL}`, `${PREFIX_TRENCH}-${PREFIX_EPHEMERAL}.`);
                for (const key of keys) {
                    await db.delete(key);
                }
            })()
        }
    }

    async eraseAllEphemerals() {
        const keys = await this._db.keys(`${PREFIX_TRENCH}-${PREFIX_EPHEMERAL}`, `${PREFIX_TRENCH}-${PREFIX_EPHEMERAL}.`);
        for (const key of keys) {
            await this._db.delete(key);
        }
    }

    async eraseAllPermanences() {
        const keys = await this._db.keys(`${PREFIX_TRENCH}-${PREFIX_PERMANENT}`, `${PREFIX_TRENCH}-${PREFIX_PERMANENT}.`);
        for (const key of keys) {
            await this._db.delete(key);
        }
    }

    async conceal<T>(obj: T) {
        const key = generateId(PREFIX_EPHEMERAL);
        await this._db.set(key, obj);
        return key;
    }
    async expose<T>(key: string) {
        const obj = await this._db.get(key) as T;
        await this._db.delete(key);
        return obj;
    }
    _evacuate<T>(storeTask: Promise<void>, key: string): Evacuated<T> {
        return async (): Promise<T> => {
            if (this._flushTask) {
                await this._flushTask;
                this._flushTask = undefined
            }
            await storeTask;
            const item = await this._db.get(key) as T;
            await this._db.delete(key);
            return item;
        }
    }
    evacuatePromise<T>(task: Promise<T>): Evacuated<T> {
        const key = generateId(PREFIX_EPHEMERAL);
        const storeTask = (async () => {
            const data = await task;
            await this._db.set(key, data);
        })();
        return this._evacuate(storeTask, key);
    }
    evacuate<T>(obj: T): Evacuated<T> {
        if (obj instanceof Promise) return this.evacuatePromise(obj);
        const key = generateId(PREFIX_EPHEMERAL);
        const storeTask = this._db.set(key, obj);
        return this._evacuate(storeTask, key);
    }
    async _queue<T>(type: string, key: string, obj: T, index: number | undefined) {
        if (index === undefined) {
            // Only in ephemeral, we can do this.
            index = indexes.get(key) ?? 0;
            indexes.set(key, index + 1);
        }
        // is actually only need ephemeral?
        const storeKey = createId(type, key, index);
        await this._db.set(storeKey, obj);
    }
    async _dequeue<T>(type: string, key: string) {
        const range = createRange(type, key);
        const keys = (await this._db.keys(range[0], range[1])).filter(e => !inProgress.has(e));
        if (keys.length === 0) return undefined;
        return await this.expose<T>(keys[0]);
    }
    async _dequeueWithCommit<T>(type: string, key: string) {
        const range = createRange(type, key);
        const keysAll = (await this._db.keys(range[0], range[1]))
        const keys = keysAll.filter(e => !inProgress.has(e));
        if (keys.length === 0) return undefined;
        const storeKey = keys[0];
        inProgress.add(storeKey);
        const previousFailed = failed.get(storeKey) || 0;
        const value = await this._db.get(storeKey) as T;
        return {
            key: storeKey,
            value,
            cancelCount: previousFailed,
            pendingItems: keysAll.length - 1,
            commit: async () => {
                await this._db.delete(storeKey);
                failed.delete(storeKey);
                inProgress.delete(storeKey);
            },
            cancel: () => {
                failed.set(storeKey, (failed.get(storeKey) || 0) + 1);
                inProgress.delete(storeKey);
            }
        }
    }

    async queue<T>(key: string, obj: T, index?: number) {
        return this._queue<T>(PREFIX_EPHEMERAL, key, obj, index);
    }
    async dequeue<T>(key: string) {
        return this._dequeue<T>(PREFIX_EPHEMERAL, key);
    }
    async dequeueWithCommit<T>(key: string) {
        return this._dequeueWithCommit<T>(PREFIX_EPHEMERAL, key);
    }
    async queuePermanent<T>(key: string, obj: T, index?: number) {
        return this._queue<T>(PREFIX_PERMANENT, key, obj, index);
    }
    async dequeuePermanent<T>(key: string) {
        return this._dequeue<T>(PREFIX_PERMANENT, key);
    }
    async dequeuePermanentWithCommit<T>(key: string) {
        return this._dequeueWithCommit<T>(PREFIX_PERMANENT, key);
    }

}

