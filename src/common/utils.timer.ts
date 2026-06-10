import { delay } from "octagonal-wheels/promises";

const lastProcessed = {} as Record<string, number>;
function markInterval(key: string, now?: number) {
    const next = now ?? Date.now();
    if ((lastProcessed?.[key] ?? 0) < next) {
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
