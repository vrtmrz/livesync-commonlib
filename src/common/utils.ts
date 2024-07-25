import { LRUCache } from "../memory/LRUCache.ts";
import { isPlainText } from "../string_and_binary/path.ts";
import { Semaphore } from "../concurrency/semaphore.ts";
import { arrayBufferToBase64Single, decodeBinary, writeString } from "../string_and_binary/convert.ts";
import { type AnyEntry, type DatabaseEntry, type EntryLeaf, PREFIX_ENCRYPTED_CHUNK, PREFIX_OBFUSCATED, SYNCINFO_ID, type SyncInfo, type LoadedEntry, type SavingEntry, type NewEntry, type PlainEntry } from "./types.ts";
import { isErrorOfMissingDoc } from "../pouchdb/utils_couchdb.ts";
import { replaceAll, replaceAllPairs } from "octagonal-wheels/string.js";
export { replaceAll, replaceAllPairs }
import { concatUInt8Array } from "octagonal-wheels/binary/index.js";
export { concatUInt8Array };

import { delay, fireAndForget } from "octagonal-wheels/promises.js";
export { delay, fireAndForget }

import { arrayToChunkedArray, unique } from "octagonal-wheels/collection.js";
export { arrayToChunkedArray, unique }

import { extractObject, isObjectDifferent } from "octagonal-wheels/object.js";
export { extractObject, isObjectDifferent }

import { sendValue, sendSignal, waitForSignal, waitForValue } from "octagonal-wheels/messagepassing/signal.js";
export { sendValue, sendSignal, waitForSignal, waitForValue }

import { throttle } from "octagonal-wheels/function.js";
export { throttle }

import type { SimpleStore } from "octagonal-wheels/databases/SimpleStoreBase.js";
export type { SimpleStore }

export { sizeToHumanReadable } from "octagonal-wheels/number.js"

export function resolveWithIgnoreKnownError<T>(p: Promise<T>, def: T): Promise<T> {
    return new Promise((res, rej) => {
        p.then(res).catch((ex) => (isErrorOfMissingDoc(ex) ? res(def) : rej(ex)));
    });
}


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

export function getDocDataAsArrayBuffer(doc: string | string[] | ArrayBuffer) {
    if (doc instanceof ArrayBuffer) return new Uint8Array(doc);
    const docData = getDocDataAsArray(doc);
    const s = docData.map(e => writeString(e));
    return concatUInt8Array(s);
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
export function isLoadedEntry(doc: DatabaseEntry): doc is LoadedEntry {
    return "type" in doc && (doc.type == "newnote" || doc.type == "plain") && "data" in doc;
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



export function setAllItems<T>(set: Set<T>, items: T[]) {
    items.forEach(e => set.add(e))
    return set;
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

export function escapeMarkdownValue(value: any) {
    if (typeof value === "string") {
        return replaceAllPairs(value, ["|", "\\|"], ["`", "\\`"]);
    } else {
        return value;
    }
}

export function timeDeltaToHumanReadable(delta: number) {
    const sec = delta / 1000;
    if (sec < 60) {
        return `${sec.toFixed(2)}s`;
    }
    const min = sec / 60;
    if (min < 60) {
        return `${min.toFixed(2)}m`;
    }
    const hour = min / 60;
    if (hour < 24) {
        return `${hour.toFixed(2)}h`;
    }
    const day = hour / 24;
    if (day < 365) {
        return `${day.toFixed(2)}d`;
    }
    const year = day / 365;
    return `${year.toFixed(2)}y`;
}
