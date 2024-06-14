import { promiseWithResolver } from "../common/utils";
export type TaskProcessing<T> = Promise<T>;
export type TaskWaiting<T> = () => Promise<T>;
export type Task<T> = TaskProcessing<T> | TaskWaiting<T>;

export type TaskResult<T, U extends Error> = { ok: T } | { err: U };

export type TaskResultWithKey<T, U extends Error> = TaskResult<T, U> & { key: number };

export type ProcessingTaskResultWithKey<T, U extends Error> = Promise<TaskResultWithKey<T, U>>;

export function unwrapTaskResult<T, U extends Error>(result: TaskResult<T, U>): T | U {
    if ("ok" in result) return result.ok;
    if ("err" in result) return result.err;
    throw new Error("Argument Exception: Could not unwrap");
}
function isTaskWaiting<T>(task: Task<T>): task is TaskWaiting<T> {
    if (task instanceof Promise) {
        return false;
    }
    if (task instanceof Function) {
        return true;
    }
    throw new Error("Invalid state");

}

async function wrapEachProcess<T>(key: number, task: TaskProcessing<T>) {
    try {
        const r = await task;
        return { key, ok: r };
    } catch (ex) {
        return { key, err: ex instanceof Error ? ex : new Error(`${ex}`) }
    }
}


/**
 * Perform all tasks within given concurrency.
 * @param limit Concurrency limit
 * @param tasks Tasks to perform all
 * 
 */
export async function* processAllGeneratorTasksWithConcurrencyLimit<T>(limit: number, tasks: AsyncGenerator<Task<T>, undefined, unknown>) {
    const nowProcessing = new Map<number, ProcessingTaskResultWithKey<T, Error>>();
    let idx = 0;

    // for await (const task of tasks){

    let generatorDone = false;
    while (nowProcessing.size > 0 || !generatorDone) {
        L2:
        while (nowProcessing.size < limit && !generatorDone) {
            const w = await tasks.next();
            if (w.done) {
                generatorDone = true;
                // break L2;
            }
            if (w.value === undefined) {
                break L2;
            }
            const task = w.value;
            idx++;
            const newProcess = isTaskWaiting(task) ? task() : task;
            const wrappedPromise = wrapEachProcess(idx, newProcess);
            nowProcessing.set(idx, wrappedPromise);
        }
        const done = await Promise.race(nowProcessing.values());
        nowProcessing.delete(done.key);
        yield done;
    }
}

export async function* pipeGeneratorToGenerator<T, U>(generator: AsyncGenerator<T>, callback: (obj: T) => Promise<U>): AsyncGenerator<TaskWaiting<U>> {
    for await (const e of generator) {
        const closure = () => callback(e);
        yield closure;
    }
}
export async function* pipeArrayToGenerator<T, U>(array: T[], callback: (obj: T) => Promise<U>): AsyncGenerator<TaskWaiting<U>> {
    for (const e of array) {
        const closure = () => callback(e);
        yield closure;
    }
}

/**
 * Perform all tasks within given concurrency.
 * @param limit Concurrency limit
 * @param tasks Tasks to perform all
 * 
 */
export async function* processAllTasksWithConcurrencyLimit<T>(limit: number, tasks: Task<T>[]) {
    const nowProcessing = new Map<number, ProcessingTaskResultWithKey<T, Error>>();
    let idx = 0;
    const pendingTasks = tasks.reverse();

    while (pendingTasks.length > 0 || nowProcessing.size > 0) {
        L2:
        while (nowProcessing.size < limit && pendingTasks.length > 0) {
            const task = pendingTasks.pop(); // Pop is faster than shift.
            if (task === undefined) {
                break L2;
            }
            idx++;
            const newProcess = isTaskWaiting(task) ? task() : task;
            const wrappedPromise = wrapEachProcess(idx, newProcess);
            nowProcessing.set(idx, wrappedPromise);
        }
        const done = await Promise.race(nowProcessing.values());
        nowProcessing.delete(done.key);
        yield done;
    }
}

/**
 * Perform all tasks and returns all result by keeping the order.
 * @param limit Concurrency limit
 * @param tasks Tasks to perform all
 * @returns 
 */
export async function mapAllTasksWithConcurrencyLimit<T>(limit: number, tasks: Task<T>[]) {
    const results = new Map<number, TaskResultWithKey<T, Error>>();
    for await (const v of processAllTasksWithConcurrencyLimit(limit, tasks)) {
        results.set(v.key, v);
    }
    const ret = [...results.entries()].sort((a, b) => a[0] - b[0]).map(e => e[1]);
    return ret;
}


const tasks: { [key: string]: ReturnType<typeof setTimeout> } = {};
export function scheduleTask(key: string, timeout: number, proc: (() => Promise<any> | void), skipIfTaskExist?: boolean) {
    if (skipIfTaskExist && key in tasks) {
        return;
    }
    cancelTask(key);
    tasks[key] = setTimeout(async () => {
        delete tasks[key];
        await proc();
    }, timeout);
}
export function cancelTask(key: string) {
    if (key in tasks) {
        clearTimeout(tasks[key]);
        delete tasks[key];
    }
}
export function cancelAllTasks() {
    for (const v in tasks) {
        clearTimeout(tasks[v]);
        delete tasks[v];
    }
}
const intervals: { [key: string]: ReturnType<typeof setInterval> } = {};
export function setPeriodicTask(key: string, timeout: number, proc: (() => Promise<any> | void)) {
    cancelPeriodicTask(key);
    intervals[key] = setInterval(async () => {
        delete intervals[key];
        await proc();
    }, timeout);
}
export function cancelPeriodicTask(key: string) {
    if (key in intervals) {
        clearInterval(intervals[key]);
        delete intervals[key];
    }
}
export function cancelAllPeriodicTask() {
    for (const v in intervals) {
        clearInterval(intervals[v]);
        delete intervals[v];
    }
}


type WaitingItem = {
    waitFrom: number,
    timeout: number,
    timeoutPromise: ReturnType<typeof promiseWithResolver<boolean>>;
    timer: ReturnType<typeof setTimeout>
}
const waitingItems = new Map<string, WaitingItem>();

export function waitForTimeout(key: string, timeout: number) {
    if (waitingItems.has(key)) {
        return waitingItems.get(key)!.timeoutPromise.promise;
    }
    const timeoutPromise = promiseWithResolver<boolean>();
    const timer = setTimeout(() => {
        finishWaitingForTimeout(key, true);
    }, timeout);
    waitingItems.set(key, {
        waitFrom: Date.now(),
        timeout,
        timeoutPromise: timeoutPromise,
        timer
    });
    return timeoutPromise.promise
}
export function finishWaitingForTimeout(key: string, hasTimeout: boolean = false) {
    const x = waitingItems.get(key);
    if (x) {
        if (x.timer) clearTimeout(x.timer);
        x.timeoutPromise.resolve(hasTimeout);
        waitingItems.delete(key);
        return true;
    }
    return false;
}
export function finishAllWaitingForTimeout(prefix: string, hasTimeout: boolean) {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for (const [key, _] of waitingItems) {
        if (key.startsWith(prefix)) {
            finishWaitingForTimeout(key, hasTimeout);
        }
    }
}

export function isWaitingForTimeout(key: string) {
    return waitingItems.has(key);
}