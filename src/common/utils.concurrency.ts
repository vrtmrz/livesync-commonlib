import { Semaphore } from "octagonal-wheels/concurrency/semaphore";
import { isErrorOfMissingDoc } from "@lib/pouchdb/utils_couchdb.ts";
import { ensureError } from "./utils.object.ts";
import { LiveSyncError } from "./LSError.ts";

export function resolveWithIgnoreKnownError<T>(p: Promise<T>, def: T): Promise<T> {
    return new Promise((res, rej) => {
        p.then(res).catch((ex) => (isErrorOfMissingDoc(ex) ? res(def) : rej(ensureError(ex))));
    });
}

// Referenced below
// https://zenn.dev/sora_kumo/articles/539d7f6e7f3c63
export const Parallels = (ps = new Set<Promise<unknown>>()) => ({
    // eslint-disable-next-line @typescript-eslint/no-misused-promises
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
    (await ps.all()).forEach(() => {});
}

export const globalConcurrencyController = Semaphore(50);

export async function wrapException<T>(func: () => Promise<Awaited<T>>): Promise<Awaited<T> | Error> {
    try {
        return await func();
    } catch (ex: unknown) {
        if (ex instanceof Error) {
            return ex;
        }
        return LiveSyncError.fromError(ex);
    }
}

export function wrapByDefault<T, U>(func: () => T, onError: (err: Error) => U): T | U {
    try {
        return func();
    } catch (ex) {
        const error = ex instanceof Error ? ex : new Error(String(ex));
        return onError(error);
    }
}
