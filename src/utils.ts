import { Logger } from "./logger";
import { FLAGMD_REDFLAG, LOG_LEVEL, MAX_DOC_SIZE } from "./types";

export function arrayBufferToBase64(buffer: ArrayBuffer): Promise<string> {
    return new Promise((res) => {
        const blob = new Blob([buffer], { type: "application/octet-binary" });
        const reader = new FileReader();
        reader.onload = function (evt) {
            const dataurl = evt.target.result.toString();
            res(dataurl.substr(dataurl.indexOf(",") + 1));
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
// Only CouchDB nonacceptable ID (that starts with an underscore) has been prefixed with "/".
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

let runningProcs: string[] = [];
const pendingProcs: { [key: string]: (() => Promise<void>)[] } = {};
function objectToKey(key: any): string {
    if (typeof key === "string") return key;
    const keys = Object.keys(key).sort((a, b) => a.localeCompare(b));
    return keys.map((e) => e + objectToKey(key[e])).join(":");
}
export function getProcessingCounts() {
    let count = 0;
    for (const v in pendingProcs) {
        count += pendingProcs[v].length;
    }
    count += runningProcs.length;
    return count;
}

let externalNotifier: () => void = () => {};
let notifyTimer: number = null;
export function setLockNotifier(fn: () => void) {
    externalNotifier = fn;
}
function notifyLock() {
    if (notifyTimer != null) {
        window.clearTimeout(notifyTimer);
    }
    notifyTimer = window.setTimeout(() => {
        externalNotifier();
    }, 100);
}

export function splitPieces(data: string, pieceSize: number, plainSplit: boolean, minimumChunkSize: number, longLineThreshold: number) {
    return function* pieces(): Generator<string> {
        let cPieceSize = pieceSize;
        let leftData = data;
        do {
            // To keep low bandwith and database size,
            // Dedup pieces on database.
            // from 0.1.10, for best performance. we use markdown delimiters
            // 1. \n[^\n]{longLineThreshold}[^\n]*\n -> long sentence shuld break.
            // 2. \n\n shold break
            // 3. \r\n\r\n should break
            // 4. \n# should break.

            if (plainSplit) {
                cPieceSize = 0;
                // lookup for next splittion .
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

// Just run async/await as like transacion ISOLATION SERIALIZABLE
export function runWithLock<T>(key: unknown, ignoreWhenRunning: boolean, proc: () => Promise<T>): Promise<T> {
    // Logger(`Lock:${key}:enter`, LOG_LEVEL.VERBOSE);
    const lockKey = typeof key === "string" ? key : objectToKey(key);
    const handleNextProcs = () => {
        if (typeof pendingProcs[lockKey] === "undefined") {
            //simply unlock
            runningProcs = runningProcs.filter((e) => e != lockKey);
            notifyLock();
            // Logger(`Lock:${lockKey}:released`, LOG_LEVEL.VERBOSE);
        } else {
            Logger(`Lock:${lockKey}:left ${pendingProcs[lockKey].length}`, LOG_LEVEL.VERBOSE);
            let nextProc = null;
            nextProc = pendingProcs[lockKey].shift();
            notifyLock();
            if (nextProc) {
                // left some
                nextProc()
                    .then()
                    .catch((err) => {
                        Logger(err);
                    })
                    .finally(() => {
                        if (pendingProcs && lockKey in pendingProcs && pendingProcs[lockKey].length == 0) {
                            delete pendingProcs[lockKey];
                            notifyLock();
                        }
                        queueMicrotask(() => {
                            handleNextProcs();
                        });
                    });
            } else {
                if (pendingProcs && lockKey in pendingProcs && pendingProcs[lockKey].length == 0) {
                    delete pendingProcs[lockKey];
                    notifyLock();
                }
            }
        }
    };
    if (runningProcs.indexOf(lockKey) != -1) {
        if (ignoreWhenRunning) {
            return null;
        }
        if (typeof pendingProcs[lockKey] === "undefined") {
            pendingProcs[lockKey] = [];
        }
        let responderRes: (value: T | PromiseLike<T>) => void;
        let responderRej: (reason?: unknown) => void;
        const responder = new Promise<T>((res, rej) => {
            responderRes = res;
            responderRej = rej;
            //wait for subproc resolved
        });
        const subproc = () =>
            new Promise<void>((res, rej) => {
                proc()
                    .then((v) => {
                        // Logger(`Lock:${key}:processed`, LOG_LEVEL.VERBOSE);
                        handleNextProcs();
                        responderRes(v);
                        res();
                    })
                    .catch((reason) => {
                        Logger(`Lock:${key}:rejected`, LOG_LEVEL.VERBOSE);
                        handleNextProcs();
                        rej(reason);
                        responderRej(reason);
                    });
            });

        pendingProcs[lockKey].push(subproc);
        notifyLock();
        // Logger(`Lock:${lockKey}:queud:left${pendingProcs[lockKey].length}`, LOG_LEVEL.VERBOSE);
        return responder;
    } else {
        runningProcs.push(lockKey);
        notifyLock();
        // Logger(`Lock:${lockKey}:aqquired`, LOG_LEVEL.VERBOSE);
        return new Promise((res, rej) => {
            proc()
                .then((v) => {
                    handleNextProcs();
                    res(v);
                })
                .catch((reason) => {
                    handleNextProcs();
                    rej(reason);
                });
        });
    }
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

    hide(): void {}
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
    return false;
}
// Referenced below
// https://zenn.dev/sora_kumo/articles/539d7f6e7f3c63
const Parallels = (ps = new Set<Promise<unknown>>()) => ({
    add: (p: Promise<unknown>) => ps.add(!!p.then(() => ps.delete(p)).catch(() => ps.delete(p)) && p),
    wait: (limit: number) => ps.size >= limit && Promise.race(ps),
    all: () => Promise.all(ps),
});
export async function allSettledWithConcurrencyLimit<T>(procs: Promise<T>[], limit: number) {
    const ps = Parallels();
    for (const proc of procs) {
        ps.add(proc);
        await ps.wait(limit);
    }
    (await ps.all()).forEach(() => {});
}
