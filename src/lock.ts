import { Semaphore, type SemaphoreObject } from "./semaphore.ts";
import { lockStore } from "./stores.ts";


// --- asynchronous execution / locking utilities

let externalNotifier: () => void = () => { };
let notifyTimer: ReturnType<typeof setTimeout> | null = null;

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

const mutexes = new Map<string, SemaphoreObject>();

function updateStore() {
    const allLocks = [...Object.values(mutexes).map(e => e.peekQueues())].flat();
    lockStore.apply((v => ({
        ...v, count: allLocks.length,
        pending: allLocks.filter((e) => e.state == "NONE").map((e) => e.memo ?? ""),
        running: allLocks.filter((e) => e.state == "RUNNING").map((e) => e.memo ?? ""),
    })));
}
export function getLocks() {
    return lockStore.peek();
}

export function getProcessingCounts() {
    return lockStore.peek()?.count || 0;
}

let semaphoreReleasedCount = 0;

const LOCKMODE_SKIP = 0 as const;
const LOCKMODE_SERIALIZED = 1 as const;
const LOCKMODE_SCHEDULE = 2 as const;
type LockMode = typeof LOCKMODE_SCHEDULE | typeof LOCKMODE_SERIALIZED | typeof LOCKMODE_SKIP;

const CANCEL_LOCK = Symbol("CANCEL_LOCK");

async function _runWithLock<T>(key: string, lockMode: LockMode, concurrency: number, proc: () => Promise<T>): Promise<T | null | typeof CANCEL_LOCK> {

    if (semaphoreReleasedCount > 200) {
        const deleteKeys = [] as string[];
        for (const key in mutexes) {
            if (mutexes.get(key).peekQueues().length == 0) {
                deleteKeys.push(key);
            }
        }
        for (const key of deleteKeys) {
            mutexes.delete(key);
        }
        semaphoreReleasedCount = 0;
    }
    if (!mutexes.has(key)) {
        mutexes.set(key, Semaphore(concurrency, (queue => {
            if (queue.length == 0) semaphoreReleasedCount++;
        })));
    }
    const mutex = mutexes.get(key)!;
    if (concurrency != 1) {
        mutex.setLimit(concurrency);
    }

    const timeout = lockMode == LOCKMODE_SKIP ? 1 : 0;
    const releaser = await mutex.tryAcquire(1, timeout, key);
    updateStore();
    if (!releaser) return null;
    try {

        return await proc();
    } finally {
        releaser();
        notifyLock();
        updateStore();
    }

}
export function runWithLock<T>(key: string, ignoreWhenRunning: boolean, proc: () => Promise<T>): Promise<T | null> {
    return _runWithLock(key, ignoreWhenRunning ? LOCKMODE_SKIP : LOCKMODE_SERIALIZED, 1, proc) as Promise<T | null>;
}
export function serialized<T>(key: string, proc: () => Promise<T>): Promise<T | null> {
    return _runWithLock(key, LOCKMODE_SERIALIZED, 1, proc) as Promise<T | null>;
}

export function skipIfDuplicated<T>(key: string, proc: () => Promise<T>): Promise<T | null> {
    return _runWithLock(key, LOCKMODE_SKIP, 1, proc) as Promise<T | null>;
}

const waitingProcess = new Map<string, () => Promise<any>>();
export async function scheduleOnceIfDuplicated<T>(key: string, proc: () => Promise<T>): Promise<void> {
    if (isLockAcquired(key)) {
        waitingProcess.set(key, proc);
        return;
    }
    await serialized(key, proc);
    if (waitingProcess.has(key)) {
        const nextProc = waitingProcess.get(key);
        waitingProcess.delete(key);
        scheduleOnceIfDuplicated(key, nextProc);
    }
}

export function isLockAcquired(key: string) {
    return (mutexes.get(key)?.peekQueues()?.length ?? 0) != 0;
}