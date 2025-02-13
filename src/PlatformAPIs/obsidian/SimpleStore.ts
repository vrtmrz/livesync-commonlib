import { SimpleStoreIDB } from "octagonal-wheels/databases/SimpleStoreIDB";

import type { ISimpleStore } from "../interfaces";
import { EVENT_APP_SUPPLIED, ObsidianAPIBase, type ObsidianInitOptions } from "./base";
import { promiseWithResolver } from "octagonal-wheels/promises";
import { eventHub } from "../../hub/hub";
import type { App } from "obsidian";
import { getPlatformAPI } from "./PlatformAPIs";
import type { SimpleStore } from "octagonal-wheels/databases/SimpleStoreBase";

export class PlatformSimpleStore extends ObsidianAPIBase implements ISimpleStore<ObsidianInitOptions> {
    _backendStore!: SimpleStoreIDB<any>;
    _isReady: boolean = false;
    _isDisposed: boolean = false;

    async onInit() {
        const app = (await getPlatformAPI()).getVaultName();
        this._backendStore = new SimpleStoreIDB(`${app}-simple-store`);
        this._isReady = true;
    }
    async onDisposed(): Promise<void> {
        this._isDisposed = true;
        await this._backendStore.close();
    }

    getSimpleStore<T>(kind: string): SimpleStore<T> {
        const prefix = `${kind}-`;
        return {
            get: async (key: string): Promise<T> => {
                return await this._backendStore.get(`${prefix}${key}`);
            },
            set: async (key: string, value: any): Promise<void> => {
                await this._backendStore.set(`${prefix}${key}`, value);
            },
            delete: async (key: string): Promise<void> => {
                await this._backendStore.delete(`${prefix}${key}`);
            },
            keys: async (
                from: string | undefined,
                to: string | undefined,
                count?: number | undefined
            ): Promise<string[]> => {
                const ret = this._backendStore.keys(`${prefix}${from || ""}`, `${prefix}${to || ""}`, count);
                return (await ret)
                    .map((e) => e.toString())
                    .filter((e) => e.startsWith(prefix))
                    .map((e) => e.substring(prefix.length));
            },
        };
    }

    async dropSimpleStore(kind: string): Promise<void> {
        const usedKeys = await this._backendStore.keys(`${kind}-`, `${kind}-\uffff`);
        for (const k of usedKeys) {
            await this._backendStore.delete(k);
        }
    }

    get isReady(): boolean {
        return this._isReady;
    }

    get isDisposed(): boolean {
        return this._isDisposed;
    }
}

const p = promiseWithResolver<PlatformSimpleStore>();
eventHub.onceEvent(EVENT_APP_SUPPLIED, (app: App) => {
    const simpleStoreAPI = new PlatformSimpleStore({ app });
    void simpleStoreAPI.onInit().then(() => p.resolve(simpleStoreAPI));
});

export function getPlatformSimpleStore() {
    return p.promise;
}
