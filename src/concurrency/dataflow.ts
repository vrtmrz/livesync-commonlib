export class DelayBatchTransformer<T> {
    delay: number;
    batchSize: number;
    batch: T[];
    timeout: ReturnType<typeof setTimeout> | undefined;
    constructor(delay: number, batchSize: number) {
        this.delay = delay;
        this.batchSize = batchSize;
        this.batch = [];
        this.timeout = undefined;
    }

    transform(chunk: T, controller: TransformStreamDefaultController<T[]>) {
        this.batch.push(chunk);
        if (this.batch.length >= this.batchSize) {
            this.flushBatch(controller);
        } else if (!this.timeout) {
            this.timeout = setTimeout(() => this.flushBatch(controller), this.delay);
        }
    }

    flushBatch(controller: TransformStreamDefaultController<T[]>) {
        if (this.batch.length > 0) {
            controller.enqueue(this.batch);
            this.batch = [];
        }
        if (this.timeout) {
            clearTimeout(this.timeout);
            this.timeout = undefined;
        }
    }

    flush(controller: TransformStreamDefaultController<T[]>) {
        this.flushBatch(controller);
    }
}

type RunningTask = {
    promise: Promise<void>;
    isRunning: boolean;
};
// Concurrent limit transformer

export class ConcurrentLimitTransformer<T, U> {
    processer: RunningTask[];
    queue: T[] = [];

    constructor(
        public concurrentLimit: number,
        public processor: (item: T) => Promise<U>
    ) {
        this.processer = new Array(concurrentLimit).fill(undefined).map(() => ({
            promise: Promise.resolve(),
            isRunning: false,
        }));
    }

    transform(item: T, controller: TransformStreamDefaultController<U>) {
        this.queue.push(item);
        this.processQueuedItems(controller);
    }

    processQueuedItems(controller: TransformStreamDefaultController<U>) {
        let idx = -1;
        do {
            idx = this.processer.findIndex((p) => !p.isRunning);
            if (idx == -1) {
                // NO OP. All processer are running
                break;
            } else {
                if (this.queue.length == 0) {
                    break;
                }
                const nextItem = this.queue.shift()!;
                this.processer[idx].isRunning = true;
                this.processItem(idx, nextItem, controller);
            }
        } while (idx != -1);
    }

    processItem(idx: number, nextItem: T, controller: TransformStreamDefaultController<U>) {
        queueMicrotask(() => {
            this.processer[idx].promise = this.processer[idx].promise
                .then(async () => {
                    const result = await this.processor(nextItem);
                    controller.enqueue(result);
                })
                .catch((e) => {
                    controller.error(e);
                })
                .finally(() => {
                    this.processer[idx].isRunning = false;
                    if (this.queue.length > 0) {
                        this.processQueuedItems(controller);
                    }
                });
        });
    }
}

type OrderedItem<T> = {
    order: number;
    item: T;
};

type OrderedResult<T> = {
    order: number;
    item?: T;
    processed: boolean;
};
export class OrderedConcurrentLimitTransformer<T, U> {
    processer: RunningTask[];
    queue: OrderedItem<T>[] = [];
    results: OrderedResult<U>[] = [];

    order = 0;

    constructor(
        public concurrentLimit: number,
        public processor: (item: T) => Promise<U>
    ) {
        this.processer = new Array(concurrentLimit).fill(undefined).map(() => ({
            promise: Promise.resolve(),
            isRunning: false,
        }));
    }

    transform(item: T, controller: TransformStreamDefaultController<U>) {
        const order = this.order++;
        this.results.push({ order, processed: false });
        this.queue.push({ order, item });
        this.processQueuedItems(controller);
    }

    processQueuedItems(controller: TransformStreamDefaultController<U>) {
        let idx = -1;
        do {
            idx = this.processer.findIndex((p) => !p.isRunning);
            if (idx == -1) {
                // NO OP. All processer are running
                break;
            } else {
                if (this.queue.length == 0) {
                    break;
                }
                const nextItem = this.queue.shift()!;
                this.processer[idx].isRunning = true;
                this.processItem(idx, nextItem, controller);
            }
        } while (idx != -1);
    }

    processItem(idx: number, nextItem: OrderedItem<T>, controller: TransformStreamDefaultController<U>) {
        queueMicrotask(() => {
            this.processer[idx].promise = this.processer[idx].promise
                .then(async () => {
                    const result = await this.processor(nextItem.item);
                    const order = nextItem.order;
                    const resultItem = this.results.find((r) => r.order == order);
                    if (!resultItem) {
                        throw new Error("Result is not exist on the waiting list");
                    }
                    resultItem.item = result;
                    resultItem.processed = true;
                    // Send and remove processed items until reach the first unprocessed item
                    while (this.results.length > 0 && this.results[0].processed) {
                        const r = this.results.shift()!;
                        controller.enqueue(r.item);
                    }
                })
                .catch((e) => {
                    controller.error(e);
                })
                .finally(() => {
                    this.processer[idx].isRunning = false;
                    if (this.queue.length > 0) {
                        this.processQueuedItems(controller);
                    }
                });
        });
    }
}

// Interval transformer
export class IntervalTransformer<T> {
    lastProcessTime: number;

    constructor(public interval: number) {
        this.lastProcessTime = 0;
    }

    async transform(chunk: T, controller: TransformStreamDefaultController<T>) {
        const now = Date.now();
        const timeSinceLastProcess = now - this.lastProcessTime;
        if (timeSinceLastProcess < this.interval) {
            await new Promise((resolve) => setTimeout(resolve, this.interval - timeSinceLastProcess));
        }
        this.lastProcessTime = Date.now();
        controller.enqueue(chunk);
    }
}

export function sink<T>(onData: (chunk: T) => void, onEnd?: () => void) {
    return new WritableStream<T>({
        write(chunk) {
            onData(chunk);
        },
        close() {
            onEnd?.();
        },
    });
}

export function source<T>(onStart: (controller: ReadableStreamDefaultController<T>) => void) {
    return new ReadableStream<T>({
        start(controller) {
            onStart(controller);
        },
    });
}
export function emitter<T>() {
    let emit: (item: T) => void = () => {};
    const _source = source<T>((controller) => {
        emit = (item) => controller.enqueue(item);
    });
    return { source: _source, emit };
}

export function adapter<T>(transform: (chunk: T, controller: TransformStreamDefaultController<T>) => void) {
    return new TransformStream<T, T>({
        transform(chunk, controller) {
            transform(chunk, controller);
        },
    });
}
