import { Logger } from "./logger.ts";
import { LOG_LEVEL } from "./types.ts";

export class LRUCache<K, V> {
    private cache = new Map<K, V>([]);
    private revCache = new Map<V, K>([]);
    maxCache = 200;
    maxCachedLength = 50000000; // means 50 mb to 400mb.
    cachedLength = 0;
    enableReversed = true;
    constructor(maxCache: number, maxCacheLength: number, forwardOnly = false) {
        this.maxCache = maxCache || 200;
        this.maxCachedLength = (maxCacheLength || 1) * 1000000;
        this.enableReversed = !forwardOnly;
        Logger(`Cache initialized ${this.maxCache} / ${this.maxCachedLength}`, LOG_LEVEL.VERBOSE);
    }
    has(key: K) {
        return this.cache.has(key);
    }
    get(key: K) {
        const v = this.cache.get(key);

        if (v) {
            // update the key to recently used.
            this.cache.delete(key);
            this.cache.set(key, v);
            if (this.enableReversed) {
                this.revCache.delete(v);
                this.revCache.set(v, key);
            }
        }
        return v;
    }
    revGet(value: V) {
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
    set(key: K, value: V) {
        this.cache.set(key, value);
        if (this.enableReversed) this.revCache.set(value, key);
        this.cachedLength += `${value}`.length;
        if (this.cache.size > this.maxCache || this.cachedLength > this.maxCachedLength) {
            for (const [key, value] of this.cache) {
                this.cache.delete(key);
                if (this.enableReversed) this.revCache.delete(value);
                this.cachedLength -= `${value}`.length;
                if (this.cache.size <= this.maxCache && this.cachedLength <= this.maxCachedLength)
                    break;
            }
        } else {
            // console.log([this.cache.size, this.cachedLength]);
        }
    }
}
