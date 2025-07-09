// Deno-specific implementation of SimpleStore using Deno.Kv
import type { SimpleStoreBase } from "octagonal-wheels/databases/SimpleStoreBase";
import { PlatformSimpleStore, setSimpleStoreInstance } from "../base/SimpleStore.ts";
class SimpleStoreDeno<T> implements SimpleStoreBase<T> {
    //@ts-ignore
    _kv!: Deno.Kv;
    _name: string;
    async init() {
        //@ts-ignore deno
        let dir = Deno.env.get("FILE_DIR") || "./dat";
        if (dir && !dir.endsWith("/")) {
            dir += "/";
        }
        const path = `${dir}store-kv-${this._name}`;
        //@ts-ignore
        this._kv = await Deno.openKv(path);
    }
    async _ensureInit() {
        if (!this._kv) {
            await this.init();
        }
    }
    constructor(name: string) {
        this._name = name;
    }
    clear(): Promise<void> {
        throw new Error("Method not implemented.");
    }
    close(): void {
        this._kv.close();
    }
    destroy(): Promise<void> {
        throw new Error("Method not implemented.");
    }
    async get(key: string): Promise<T | undefined> {
        await this._ensureInit();
        const keys = key.split("-");
        const ret = await this._kv.get(keys);
        if (ret === null) {
            return undefined;
        }
        if (ret.value === undefined) {
            return undefined;
        }
        return ret.value as T;
    }
    async set(key: string, value: T): Promise<void> {
        await this._ensureInit();
        const keys = key.split("-");
        await this._kv.set(keys, value);
    }
    async delete(key: string): Promise<void> {
        await this._ensureInit();
        const keys = key.split("-");
        return await this._kv.delete(keys);
    }
    async keys(from: string | undefined, to: string | undefined, count?: number): Promise<string[]> {
        await this._ensureInit();
        const keysFrom = from?.split("-") || [];
        const keysTo = to?.split("-") || [];
        const items = this._kv.list({ prefix: keysFrom, start: keysFrom, end: keysTo });
        const out = [] as string[];
        let found = 0;
        for await (const item of items) {
            found++;
            if (count && found > count) {
                break;
            }
            const outKey = item.key.join("-");
            out.push(outKey);
        }
        return out;
    }
    [Symbol.dispose](): void {
        this._kv.close();
    }
}

export class DenoSimpleStore extends PlatformSimpleStore {
    initBackend(param: string): SimpleStoreBase<any> {
        return new SimpleStoreDeno(param);
    }
}

const simpleStoreAPI = new DenoSimpleStore();
void simpleStoreAPI.onInit().then(() => setSimpleStoreInstance(simpleStoreAPI));
