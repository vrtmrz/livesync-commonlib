import { LRUCache } from "./LRUCache.ts";
import { Semaphore } from "./semaphore.ts";
import { arrayBufferToBase64Single, writeString } from "./strbin.ts";
import { type AnyEntry, type DatabaseEntry, type EntryLeaf, PREFIX_ENCRYPTED_CHUNK, PREFIX_OBFUSCATED, SYNCINFO_ID, type SyncInfo, RESULT_TIMED_OUT, type WithTimeout } from "./types.ts";
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
export function joinUInt8Array(arrays: Uint8Array[]) {
    const len = arrays.reduce((p, c) => p + c.byteLength, 0);
    const ret = new Uint8Array(len);
    let i = 0;
    for (const arr of arrays) {
        ret.set(arr, i);
        i += arr.length;
    }
    return ret;
}
export function getDocDataAsArrayBuffer(doc: string | string[] | ArrayBuffer) {
    if (doc instanceof ArrayBuffer) return new Uint8Array(doc);
    const docData = getDocDataAsArray(doc);
    const s = docData.map(e => writeString(e));
    return joinUInt8Array(s);
}

export function isTextBlob(blob: Blob) {
    return blob.type === "text/plain";
}
export function createTextBlob(data: string | string[]) {
    const d = (Array.isArray(data)) ? data : [data];
    return new Blob(d, { endings: "transparent", type: "text/plain" });

}
export function createBinaryBlob(data: Uint8Array | ArrayBuffer) {
    return new Blob([data], { endings: "transparent", type: "application/octet-stream" });
}

const isIndexDBCmpExist = typeof window?.indexedDB?.cmp !== "undefined";

export async function isDocContentSame(docA: string | string[] | Blob, docB: string | string[] | Blob) {
    const blob1 = docA instanceof Blob ? docA : createTextBlob(docA);
    const blob2 = docB instanceof Blob ? docB : createTextBlob(docB);
    if (blob1.size != blob2.size) return false;
    if (isIndexDBCmpExist) {
        return window.indexedDB.cmp(await blob1.arrayBuffer(), await blob2.arrayBuffer()) === 0;
    }
    const checkQuantum = 10000;
    const length = blob1.size;


    let i = 0;

    while (i < length) {
        const ab1 = await blob1.slice(i, i + checkQuantum).arrayBuffer();
        const ab2 = await blob2.slice(i, i + checkQuantum).arrayBuffer();
        i += checkQuantum;
        if (await arrayBufferToBase64Single(ab1) != await arrayBufferToBase64Single(ab2)) return false;
    }
    return true;
}

// Obsolete function
export function isDocContentSame_old(docA: string | string[] | Blob, docB: string | string[] | Blob) {
    const blob1 = docA instanceof Blob ? docA : createTextBlob(docA);
    const blob2 = docB instanceof Blob ? docB : createTextBlob(docB);
    if (blob1.size != blob2.size) return false;
    // const checkQuantum = 1000;
    const stream1 = blob1.stream().getReader();
    const stream2 = blob2.stream().getReader();

    // TODO: Optimise if not performant well.
    let read1 = stream1.read();
    let read2 = stream2.read();

    while (read1 !== null && read2 !== null) {
        if (read1 !== read2) {
            return false;
        }
        read1 = stream1.read();
        read2 = stream2.read();
    }

    return read1 === null && read2 === null;
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

const traps = {} as { [key: string]: ((param: any) => void)[]; }
export async function waitForSignal(id: string, timeout?: number): Promise<boolean> {
    return await waitForValue(id, timeout) !== RESULT_TIMED_OUT;
}
export function waitForValue<T>(id: string, timeout?: number): Promise<WithTimeout<T>> {
    let resolveTrap: (result: WithTimeout<T>) => void;
    let trapJob: () => void;
    const timer = timeout ? setTimeout(() => {
        if (id in traps) {
            traps[id] = traps[id].filter(e => e != trapJob);
        }
        if (resolveTrap) resolveTrap(RESULT_TIMED_OUT);
        resolveTrap = null;
    }, timeout) : false
    return new Promise((res) => {
        if (!(id in traps)) traps[id] = [];
        resolveTrap = res;
        trapJob = (result?: T) => {
            if (timer) clearTimeout(timer);
            res(result);
        }
        traps[id].push(trapJob);
    });
}

export function sendSignal(key: string) {
    sendValue(key, true);
}
export function sendValue<T>(key: string, result: T) {
    if (!(key in traps)) {
        return;
    }
    const trap = traps[key];
    delete traps[key];
    for (const resolver of trap) {
        resolver(result);
    }
}

/**
 * 
 * @param exclusion return only not exclusion
 * @returns 
 * 
 * ["something",false,"aaaaa"].filter(onlyNot(false)) => yields ["something","aaaaaa"]. but, as string[].
 */
export function onlyNot<A, B>(exclusion: B) {
    function _onlyNot(item: A | B): item is Exclude<A, B> {
        if (item === exclusion) return false;
        return true;
    }
    return _onlyNot;
}

const lastProcessed = {} as Record<string, number>;
function markInterval(key: string, now?: number) {
    const next = now ?? Date.now();
    if (lastProcessed?.[key] ?? 0 < next) {
        lastProcessed[key] = next;
    }
}
/**
 * Run task with keeping minimum interval
 * @param key waiting key
 * @param interval interval (ms)
 * @param task task to perform.
 * @returns result of task
 * @remarks This function is not designed to be concurrent.
 */
export async function runWithInterval<T>(key: string, interval: number, task: () => Promise<T>): Promise<T> {
    const now = Date.now();
    try {
        if (!(key in lastProcessed)) {
            markInterval(key, now);
            return await task();
        }

        const last = lastProcessed[key];
        const diff = now - last;
        if (diff < interval) {
            markInterval(key, now);
            await delay(diff);
        }
        markInterval(key);
        return await task();
    } finally {
        markInterval(key);
    }
}

/**
 * Run task with keeping minimum interval on start
 * @param key waiting key
 * @param interval interval (ms)
 * @param task task to perform.
 * @returns result of task
 * @remarks This function is not designed to be concurrent.
 */
export async function runWithStartInterval<T>(key: string, interval: number, task: () => Promise<T>): Promise<T> {
    const now = Date.now();
    if (!(key in lastProcessed)) {
        markInterval(key, now);
        return await task();
    }

    const last = lastProcessed[key];
    const diff = now - last;
    if (diff < interval) {
        markInterval(key, now);
        await delay(diff);
    }
    markInterval(key);
    return await task();

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

export function fireAndForget(p: Promise<any> | (() => Promise<any>)) {
    if (typeof p == "function") return fireAndForget(p());
    p.then(_ => {/* NO OP */ }).catch(_ => {/* NO OP */ });
}

export function isObjectDifferent(a: any, b: any): boolean {
    if (typeof a !== typeof b) {
        return true;
    }
    if (typeof a === "object") {
        if (a === null || b === null) {
            return a !== b;
        }
        const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])];
        return keys.map(key => isObjectDifferent(a?.[key], b?.[key])).some(e => e == true);
    } else {
        return a !== b;
    }
}
