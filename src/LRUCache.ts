export class LRUCache {
    cache = new Map<string, string>([]);
    revCache = new Map<string, string>([]);
    maxCache = 100;
    constructor() { }
    get(key: string) {
        // debugger
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
        // debugger
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
        if (this.cache.size > this.maxCache) {
            for (const kv of this.cache) {
                this.revCache.delete(kv[1]);
                this.cache.delete(kv[0]);
                if (this.cache.size <= this.maxCache)
                    break;
            }
        }
    }
}
