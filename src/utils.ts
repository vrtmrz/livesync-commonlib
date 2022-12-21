import { decrypt, encrypt } from "./e2ee_v2";
import { Logger } from "./logger";
import { EntryDoc, EntryLeaf, FLAGMD_REDFLAG, SYNCINFO_ID, LOG_LEVEL, MAX_DOC_SIZE } from "./types";

export function arrayBufferToBase64(buffer: ArrayBuffer): Promise<string> {
    return new Promise((res) => {
        const blob = new Blob([buffer], { type: "application/octet-binary" });
        const reader = new FileReader();
        reader.onload = function (evt) {
            const dataURI = evt.target.result.toString();
            res(dataURI.substr(dataURI.indexOf(",") + 1));
        };
        reader.readAsDataURL(blob);
    });
}

export function base64ToString(base64: string): string {
    try {
        const binary_string = window.atob(base64);
        const len = binary_string.length;
        const bytes = new Uint8Array(len);
        for (let i = 0; i < len; i++) {
            bytes[i] = binary_string.charCodeAt(i);
        }
        return new TextDecoder().decode(bytes);
    } catch (ex) {
        return base64;
    }
}
export function base64ToArrayBuffer(base64: string): ArrayBuffer {
    try {
        const binary_string = window.atob(base64);
        const len = binary_string.length;
        const bytes = new Uint8Array(len);
        for (let i = 0; i < len; i++) {
            bytes[i] = binary_string.charCodeAt(i);
        }
        return bytes.buffer;
    } catch (ex) {
        try {
            return new Uint16Array(
                [].map.call(base64, function (c: string) {
                    return c.charCodeAt(0);
                })
            ).buffer;
        } catch (ex2) {
            return null;
        }
    }
}

export const escapeStringToHTML = (str: string) => {
    if (!str) return "";
    return str.replace(/[<>&"'`]/g, (match) => {
        const escape: any = {
            "<": "&lt;",
            ">": "&gt;",
            "&": "&amp;",
            '"': "&quot;",
            "'": "&#39;",
            "`": "&#x60;",
        };
        return escape[match];
    });
};

export function resolveWithIgnoreKnownError<T>(p: Promise<T>, def: T): Promise<T> {
    return new Promise((res, rej) => {
        p.then(res).catch((ex) => (ex.status && ex.status == 404 ? res(def) : rej(ex)));
    });
}

export function isValidPath(filename: string): boolean {
    // eslint-disable-next-line no-control-regex
    const regex = /[\u0000-\u001f]|[\\":?<>|*#]/g;
    let x = filename.replace(regex, "_");
    const win = /(\\|\/)(COM\d|LPT\d|CON|PRN|AUX|NUL|CLOCK$)($|\.)/gi;
    const sx = (x = x.replace(win, "/_"));
    return sx == filename;
}

export function shouldBeIgnored(filename: string): boolean {
    if (filename == FLAGMD_REDFLAG) {
        return true;
    }
    return false;
}

export function versionNumberString2Number(version: string): number {
    return version // "1.23.45"
        .split(".") // 1  23  45
        .reverse() // 45  23  1
        .map((e, i) => ((e as any) / 1) * 1000 ** i) // 45 23000 1000000
        .reduce((prev, current) => prev + current, 0); // 1023045
}

export const delay = (ms: number): Promise<void> => {
    return new Promise((res) => {
        setTimeout(() => {
            res();
        }, ms);
    });
};

// For backward compatibility, using the path for determining id.
// Only CouchDB unacceptable ID (that starts with an underscore) has been prefixed with "/".
// The first slash will be deleted when the path is normalized.
export function path2id_base(filename: string): string {
    let x = filename;
    if (x.startsWith("_")) x = "/" + x;
    return x;
}
export function id2path_base(filename: string): string {
    //TODO:FIXING PREFIX
    return filename;
}

let externalNotifier: () => void = () => { };
let notifyTimer: number | NodeJS.Timeout = null;
export function setLockNotifier(fn: () => void) {
    externalNotifier = fn;
}
function notifyLock() {
    if (notifyTimer != null) {
        clearTimeout(notifyTimer as any);
    }
    notifyTimer = setTimeout(() => {
        externalNotifier();
    }, 100);
}

/// obsolete
export function splitPieces(data: string, pieceSize: number, plainSplit: boolean, minimumChunkSize: number, longLineThreshold: number) {
    return function* pieces(): Generator<string> {
        let cPieceSize = pieceSize;
        let leftData = data;
        do {
            // To keep low bandwidth and database size,
            // Dedupe pieces on database.
            // from 0.1.10, for best performance. we use markdown delimiters
            // 1. \n[^\n]{longLineThreshold}[^\n]*\n -> long sentence should break.
            // 2. \n\n should break
            // 3. \r\n\r\n should break
            // 4. \n# should break.

            if (plainSplit) {
                cPieceSize = 0;
                // lookup for next splitting point.
                // we're standing on "\n"
                do {
                    const n1 = leftData.indexOf("\n", cPieceSize + 1);
                    const n2 = leftData.indexOf("\n\n", cPieceSize + 1);
                    const n3 = leftData.indexOf("\r\n\r\n", cPieceSize + 1);
                    const n4 = leftData.indexOf("\n#", cPieceSize + 1);
                    if (n1 == -1 && n2 == -1 && n3 == -1 && n4 == -1) {
                        cPieceSize = MAX_DOC_SIZE;
                        break;
                    }

                    if (n1 > longLineThreshold) {
                        // long sentence is an established piece
                        cPieceSize = n1;
                    } else {
                        // cPieceSize = Math.min.apply([n2, n3, n4].filter((e) => e > 1));
                        // ^ heavy.
                        if (n1 > 0 && cPieceSize < n1) cPieceSize = n1;
                        if (n2 > 0 && cPieceSize < n2) cPieceSize = n2 + 1;
                        if (n3 > 0 && cPieceSize < n3) cPieceSize = n3 + 3;
                        // Choose shorter, empty line and \n#
                        if (n4 > 0 && cPieceSize > n4) cPieceSize = n4 + 0;
                        cPieceSize++;
                    }
                } while (cPieceSize < minimumChunkSize);
            }

            // piece size determined.
            const piece = leftData.substring(0, cPieceSize);
            leftData = leftData.substring(cPieceSize);
            yield piece;
        } while (leftData != "");
    };
}
function* pickPiece(leftData: string[], minimumChunkSize: number): Generator<string> {
    let buffer = "";
    L1:
    do {
        const curLine = leftData.shift();
        if (typeof (curLine) === "undefined") {
            yield buffer;
            break L1;
        }

        // Do not use regexp for performance.
        if (curLine.startsWith("```") || curLine.startsWith(" ```") || curLine.startsWith("  ```") || curLine.startsWith("   ```")) {
            yield buffer;
            buffer = curLine + (leftData.length != 0 ? "\n" : "");
            L2:
            do {
                const curPx = leftData.shift();
                if (typeof (curPx) === "undefined") {
                    break L2;
                }
                buffer += curPx + (leftData.length != 0 ? "\n" : "");
            } while (leftData.length > 0 && !(leftData[0].startsWith("```") || leftData[0].startsWith(" ```") || leftData[0].startsWith("  ```") || leftData[0].startsWith("   ```")));
            const isLooksLikeBASE64 = buffer.endsWith("=");
            const maybeUneditable = buffer.length > 2048;
            // concat code block end mark
            const endOfCodeBlock = leftData.shift();
            if (typeof (endOfCodeBlock) !== "undefined") {
                buffer += endOfCodeBlock;
                buffer += (leftData.length != 0 ? "\n" : "");
            }
            if (!isLooksLikeBASE64 && !maybeUneditable) {
                const splitExpr = /(.*?[;,:<])/g;
                const sx = buffer.split(splitExpr).filter(e => e != '');
                for (const v of sx) {
                    yield v;
                }
            } else {
                yield buffer;
            }
            buffer = "";
        } else {
            buffer += curLine + (leftData.length != 0 ? "\n" : "");
            if (buffer.length >= minimumChunkSize || leftData.length == 0 || leftData[0] == "#" || buffer[0] == "#") {
                yield buffer;
                buffer = "";
            }
        }
    } while (leftData.length > 0);
}
// Split string into pieces within specific lengths (characters).
export function splitPieces2(data: string, pieceSize: number, plainSplit: boolean, minimumChunkSize: number, longLineThreshold: number) {
    return function* pieces(): Generator<string> {
        if (plainSplit) {
            const leftData = data.split("\n"); //use memory
            const f = pickPiece(leftData, minimumChunkSize);
            for (const piece of f) {
                let buffer = piece;
                do {
                    // split to within maximum pieceSize
                    let ps = pieceSize;
                    if (buffer.charCodeAt(ps - 1) != buffer.codePointAt(ps - 1)) {
                        // If the char at the end of the chunk has been part of the surrogate pair, grow the piece size a bit.
                        ps++;
                    }
                    yield buffer.substring(0, ps);
                    buffer = buffer.substring(ps);
                } while (buffer != "");
            }
        } else {
            let leftData = data;
            do {
                const piece = leftData.substring(0, pieceSize);
                leftData = leftData.substring(pieceSize);
                yield piece;
            } while (leftData != "");
        }
    };
}

// Just run async/await as like transaction ISOLATION SERIALIZABLE
const LOCK_WAITING = 0;
const LOCK_RUNNING = 1;
const LOCK_DONE = 2;

interface lockedEntry {
    key: string;
    proc: () => Promise<any>;
    status: 0 | 1 | 2;
}
let locks: lockedEntry[] = [];
export function getLocksOld() {
    return {
        pending: locks.filter((e) => e.status == LOCK_WAITING).map((e) => e.key),
        running: locks.filter((e) => e.status == LOCK_RUNNING).map((e) => e.key),
    };
}

export function getProcessingCountsOld() {
    return locks.length;
}

async function lockRunner(key: string) {
    let processes = locks.filter((e) => e.key == key && e.status == LOCK_WAITING);
    while (processes.length != 0) {
        const w = processes.shift();
        if (!w) break;
        w.status = LOCK_RUNNING;
        notifyLock();
        try {
            await w.proc();
        } catch (ex) {
            Logger(`Lock:${key}:rejected `, LOG_LEVEL.VERBOSE);
            Logger(ex, LOG_LEVEL.VERBOSE);
        } finally {
            w.status = LOCK_DONE;
            notifyLock();
        }
        processes = locks.filter((e) => e.key == key && e.status == LOCK_WAITING);
    }
    locks = locks.filter((e) => e.status != LOCK_DONE);
}
const nextProc = (key: string) => {
    if (!locks.some((e) => e.key == key && (e.status == LOCK_RUNNING || e.status == LOCK_DONE))) {
        lockRunner(key);
    }
};
export function runWithLockOld<T>(key: string, ignoreWhenRunning: boolean, proc: () => Promise<T>): Promise<T> | null {
    if (ignoreWhenRunning && locks.some((e) => e.key == key && e.status == LOCK_RUNNING)) {
        return null;
    }
    return new Promise((pRes, pRej) => {
        const wrappedTask = () =>
            proc()
                .then(pRes)
                .catch(pRej)
                .finally(() => {
                    procObj.status = LOCK_DONE;
                    nextProc(key);
                });
        const procObj: lockedEntry = { key, proc: wrappedTask, status: LOCK_WAITING };
        locks.push(procObj);
        notifyLock();
        nextProc(key);
    });
}

export class WrappedNotice {
    constructor(message: string | DocumentFragment, timeout?: number) {
        let strMessage = "";
        if (message instanceof DocumentFragment) {
            strMessage = message.textContent;
        } else {
            strMessage = message;
        }
        Logger(strMessage, LOG_LEVEL.NOTICE);
    }

    setMessage(message: string | DocumentFragment): this {
        let strMessage = "";
        if (message instanceof DocumentFragment) {
            strMessage = message.textContent;
        } else {
            strMessage = message;
        }
        Logger(strMessage, LOG_LEVEL.NOTICE);
        return this;
    }

    hide(): void { }
}
let _notice = WrappedNotice;

export function setNoticeClass(notice: typeof WrappedNotice) {
    _notice = notice;
}
export function NewNotice(message: string | DocumentFragment, timeout?: number) {
    return new _notice(message, timeout);
}
export function isPlainText(filename: string): boolean {
    if (filename.endsWith(".md")) return true;
    if (filename.endsWith(".txt")) return true;
    if (filename.endsWith(".svg")) return true;
    if (filename.endsWith(".html")) return true;
    if (filename.endsWith(".csv")) return true;
    if (filename.endsWith(".css")) return true;
    if (filename.endsWith(".js")) return true;
    if (filename.endsWith(".xml")) return true;
    if (filename.endsWith(".canvas")) return true;
    return false;
}
export function shouldSplitAsPlainText(filename: string): boolean {
    if (filename.endsWith(".md")) return true;
    if (filename.endsWith(".txt")) return true;
    if (filename.endsWith(".canvas")) return true;
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

// requires transform-pouch
export const enableEncryption = (db: PouchDB.Database<EntryDoc>, passphrase: string, migrationDecrypt?: boolean) => {
    const decrypted = new Map();
    //@ts-ignore
    db.transform({
        incoming: async (doc: EntryDoc) => {
            const saveDoc: EntryLeaf = {
                ...doc,
            } as EntryLeaf;
            if (saveDoc._id.startsWith("h:+") || saveDoc._id == SYNCINFO_ID) {
                try {
                    saveDoc.data = await encrypt(saveDoc.data, passphrase);
                } catch (ex) {
                    Logger("Encryption failed.", LOG_LEVEL.NOTICE);
                    Logger(ex);
                    throw ex;
                }
            }
            return saveDoc;
        },
        outgoing: async (doc: EntryDoc) => {
            const loadDoc: EntryLeaf = {
                ...doc,
            } as EntryLeaf;
            if (loadDoc._id.startsWith("h:+") || loadDoc._id == SYNCINFO_ID) {
                if (migrationDecrypt && decrypted.has(loadDoc._id)) {
                    return loadDoc; // once decrypted.
                }
                try {
                    loadDoc.data = await decrypt(loadDoc.data, passphrase);
                    if (migrationDecrypt) {
                        decrypted.set(loadDoc._id, true);
                    }
                } catch (ex) {
                    if (migrationDecrypt && ex.name == "SyntaxError") {
                        return loadDoc; // This logic will be removed in a while.
                    }
                    Logger("Decryption failed.", LOG_LEVEL.NOTICE);
                    Logger(ex);
                    throw ex;
                }
            }
            return loadDoc;
        },
    });
};


type QueueNotifier = {
    key: string;
    notify: (result: boolean) => void;
    semaphoreStopper: Promise<SemaphoreReleaser | false>;
    quantity: number;
    memo?: string;
    state: "NONE" | "RUNNING" | "DONE";
    timer?: ReturnType<typeof setTimeout>;
}
type SemaphoreReleaser = () => void;
function makeUniqueString() {
    const randomStrSrc = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
    const temp = [...Array(30)]
        .map(() => Math.floor(Math.random() * randomStrSrc.length))
        .map((e) => randomStrSrc[e])
        .join("");
    return `${Date.now()}-${temp}`;
}
type SemaphoreObject = {
    _acquire(quantity: number, memo: string, timeout: number): Promise<SemaphoreReleaser | false>;
    acquire(quantity?: number, memo?: string): Promise<SemaphoreReleaser>;
    tryAcquire(quantity: number | undefined, timeout: number, memo?: string): Promise<SemaphoreReleaser | false>;
    peekQueues(): QueueNotifier[];

}
/**
 * Semaphore handling lib.
 * @param limit Maximum number that can be acquired.
 * @returns Instance of SemaphoreObject
 */
export function Semaphore(limit: number, onRelease?: (currentQueue: QueueNotifier[]) => Promise<void> | void): SemaphoreObject {
    const _limit = limit;

    let currentProcesses = 0;
    let queue: QueueNotifier[] = [];
    /**
     * Semaphore processing pump
     */
    function execProcess() {
        //Delete already finished 
        queue = queue.filter(e => e.state != "DONE");

        // acquiring semaphore by order
        for (const queueItem of queue) {
            if (queueItem.state != "NONE") continue;
            if (queueItem.quantity + currentProcesses > _limit) {
                break;
            }
            queueItem.state = "RUNNING";
            currentProcesses += queueItem.quantity;
            if (queueItem?.timer) {
                clearTimeout(queueItem.timer);
            }
            queueItem.notify(true);
        }
    }

    /**
     * Mark DONE.
     * @param key 
     */
    function release(key: string) {
        const finishedTask = queue.find(e => e.key == key);
        if (!finishedTask) {
            throw new Error("Missing locked semaphore!");
        }

        if (finishedTask.state == "RUNNING") {
            currentProcesses -= finishedTask.quantity;
        }
        finishedTask.state = "DONE";
        if (onRelease) onRelease(queue.filter(e => e.state != "DONE"));
        execProcess();
    }
    return {
        _acquire(quantity: number, memo: string, timeout: number): Promise<SemaphoreReleaser | false> {
            const key = makeUniqueString();
            if (_limit < quantity) {
                throw Error("Too big quantity");
            }

            // function for notify
            // When we call this function, semaphore acquired by resolving promise.
            // (Or, notify acquiring is timed out.)
            let notify = (_: boolean) => { };
            const semaphoreStopper = new Promise<SemaphoreReleaser | false>(res => {
                notify = (result: boolean) => {
                    if (result) {
                        res(() => { release(key) })
                    } else {
                        res(false);
                    }
                }
            })
            const notifier: QueueNotifier = {
                key,
                notify,
                semaphoreStopper,
                quantity,
                memo,
                state: "NONE"
            }
            if (timeout) notifier.timer = setTimeout(() => {
                // If acquiring is timed out, clear queue and notify failed.
                release(key);
                notify(false);
            }, timeout)

            // Push into the queue once.
            queue.push(notifier);

            //Execute loop
            execProcess();

            //returning Promise
            return semaphoreStopper;
        },
        acquire(quantity = 1, memo?: string): Promise<SemaphoreReleaser> {
            return this._acquire(quantity, memo ?? "", 0) as Promise<SemaphoreReleaser>;
        },
        tryAcquire(quantity = 1, timeout: number, memo?: string,): Promise<SemaphoreReleaser | false> {
            return this._acquire(quantity, memo ?? "", timeout)
        },
        peekQueues() {
            return queue;
        }
    }
}

const Mutexes = {} as { [key: string]: SemaphoreObject }

export function getLocks() {
    const allLocks = [...Object.values(Mutexes).map(e => e.peekQueues())].flat();
    return {
        pending: allLocks.filter((e) => e.state == "NONE").map((e) => e.memo),
        running: allLocks.filter((e) => e.state == "RUNNING").map((e) => e.memo),
    };
}

export function getProcessingCounts() {
    return [...Object.values(Mutexes).map(e => e.peekQueues())].flat().length;
}

let semaphoreReleasedCount = 0;
export async function runWithLock<T>(key: string, ignoreWhenRunning: boolean, proc: () => Promise<T>): Promise<T> | null {

    if (semaphoreReleasedCount > 200) {
        const deleteKeys = [] as string[];
        for (const key in Mutexes) {
            if (Mutexes[key].peekQueues().length == 0) {
                deleteKeys.push(key);
            }
        }
        for (const key of deleteKeys) {
            delete Mutexes[key];
        }
        semaphoreReleasedCount = 0;
    }
    if (!(key in Mutexes)) {
        Mutexes[key] = Semaphore(1, (queue => {
            if (queue.length == 0) semaphoreReleasedCount++;
        }));
    }

    const timeout = ignoreWhenRunning ? 1 : 0;
    const releaser = await Mutexes[key].tryAcquire(1, timeout, key);
    if (!releaser) return null;
    try {
        return await proc();
    } finally {
        releaser();
        notifyLock();
    }

}