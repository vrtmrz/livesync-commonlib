import { Logger } from "./logger";
import type { ReactiveSource } from "./reactive";
import { cancelTask, scheduleTask } from "./task";
import { LOG_LEVEL_VERBOSE } from "./types";
import { sendSignal, waitForSignal } from "./utils";

let processNo = 0;

/**
 * QueueProcessor Parameters
 */
type ProcessorParams = {
    /**
     * How many processes runs concurrently
     */
    concurrentLimit?: number;
    /**
     * Number of entities passed to the processor at once
     */
    batchSize?: number;
    /**
     * Numbers of queued entities to ignore delay and run immediately
     */
    yieldThreshold?: number;
    /**
     * Time(ms) to ignore yieldThreshold and run process
     */
    delay?: number;
    suspended: boolean;
    /**
     * ReactiveSource to notify the remaining count.
     */
    remainingReactiveSource?: ReactiveSource<number>;
    /**
     * ReactiveSource to notify the total remaining count.
     */
    totalRemainingReactiveSource?: ReactiveSource<number>;
    /**
     * If true, processed result will be buffered until a downstream has been connected.
     */
    keepResultUntilDownstreamConnected?: boolean;
};

type ProcessorResult<T> = Promise<T[]> | T[] | undefined | void | Promise<void> | Promise<undefined>;
type Processor<T, U> = (entity: T[]) => ProcessorResult<U>
export class QueueProcessor<T, U> {
    _queue: T[] = [];
    _processor: Processor<T, U>;
    _enqueueProcessor?: (queue: T[], newEntity: T) => T[] = (queue, entity) => (queue.push(entity), queue);
    _isSuspended = true;
    _nextProcessNeedsImmediate = false;
    _processing: number | undefined = undefined;
    _pipeTo?: QueueProcessor<U, any>;

    _waitId: string = "";
    _root: QueueProcessor<any, any>;
    _instance = processNo++;
    _remainingReactiveSource?: ReactiveSource<number>;
    _totalRemainingReactiveSource?: ReactiveSource<number>;
    _keepResultUntilDownstreamConnected = false;
    _keptResult = [] as U[];

    _onIdle: () => void = () => { };
    _runOnUpdateBatch: () => void = () => { };

    // Parameters

    // How many processes running concurrently
    concurrentLimit = 1;

    // How many entries processed at once
    batchSize = 1;

    // How many entries kept in before the delay
    yieldThreshold = 1;

    // If set, wait for set milliseconds after enqueued
    // Note: If reached to the batchSize, run immediately
    delay = 0;

    processingEntities = 0;

    get remaining(): number {
        return this._queue.length + this.processingEntities;
    }
    get totalRemaining(): number {
        return this.remaining + (this._pipeTo?.totalRemaining || 0);
    }

    suspend() {
        this._isSuspended = true;
        return this;
    }

    resume() {
        if (!this._isSuspended) return;
        this._isSuspended = false;
        this.requestNextFlush();
        this._run();
        return this;
    }
    resumePipeLine() {
        this._pipeTo?.resumePipeLine();
        this.resume();
        return this;
    }
    startPipeline() {
        this._root.resumePipeLine();
        return this;
    }
    get root() {
        return this._root;
    }


    constructor(processor: Processor<T, U>, params?: ProcessorParams, items?: T[], enqueueProcessor?: (queue: T[], newEntity: T) => T[]) {
        this._root = this;
        this._processor = processor;
        this.batchSize = params?.batchSize ?? 1;
        this.yieldThreshold = params?.yieldThreshold ?? params?.batchSize ?? 0;
        this.concurrentLimit = params?.concurrentLimit ?? 1;
        this.delay = params?.delay ?? 0;
        if (params?.keepResultUntilDownstreamConnected) this._keepResultUntilDownstreamConnected = params.keepResultUntilDownstreamConnected;
        if (params?.remainingReactiveSource) this._remainingReactiveSource = params?.remainingReactiveSource;
        if (params?.totalRemainingReactiveSource) this._totalRemainingReactiveSource = params?.totalRemainingReactiveSource;
        if (params?.suspended !== undefined) this._isSuspended = params?.suspended;
        if (enqueueProcessor) this.replaceEnqueueProcessor(enqueueProcessor);
        if (items) this.enqueueAll(items);

    }

    /**
     * replace enqueue logic.
     * @param processor enqueue logic. this should return new queue.
     * @returns 
     */
    replaceEnqueueProcessor(processor: (queue: T[], newItem: T) => T[]) {
        this._enqueueProcessor = processor;
        return this;
    }

    /**
     * Modify the queue by force. 
     * @param processor 
     * @remarks I know that you have known this is very dangerous.
     */
    modifyQueue(processor: (queue: T[]) => T[]) {
        this._queue = processor(this._queue);
        this._updateBatchProcessStatus();
    }

    /**
     * Clear the queue
     * @remarks I know that you have known this is very dangerous.
     */
    clearQueue() {
        this._queue = [];
        this._updateBatchProcessStatus();
    }

    /**
     * Set the handler for when the queue has been modified
     * @param proc 
     * @returns 
     */
    onUpdateProgress(proc: () => void) {
        this._runOnUpdateBatch = proc;
        return this;
    }

    /**
     * Join another processor
     * @param pipeTo 
     * @returns 
     */
    pipeTo<V>(pipeTo: QueueProcessor<U, V>) {
        this._pipeTo = pipeTo;
        this._pipeTo._root = this._root;
        // If something buffered, send to the downstream.
        if (this._keptResult.length > 0) {
            const temp = [...this._keptResult];
            this._keptResult = [];
            this._pipeTo.enqueueAll(temp);
        }
        return pipeTo;
    }

    isIdle(): boolean {
        const stat = this._queue.length == 0 && this._processing === 0;
        return stat && (!this._pipeTo ? true : this._pipeTo.isIdle());
    }

    onIdle(proc: () => void) {
        this._onIdle = proc;
        return this;
    }

    _updateReactiveSource() {
        if (this._remainingReactiveSource) this._remainingReactiveSource.value = this.remaining;
        if (this._totalRemainingReactiveSource) this._totalRemainingReactiveSource.value = this.totalRemaining;
    }

    _updateBatchProcessStatus() {
        this._updateReactiveSource();
        this._runOnUpdateBatch();
    }

    _collectBatch(): T[] {
        return this._queue.splice(0, this.batchSize);
    }
    _finalizeBatch(items: T[]) {
        this._updateBatchProcessStatus();
        return;
    }

    _spawnProcess() {
        setTimeout(() => this._process(), 0);
    }

    isAnyEntityRemaining() {
        return this._queue.length != 0;
    }

    enqueue(entity: T) {
        this._queue = this._enqueueProcessor(this._queue, entity);
        this._updateBatchProcessStatus();
        this._run();
        return this;
    }
    enqueueAll(entities: T[]) {
        let queue = this._queue;
        for (const v of entities) {
            queue = this._enqueueProcessor(queue, v);
        }
        this._queue = queue;
        this._updateBatchProcessStatus();
        this._run();
        return this;
    }

    requestNextFlush() {
        this._nextProcessNeedsImmediate = true;
    }

    flush() {
        if (this._isSuspended) return;
        cancelTask(`kickProcess-${this._instance}`);
        this._process();
        return this.waitForAllDownstream();
    }

    waitForAllDownstream(timeout?: number): Promise<boolean> {
        if (this.isIdle()) {
            return Promise.resolve(true);
        }
        if (this._waitId == "") {
            const d = Date.now() + "-" + Math.random();
            this._waitId = d;
        }
        return waitForSignal(this._waitId, timeout);
    }

    waitForPipeline(timeout?: number): Promise<boolean> {
        this._root.startPipeline();
        return this._root.waitForAllDownstream(timeout);
    }

    async _runProcessor(items: T[]) {
        const ret = await this._processor(items);
        if (!ret) return;
        // If downstream is connected, the result sent to that.
        if (this._pipeTo) {
            this._pipeTo.enqueueAll(ret);
        } else if (this._keepResultUntilDownstreamConnected) {
            // Buffer the result if downstream is not connected.
            this._keptResult.push(...ret);
        }
        // Otherwise, discarded.
    }

    async _process() {
        // If the first processing, initialize _processing
        // This is used for detecting Idle or not started.
        if (this._processing === undefined) this._processing = 0;
        // If the runner too much running, exit.
        if (this._processing >= this.concurrentLimit) return;
        if (this._isSuspended) return this._root._notifyIfIdle();

        try {
            this._processing++;
            let items: T[];
            // Collect items
            do {
                items = this._collectBatch();
                if (!items || items.length == 0) {
                    break;
                }
                const count = items.length;
                this.processingEntities += count;
                this._updateReactiveSource();
                // If we are able to processes more, and there are, perform that.
                if (this.isAnyEntityRemaining() && this._processing < this.concurrentLimit) this._spawnProcess()
                try {
                    await this._runProcessor(items);
                } catch (ex) {
                    Logger(`Processor error!`);
                    Logger(ex, LOG_LEVEL_VERBOSE);
                } finally {
                    this.processingEntities -= count;
                    this._updateReactiveSource();
                    this._finalizeBatch(items);
                }
            } while (!this._isSuspended && (!items || items.length == 0));
        } finally {
            this._processing--;
        }
        // If finished but anything was remaining, spawn a new process.
        if (this.isAnyEntityRemaining()) this._spawnProcess();
        this._root._notifyIfIdle();
    }


    _notifyIfIdle() {
        const isIdle = this.isIdle();
        if (!isIdle) return;
        this._onIdle();
        this._updateReactiveSource();
        if (this._waitId == "") return;
        const signalId = this._waitId;
        this._waitId = "";
        sendSignal(signalId);
    }

    _run() {
        if (this._isSuspended) return;
        const delay = (
            this.delay == 0 || // If do not configured delay
            (this.yieldThreshold > 0 && this._queue.length > this.yieldThreshold) || // If enough queues have accumulated
            this._nextProcessNeedsImmediate // or, If have been ordered in advance
        ) ? 0 : this.delay; // run immediately, Otherwise schedule to run after delay (ms)
        this._nextProcessNeedsImmediate = false;
        scheduleTask(`kickProcess-${this._instance}`, delay, () => this._process())
    }
}
export type QueueItemWithKey<T> = { entity: T; key: string | symbol };
export class KeyedQueueProcessor<T, U> extends QueueProcessor<QueueItemWithKey<T>, U> {
    processingKeys = new Set<string | symbol>();
    _collectBatch(): QueueItemWithKey<T>[] {
        const items: QueueItemWithKey<T>[] = [];
        let i = 0;
        do {
            if (i >= this._queue.length) break;
            const key = this._queue[i].key;
            // If already running or planned to be run, skip item
            if (this.processingKeys.has(key)) {
                i++;
                continue;
            }
            this.processingKeys.add(key);
            items.push(this._queue[i]);
            this._queue.splice(i, 1);
            if (items.length >= this.batchSize) break;
        } while (i + 1 < this._queue.length);
        return items;
    }

    constructor(processor: Processor<T, U>, params?: ProcessorParams) {
        const proc = (e: QueueItemWithKey<T>[]) => processor(e.map((e) => e.entity));
        super(proc, params);
    }
    _finalizeBatch(items: QueueItemWithKey<T>[]): void {
        for (const item of items) {
            this.processingKeys.delete(item.key);
        }
        super._finalizeBatch(items);
    }
    isAnyEntityRemaining() {
        return this._queue.filter((e) => !this.processingKeys.has(e.key)).length != 0;
    }

    enqueueWithKey(key: string | symbol, entity: T) {
        this.enqueue({ entity, key });
        return this;
    }
}