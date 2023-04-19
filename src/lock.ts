import { Semaphore, SemaphoreObject } from "./semaphore.ts";
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

const Mutexes = {} as { [key: string]: SemaphoreObject }

function updateStore() {
    const allLocks = [...Object.values(Mutexes).map(e => e.peekQueues())].flat();
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
export async function runWithLock<T>(key: string, ignoreWhenRunning: boolean, proc: () => Promise<T>): Promise<T | null> {

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

