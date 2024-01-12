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

function _enqueue<T>(key: string | symbol, task: Task<T>, swapIfExist?: boolean): Promise<T> {
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

export function serialized<T>(key: string | symbol, proc: Task<T>): Promise<T> {
    return _enqueue(key, proc);
}

export function skipIfDuplicated<T>(key: string | symbol, proc: Task<T>): Promise<T | null> {
    if (queueTails.get(key)) return null;
    return _enqueue(key, proc);
}


export function isLockAcquired(key: string) {
    return queueTails.get(key) !== undefined;
}