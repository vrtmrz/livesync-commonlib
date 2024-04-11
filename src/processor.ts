import { Logger } from "./logger.ts";
import type { ReactiveSource } from "./reactive.ts";
import { LOG_LEVEL_VERBOSE, RESULT_TIMED_OUT } from "./types.ts";
import { delay, fireAndForget, promiseWithResolver } from "./utils.ts";

class Notifier {
    p = promiseWithResolver<void>();
    notify() {
        this.p.resolve()
        this.p = promiseWithResolver();
    }
    get nextNotify() {
        return this.p.promise;
    }
}
let processNo = 0;


/**
 * QueueProcessor Parameters
 */
type ProcessorParams<T> = {
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
    interval?: number;
    maintainDelay?: boolean;
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
     * ReactiveSource to notify how many items are processing;
     */
    processingEntitiesReactiveSource?: ReactiveSource<number>;
    /**
     * If true, processed result will be buffered until a downstream has been connected.
     */
    keepResultUntilDownstreamConnected?: boolean;
    pipeTo?: QueueProcessor<T, any>;
};

type ProcessorResult<T> = Promise<T[]> | T[] | undefined | void | Promise<void> | Promise<undefined>;
type Processor<T, U> = (entity: T[]) => ProcessorResult<U>
export class QueueProcessor<T, U> {
    _queue: T[] = [];
    _processor: Processor<T, U>;
    _enqueueProcessor: (queue: T[], newEntity: T) => T[] = (queue, entity) => (queue.push(entity), queue);
    _isSuspended = true;
    _nextProcessNeedsImmediate = false;

    _pipeTo?: QueueProcessor<U, any>;

    _waitId: string = "";
    _root: QueueProcessor<any, any>;
    _instance = processNo++;
    _remainingReactiveSource?: ReactiveSource<number>;
    _totalRemainingReactiveSource?: ReactiveSource<number>;
    _processingEntitiesReactiveSource?: ReactiveSource<number>;
    _keepResultUntilDownstreamConnected = false;
    _keptResult = [] as U[];

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
    maintainDelay: boolean;
    interval = 0;

    processingEntities = 0;
    waitingEntries = 0;

    get nowProcessing(): number {
        return this.processingEntities
    }
    get totalNowProcessing(): number {
        return this.nowProcessing + (this._pipeTo?.totalNowProcessing || 0);
    }

    get remaining(): number {
        return this._queue.length + this.processingEntities + this.waitingEntries;
    }
    get totalRemaining(): number {
        return this.remaining + (this._pipeTo?.totalRemaining || 0);
    }
    updateStatus(setFunc: () => void) {
        setFunc();
        this._updateReactiveSource();
    }

    suspend() {
        this._isSuspended = true;
        this._notifier.notify();
        return this;
    }

    resume() {
        this._isSuspended = false;
        this._notifier.notify();
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

    _notifier = new Notifier();

    constructor(processor: Processor<T, U>, params?: ProcessorParams<U>, items?: T[], enqueueProcessor?: (queue: T[], newEntity: T) => T[]) {
        this._root = this;
        this._processor = processor;
        this.batchSize = params?.batchSize ?? 1;
        this.yieldThreshold = params?.yieldThreshold ?? params?.batchSize ?? 0;
        this.concurrentLimit = params?.concurrentLimit ?? 1;
        this.delay = params?.delay ?? 0;
        this.maintainDelay = params?.maintainDelay ?? false;
        this.interval = params?.interval ?? 0;
        if (params?.keepResultUntilDownstreamConnected) this._keepResultUntilDownstreamConnected = params.keepResultUntilDownstreamConnected;
        if (params?.remainingReactiveSource) this._remainingReactiveSource = params?.remainingReactiveSource;
        if (params?.totalRemainingReactiveSource) this._totalRemainingReactiveSource = params?.totalRemainingReactiveSource;
        if (params?.processingEntitiesReactiveSource) this._processingEntitiesReactiveSource = params?.processingEntitiesReactiveSource;
        if (params?.suspended !== undefined) this._isSuspended = params?.suspended;
        if (enqueueProcessor) this.replaceEnqueueProcessor(enqueueProcessor);
        if (params?.pipeTo !== undefined) {
            this.pipeTo(params.pipeTo);
        }
        if (items) this.enqueueAll(items);
        this._run();
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
        this._notifier.notify();
    }

    /**
     * Clear the queue
     * @remarks I know that you have known this is very dangerous.
     */
    clearQueue() {
        this._queue = [];
        this._notifier.notify();
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
        return this._isIdle() && (!this._pipeTo ? true : this._pipeTo.isIdle());
    }
    _isIdle() {
        return this.totalRemaining == 0;
    }
    async _idleDetector(): Promise<void> {
        if (this._isSuspended) return Promise.resolve();
        if (this._isIdle()) return Promise.resolve();
        do {
            await Promise.race([delay(3000), this._notifier.nextNotify]);
        } while (!this._isIdle());
        return Promise.resolve();
    }

    idleDetectors(): Promise<void>[] {
        const thisPromise = this._idleDetector();
        if (this._pipeTo) {
            return [thisPromise, ...this._pipeTo.idleDetectors()];
        }
        return [thisPromise];
    }

    get isSuspended(): boolean {
        return this._isSuspended || this._pipeTo?.isSuspended || false;
    }


    _updateReactiveSource() {
        this._root.updateReactiveSource();
    }
    updateReactiveSource() {
        if (this._pipeTo) {
            this._pipeTo.updateReactiveSource();
        }
        if (this._remainingReactiveSource) this._remainingReactiveSource.value = this.remaining;
        if (this._totalRemainingReactiveSource) this._totalRemainingReactiveSource.value = this.totalRemaining;
        if (this._processingEntitiesReactiveSource) this._processingEntitiesReactiveSource.value = this.nowProcessing;

    }
    _updateBatchProcessStatus() {
        this._updateReactiveSource();
        this._runOnUpdateBatch();
    }

    _collectBatch(): T[] {
        return this._queue.splice(0, this.batchSize);
    }
    _canCollectBatch(): boolean {
        return this._queue.length !== 0;
    }


    enqueue(entity: T) {
        this._queue = this._enqueueProcessor(this._queue, entity);
        this._updateBatchProcessStatus()
        this._notifier.notify();
        return this;
    }
    enqueueAll(entities: T[]) {
        let queue = this._queue;
        for (const v of entities) {
            queue = this._enqueueProcessor(queue, v);
        }
        this._queue = queue;
        this._updateBatchProcessStatus()
        this._notifier.notify();
        return this;
    }

    requestNextFlush() {
        if (this._canCollectBatch()) {
            this._nextProcessNeedsImmediate = true;
            this._notifier.notify();
        }
    }

    flush() {
        if (this._isSuspended) return;
        this.requestNextFlush();
        return this.waitForAllDownstream();
    }

    async waitForAllDownstream(timeout?: number): Promise<boolean> {
        // Prepare timeout detector
        const baseTasks = [] as Promise<unknown>[];
        if (timeout) {
            baseTasks.push(delay(timeout, RESULT_TIMED_OUT))
        }
        do {
            const idleTasks = this.idleDetectors();
            const tasks = [...baseTasks, Promise.all(idleTasks)];
            const ret = await Promise.race(tasks);
            if (ret === RESULT_TIMED_OUT) return false;
        } while (!this.isIdle());
        return true;
    }

    waitForPipeline(timeout?: number): Promise<boolean> {
        this._root.startPipeline();
        return this._root.waitForAllDownstream(timeout);
    }

    async _runProcessor(items: T[]) {
        // runProcessor does not modify queue. so updateStatus should only update about reactiveSource.
        this.updateStatus(() => {
            this.processingEntities += items.length;
            this.waitingEntries -= items.length;
        });
        try {
            const ret = await this._processor(items);
            if (!ret) return;
            // If downstream is connected, the result sent to that.
            if (this._pipeTo) {
                this._pipeTo.enqueueAll(ret);
            } else if (this._keepResultUntilDownstreamConnected) {
                // Buffer the result if downstream is not connected.
                this._keptResult.push(...ret);
            }
        } finally {
            this.updateStatus(() => {
                this.processingEntities -= items.length;
            });
        }
    }
    async * pump() {
        let items: T[];
        let queueRunOut = true;
        do {
            if (!this._canCollectBatch()) {
                // If we cannot collect any items from the queue, sleep until a next notify
                queueRunOut = true;
                await Promise.race([this._notifier.nextNotify, delay(3000)]);
                continue;
            }
            // Here, we have some items in the queue.
            if (queueRunOut) {
                // If the pump has been slept, wait for the chance to accumulate some more in the queue.
                await this.delayUntilRequested(this.delay);
            }
            items = this._collectBatch();
            // If the queue has been modified (by modifyQueue or something).
            // We have to try from the begin again.
            if (items.length == 0) {
                continue;
            }
            this.updateStatus(() => {
                this.waitingEntries += items.length;
            })
            yield items;
            // For subsequent processes, check run out status
            if (this._canCollectBatch()) {
                queueRunOut = false;
            }
        } while (this._canCollectBatch() && !this._isSuspended)
    }
    _processingBatches = new Set<number>();
    addProcessingBatch: (typeof this._processingBatches.add) = (value) => {
        const r = this._processingBatches.add(value);
        this._updateBatchProcessStatus();
        return r;
    }
    deleteProcessingBatch: (typeof this._processingBatches.delete) = (value) => {
        const r = this._processingBatches.delete(value);
        this._updateBatchProcessStatus();
        return r;
    }
    _processing: boolean = false;

    async delayUntilRequested(delayMs: number) {
        if (this._nextProcessNeedsImmediate) {
            this._nextProcessNeedsImmediate = false;
            return;
        }
        const delayTimer = delay(delayMs, RESULT_TIMED_OUT);
        let ret;
        do {
            ret = await Promise.race([this._notifier.nextNotify, delayTimer]);
        } while (
            ret !== RESULT_TIMED_OUT &&
            this._nextProcessNeedsImmediate === false &&
            this.yieldThreshold >= this._queue.length
        )
        this._nextProcessNeedsImmediate = false;
        return;
    }

    async _process() {
        if (this._processing && this._isSuspended) return;
        let lastProcessBegin = 0;
        try {
            this._processing = true;
            do {
                const batchPump = this.pump()
                for await (const batch of batchPump) {
                    while (this._processingBatches.size >= this.concurrentLimit) {
                        await this._notifier.nextNotify;
                    }
                    // Add batch to the processing
                    const key = Date.now() + Math.random();
                    const batchTask = async () => {
                        try {
                            if (this.interval && lastProcessBegin) {
                                const diff = Date.now() - lastProcessBegin;
                                if (diff < this.interval) {
                                    const delayMs = this.interval - diff;
                                    await delay(delayMs);
                                }
                            }
                            lastProcessBegin = Date.now();
                            await this._runProcessor(batch);
                        } catch (ex) {
                            Logger(`Processor error!`);
                            Logger(ex, LOG_LEVEL_VERBOSE);
                        } finally {
                            this.deleteProcessingBatch(key);
                            this._notifier.notify();
                        }
                    }
                    this.addProcessingBatch(key);
                    this._notifier.notify();
                    fireAndForget(batchTask);
                }
                await this._notifier.nextNotify;
            } while (!this._isSuspended)
        } finally {
            this._processing = false;
        }
    }

    _run() {
        if (this._isSuspended) return;
        if (this._processing) return;
        fireAndForget(() => this._process());
    }
}