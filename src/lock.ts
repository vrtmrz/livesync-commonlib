type Task<T> = () => Promise<T> | T;
type Queue<T> = {
    key: string | symbol,
    task: Task<T>,
    resolver: (result: T) => void,
    rejector: (reason?: any) => void
    next?: Queue<T>
}


const queueTails = new Map<string | symbol, Queue<any> | undefined>();

async function performTask<T>(queue: Queue<T>) {
    const key = queue.key
    try {
        const ret = await queue.task();
        queue.resolver(ret);
    } catch (ex) {
        queue.rejector(ex);
    } finally {
        const next = queue.next;
        queueTails.set(key, next);
        if (next) {
            performTask(next);
        }
    }
    return;

}

// --- asynchronous execution / locking utilities

type QueueOptions = {
    swapIfExist?: boolean
    shareResult?: boolean
}

function _enqueue<T>(key: string | symbol, task: Task<T>, { swapIfExist, shareResult }: QueueOptions = {}): Promise<T> {
    let resolver: (result: T) => void = () => { };
    let rejector: (reason?: any) => void = () => { };
    const tempResult = new Promise<T>((res, rej) => {
        resolver = res, rejector = rej;
    })

    const newQueue: Queue<T> = {
        task,
        resolver,
        rejector,
        key
    }

    const prev = queueTails.get(key);
    if (prev === undefined) {
        queueTails.set(key, newQueue);
        performTask(newQueue);
    } else {
        const current = prev as Queue<T>;
        queueTails.set(key, newQueue)
        current.next = newQueue;
        if (swapIfExist) {
            // Force cancel previous one
            current.rejector(new Error("Cancelled"));
        }
    }
    return tempResult;
}

/**
 * Run tasks one by one in their group.
 * @param key key of the group
 * @param proc process to run
 * @returns result of the process
 */
export function serialized<T>(key: string | symbol, proc: Task<T>): Promise<T> {
    return _enqueue(key, proc);
}

/**
 * If free, run task and return the result (Same as serialized).
 * If any process has running, share the result.
 * @param key key of the group
 * @param proc process to run
 */
export function shareRunningResult<T>(key: string | symbol, proc: Task<T>): Promise<T> {
    const current = queueTails.get(key);
    if (!current) return _enqueue(key, proc);
    // Buffer old resolve wrapper
    const oldResolver = current.resolver;
    const oldRejector = current.rejector;
    let resolver: (result: T) => void = () => { };
    let rejector: (reason?: any) => void = () => { };
    // Prepare Promise of shared result 
    const tempResult = new Promise<T>((res, rej) => {
        resolver = res, rejector = rej;
    });

    // Inject hooked handler
    current.resolver = (result) => {
        oldResolver(result);
        resolver(result);
    }
    current.rejector = (result) => {
        oldRejector(result);
        rejector(result);
    }
    return tempResult;
}

export function skipIfDuplicated<T>(key: string | symbol, proc: Task<T>): Promise<T | null> {
    if (queueTails.get(key) !== undefined) return Promise.resolve(null);
    return _enqueue(key, proc);
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
        scheduleOnceIfDuplicated(key, nextProc as () => Promise<T>);
    }
}
export function isLockAcquired(key: string) {
    return queueTails.get(key) !== undefined;
}

