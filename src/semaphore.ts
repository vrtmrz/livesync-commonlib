
function makeUniqueString() {
    const randomStrSrc = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
    const temp = [...Array(30)]
        .map(() => Math.floor(Math.random() * randomStrSrc.length))
        .map((e) => randomStrSrc[e])
        .join("");
    return `${Date.now()}-${temp}`;
}

export type QueueNotifier = {
    key: string;
    notify: (result: boolean) => void;
    semaphoreStopper: Promise<SemaphoreReleaser | false>;
    quantity: number;
    memo?: string;
    state: "NONE" | "RUNNING" | "DONE";
    timer?: ReturnType<typeof setTimeout>;
}
export type SemaphoreReleaser = () => void;

export type SemaphoreObject = {
    _acquire(quantity: number, memo: string, timeout: number): Promise<SemaphoreReleaser | false>;
    acquire(quantity?: number, memo?: string): Promise<SemaphoreReleaser>;
    tryAcquire(quantity: number | undefined, timeout: number, memo?: string): Promise<SemaphoreReleaser | false>;
    peekQueues(): QueueNotifier[];
    setLimit(limit: number): void;

}
/**
 * Semaphore handling lib.
 * @param limit Maximum number that can be acquired.
 * @returns Instance of SemaphoreObject
 */
export function Semaphore(limit: number, onRelease?: (currentQueue: QueueNotifier[]) => Promise<void> | void): SemaphoreObject {
    let _limit = limit;

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
        setLimit(limit) {
            _limit = limit;
        },
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
