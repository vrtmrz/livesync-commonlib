import { LRUCache } from "./LRUCache.ts";
import { isPlainText } from "./path.ts";
import { Semaphore } from "./semaphore.ts";
import { arrayBufferToBase64Single, decodeBinary, writeString } from "./strbin.ts";
import { type AnyEntry, type DatabaseEntry, type EntryLeaf, PREFIX_ENCRYPTED_CHUNK, PREFIX_OBFUSCATED, SYNCINFO_ID, type SyncInfo, RESULT_TIMED_OUT, type WithTimeout, type LoadedEntry, type SavingEntry, type NewEntry, type PlainEntry } from "./types.ts";
import { isErrorOfMissingDoc } from "./utils_couchdb.ts";

function polyfillPromiseWithResolvers<T>() {
    let resolve!: Parameters<ConstructorParameters<typeof Promise<T>>[0]>[0];
    let reject!: Parameters<ConstructorParameters<typeof Promise<T>>[0]>[1];
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject }
}

// //@ts-ignore
// export const promiseWithResolver: typeof polyfillPromiseWithResolvers = typeof Promise.withResolvers === "function" ? Promise.withResolvers : polyfillPromiseWithResolvers;

export const promiseWithResolver = polyfillPromiseWithResolvers;

export function resolveWithIgnoreKnownError<T>(p: Promise<T>, def: T): Promise<T> {
    return new Promise((res, rej) => {
        p.then(res).catch((ex) => (isErrorOfMissingDoc(ex) ? res(def) : rej(ex)));
    });
}

// time util
export const delay = <T>(ms: number, result?: T): Promise<T> => {
    return new Promise((res) => {
        setTimeout(() => {
            res(result!);
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
export function createBlob(data: string | string[] | Uint8Array | ArrayBuffer | Blob) {
    if (data instanceof Blob) return data;
    if (data instanceof Uint8Array || data instanceof ArrayBuffer) return createBinaryBlob(data);
    return createTextBlob(data);
}

export function isTextDocument(doc: LoadedEntry) {
    if (doc.type == "plain") return true;
    if (doc.datatype == "plain") return true;
    if (isPlainText(doc.path)) return true;
    return false;
}

export function readAsBlob(doc: LoadedEntry) {
    if (isTextDocument(doc)) {
        return createTextBlob(doc.data);
    } else {
        return createBinaryBlob(decodeBinary(doc.data));
    }
}
export function readContent(doc: LoadedEntry) {
    if (isTextDocument(doc)) {
        return getDocData(doc.data);
    } else {
        return decodeBinary(doc.data);
    }
}

const isIndexDBCmpExist = typeof window?.indexedDB?.cmp !== "undefined";

export async function isDocContentSame(docA: string | string[] | Blob | ArrayBuffer, docB: string | string[] | Blob | ArrayBuffer) {
    const blob1 = createBlob(docA);
    const blob2 = createBlob(docB);
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
    let resolveTrap: ((result: WithTimeout<T>) => void) | undefined;
    let trapJob: (() => void) | ((param: T) => void);
    const timer = timeout ? setTimeout(() => {
        if (id in traps) {
            traps[id] = traps[id].filter(e => e != trapJob);
        }
        if (resolveTrap) resolveTrap(RESULT_TIMED_OUT);
        resolveTrap = undefined;
    }, timeout) : false
    return new Promise((res) => {
        if (!(id in traps)) traps[id] = [];
        resolveTrap = res;
        trapJob = (result: T) => {
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


export function determineTypeFromBlob(data: Blob): "newnote" | "plain" {
    return isTextBlob(data) ? "plain" : "newnote";
}
export function determineType(path: string, data: string | string[] | Uint8Array | ArrayBuffer | Blob): "newnote" | "plain" {
    if (data instanceof Blob) {
        return determineTypeFromBlob(data);
    }
    if (isPlainText(path)) return "plain";
    if (data instanceof Uint8Array) return "newnote";
    if (data instanceof ArrayBuffer) return "newnote";
    // string | string[]
    return "plain";
}

export function isAnyNote(doc: DatabaseEntry): doc is NewEntry | PlainEntry {
    return "type" in doc && (doc.type == "newnote" || doc.type == "plain");
}
export function createSavingEntryFromLoadedEntry(doc: LoadedEntry): SavingEntry {
    const data = readAsBlob(doc);
    const type = determineType(doc.path, data);
    return {
        ...doc,
        data: data,
        datatype: type,
        type,
        children: [],
    }
}

type ThrottledFunction<T extends (...args: any[]) => any> = (...args: Parameters<T>) => void;

export const throttle = <T extends (...args: any[]) => any>(func: T, timeout: number): ThrottledFunction<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let lastTime: number = 0; // initialize lastTime to 0
    return (...args: Parameters<T>) => {

        if (!lastTime) {
            func(...args);
            lastTime = Date.now();
        } else {
            clearTimeout(timer);
            const delayTime = timeout - (Date.now() - lastTime);
            timer = setTimeout(() => {
                func(...args);
                lastTime = Date.now();
            }, delayTime);
        }
    };
};

export function extractObject<T>(copyTo: T, obj: T): T {
    for (const key in copyTo) {
        copyTo[key] = obj[key];
    }
    return copyTo;
}

export interface SimpleStore<T> {
    get(key: string): Promise<T | undefined>;
    set(key: string, value: T): Promise<void>;
    delete(key: string): Promise<void>;
    keys(from: string | undefined, to: string | undefined, count?: number): Promise<string[]>;
}


export function setAllItems<T>(set: Set<T>, items: T[]) {
    items.forEach(e => set.add(e))
    return set;
}


export function concatUInt8Array(arrays: Uint8Array[]) {
    const length = arrays.reduce((acc, cur) => acc + cur.length, 0);
    const result = new Uint8Array(length);
    let pos = 0;
    for (const array of arrays) {
        result.set(array, pos);
        pos += array.length;
    }
    return result;
}

export function replaceAll(str: string, search: string, replace: string) {
    if ("replaceAll" in String.prototype) {
        //@ts-ignore
        return str.replaceAll(search, replace);
    }
    return str.split(search).join(replace);
}

export function escapeNewLineFromString(str: string) {
    if (str.indexOf("\n") < 0) {
        return str;
    }
    return "\\f" + replaceAll(replaceAll(str, "\\", "\\\\"), "\n", "\\n");
}
export function unescapeNewLineFromString(str: string) {
    if (!str.startsWith("\\f")) {
        return str;
    }
    return replaceAll(replaceAll(str.substring(2), "\\\\", "\\"), "\\n", "\n");
}