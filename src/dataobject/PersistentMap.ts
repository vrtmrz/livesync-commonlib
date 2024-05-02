/**
 * The Map, which can keep the data.
 */

import { scheduleTask } from "../concurrency/task.ts";

const YieldOperationNumbers = 100;

export class PersistentMap<T> {
    _setCount = YieldOperationNumbers;
    _map: Map<string, T>;
    _key: string;

    flush() {
        this.#_save();
    }
    #_save() {
        localStorage.setItem(this._key, JSON.stringify([...this._map.entries()]))
    }
    #_load(suppliedEntries: readonly (readonly [string, T])[] = []) {
        try {
            const savedSource = localStorage.getItem(this._key) ?? "";
            const sourceToParse = (savedSource === "") ? "[]" : savedSource;
            const obj = JSON.parse(sourceToParse) as [string, T][];
            this._map = new Map([...obj, ...suppliedEntries]);
        } catch (ex) {
            console.log(`Map read error : ${this._key}`);
            console.dir(ex);
            this._map = new Map([...suppliedEntries]);
        }
        return Promise.resolve();
    }
    #_queueSave() {
        this._setCount--;
        // If we had processed too many operation while in the short time, save once.
        if (this._setCount < 0) {
            this._setCount = YieldOperationNumbers;
            scheduleTask(`save-map-${this._key}`, 0, () => this.#_save());
        }
        // Or schedule saving.
        scheduleTask(`save-map-${this._key}`, 150, () => this.#_save());
    }
    delete(key: string) {
        const ret = this._map.delete(key);
        this.#_queueSave();
        return ret;
    }
    has(key: string) {
        return this._map.has(key);
    }
    set(key: string, value: T) {
        this._map.set(key, value);
        this.#_queueSave();
        return this;
    }

    clear() {
        this._map = new Map();
        this.#_save();
    }
    get(key: string, defValue?: T): T | undefined {
        const v = this._map.get(key);
        if (v === undefined) return defValue;
        return v;
    }
    constructor(key: string, entries?: readonly (readonly [string, T])[]) {
        this._key = key;
        this._map = new Map(entries ?? []);
        this.#_load(entries)
    }
    // get ready():Promise<boolean>{

    // }

}