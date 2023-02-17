import { Logger } from "./logger";
import { LOG_LEVEL } from "./types";

export class LRUCache {
    private cache = new Map<string, string>([]);
    private revCache = new Map<string, string>([]);
    maxCache = 200;
    maxCachedLength = 50000000; // means 50 mb to 400mb.
    cachedLength = 0;
    constructor(maxCache: number, maxCacheLength: number) {
        this.maxCache = maxCache || 200;
        this.maxCachedLength = (maxCacheLength || 1) * 1000000;
        Logger(`Cache initialized ${this.maxCache} / ${this.maxCachedLength}`, LOG_LEVEL.VERBOSE);
    }
    get(key: string) {
        const v = this.cache.get(key);

        if (v) {
            // update the key to recently used.
            this.cache.delete(key);
            this.revCache.delete(v);
            this.cache.set(key, v);
            this.revCache.set(v, key);
        }
        return v;
    }
    revGet(value: string) {
        const key = this.revCache.get(value);
        if (value) {
            // update the key to recently used.
            this.cache.delete(key);
            this.revCache.delete(value);
            this.cache.set(key, value);
            this.revCache.set(value, key);
        }
        return key;
    }
    set(key: string, value: string) {
        this.cache.set(key, value);
        this.revCache.set(value, key);
        this.cachedLength += value.length;
        if (this.cache.size > this.maxCache || this.cachedLength > this.maxCachedLength) {
            // console.warn(`Exceeded! ${this.cache.size} > ${this.maxCache} || ${this.cachedLength} > ${this.maxCachedLength}`)
            for (const [key, value] of this.cache) {
                this.revCache.delete(value);
                this.cache.delete(key);
                this.cachedLength -= value.length;
                if (this.cache.size <= this.maxCache && this.cachedLength <= this.maxCachedLength)
                    break;
            }
        } else {
            // console.log([this.cache.size, this.cachedLength]);
        }
    }
}
