import { LRUCache } from "./LRUCache.ts";
import { Semaphore } from "./semaphore.ts";
import { type AnyEntry, type DatabaseEntry, type EntryLeaf, PREFIX_ENCRYPTED_CHUNK, PREFIX_OBFUSCATED, SYNCINFO_ID, type SyncInfo } from "./types.ts";
import { isErrorOfMissingDoc } from "./utils_couchdb.ts";

export function resolveWithIgnoreKnownError<T>(p: Promise<T>, def: T): Promise<T> {
    return new Promise((res, rej) => {
        p.then(res).catch((ex) => (isErrorOfMissingDoc(ex) ? res(def) : rej(ex)));
    });
}

// time util
export const delay = (ms: number): Promise<void> => {
    return new Promise((res) => {
        setTimeout(() => {
            res();
        }, ms);
    });
};

// Referenced below
// https://zenn.dev/sora_kumo/articles/539d7f6e7f3c63
export const Parallels = (ps = new Set<Promise<unknown>>()) => ({
    add: (p: Promise<unknown>) => ps.add(!!p.then(() => ps.delete(p)).catch(() => ps.delete(p)) && p),
    wait: (limit: number) => ps.size >= limit && Promise.race(ps),
    all: () => Promise.all(ps),
});
export async function allSettledWithConcurrencyLimit<T>(processes: Promise<T>[], limit: number) {
    const ps = Parallels();
    for (const proc of processes) {
        ps.add(proc);
        await ps.wait(limit);
    }
    (await ps.all()).forEach(() => { });
}



export function getDocData(doc: string | string[]) {
    return typeof (doc) == "string" ? doc : doc.join("")
}
export function getDocDataAsArray(doc: string | string[]) {
    return typeof (doc) == "string" ? [doc] : doc
}
const chunkCheckLen = 1000000;
function stringYielder(src: string[]) {
    return (function* gen() {
        let buf = "";
        for (const piece of src) {
            buf += piece;
            while (buf.length > chunkCheckLen) {
                const p = buf.slice(0, chunkCheckLen);
                buf = buf.substring(chunkCheckLen);
                yield p;
            }
        }
        if (buf != "") yield buf;
        return;
    })();

}
export function isDocContentSame(docA: string | string[], docB: string | string[]) {
    const docAArray = getDocDataAsArray(docA);
    const docBArray = getDocDataAsArray(docB);
    const chunkA = stringYielder(docAArray);
    const chunkB = stringYielder(docBArray);

    let genA;
    let genB;
    do {
        genA = chunkA.next();
        genB = chunkB.next();
        if (genA.value != genB.value) {
            return false;
        }
        if (genA.done != genB.done) {
            return false;
        }
    } while (!genA.done)

    if (!genB.done) return false;
    return true;
}

export function isObfuscatedEntry(doc: DatabaseEntry): doc is AnyEntry {
    if (doc._id.startsWith(PREFIX_OBFUSCATED)) {
        return true;
    }
    return false;
}

export function isEncryptedChunkEntry(doc: DatabaseEntry): doc is EntryLeaf {
    if (doc._id.startsWith(PREFIX_ENCRYPTED_CHUNK)) {
        return true;
    }
    return false;
}

export function isSyncInfoEntry(doc: DatabaseEntry): doc is SyncInfo {
    if (doc._id == SYNCINFO_ID) {
        return true;
    }
    return false;
}

export function memorizeFuncWithLRUCache<T, U>(func: (key: T) => U) {
    const cache = new LRUCache<T, U>(100, 100000, true);
    return (key: T) => {
        const isExists = cache.has(key);
        if (isExists) return cache.get(key);
        const value = func(key);
        cache.set(key, value);
        return value;
    };
}

export function memorizeFuncWithLRUCacheMulti<T extends Array<any>, U>(func: (...keys: T) => U) {
    const cache = new LRUCache<string, U>(100, 100000, true);
    return (keys: T) => {
        const theKey = (keys.map(e => (typeof e == "string" || typeof e == "number" || typeof e == "boolean") ? e.toString() : JSON.stringify(e))).join("-");
        const isExists = cache.has(theKey);
        if (isExists) return cache.get(theKey);
        const value = func(...keys);
        cache.set(theKey, value);
        return value;
    };
}

const traps = {} as { [key: string]: (() => void)[]; }
export function waitForSignal(id: string, timeout: number): Promise<boolean> {
    let resolveTrap: (result: boolean) => void;
    let trapJob: () => void;
    const timer = setTimeout(() => {
        if (id in traps) {
            traps[id] = traps[id].filter(e => e != trapJob);
        }
        if (resolveTrap) resolveTrap(false);
        resolveTrap = null;
    }, timeout)
    return new Promise((res) => {
        if (!(id in traps)) traps[id] = [];
        resolveTrap = res;
        trapJob = () => {
            if (timer) clearTimeout(timer);
            res(true);
        }
        traps[id].push(trapJob);
    });
}
export function sendSignal(key: string) {
    if (!(key in traps)) {
        return;
    }
    const trap = traps[key];
    delete traps[key];
    for (const resolver of trap) {
        resolver();
    }
}
export const globalConcurrencyController = Semaphore(50);

export function* arrayToChunkedArray<T>(arr: T[], chunkLength: number) {
    const source = [...arr];
    while (source.length) {
        const s = source.splice(0, chunkLength);
        yield s;
    }
}

export function unique<T>(arr: T[]) {
    return [...new Set<T>(arr)]
}

export function fireAndForget(p: Promise<any>) {
    p.then(_ => {/* NO OP */ }).catch(_ => {/* NO OP */ });
}