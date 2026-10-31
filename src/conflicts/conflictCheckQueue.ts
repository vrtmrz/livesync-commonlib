import type { FilePathWithPrefix } from "../common/types.ts";
import { createKeyedPendingWork } from "../concurrency/keyedPendingWork.ts";
import { createNotifier } from "octagonal-wheels/concurrency/notifier";
import { forEachInScope } from "octagonal-wheels/concurrency/scoped.iteration";
import { withScope, type Awaitable, type Scope } from "octagonal-wheels/resource/scope";

/** Host-owned conflict processing and observation for one queue. */
export interface ConflictCheckQueueOptions {
    /** Process one admitted path. Deferred cleanup occupies the same execution slot. */
    readonly process: (path: FilePathWithPrefix, scope: Scope<undefined>) => Awaitable<unknown>;
    /** Positive safe integer; defaults to ten. Pending paths have no fixed capacity. */
    readonly concurrency?: number;
    /** Observe pending plus active checks. A thrown error stops the queue after active work settles. */
    readonly onProgress?: (remaining: number) => void;
}

/** One queue owns pending checks; the host owns conflict decisions and recovery policy. */
export interface ConflictCheckQueue {
    /** Accept a path without waiting for its check; a pending duplicate moves to the tail. */
    enqueue(path: FilePathWithPrefix): void;
    /** Wait for quiescence, including requeues and cleanup; false means the queue was aborted. Do not await from its processor. */
    waitForIdle(): Promise<boolean>;
    /** Stop admission and drain accepted work. A processor must not await its own queue's closure. */
    close(): Promise<boolean>;
    /** Stop admission and dispatch, join active cleanup, and return the retained, unstarted paths. */
    abort(): Promise<readonly FilePathWithPrefix[]>;
    /** Snapshot of unstarted paths; retained after abort or failure for the host to inspect. */
    readonly pending: readonly FilePathWithPrefix[];
    /** Pending and active checks, including item cleanup. */
    readonly remaining: number;
}

/**
 * Compose keyed pending checks with bounded scoped execution.
 *
 * Input is accepted synchronously without a fixed pending-count limit. Each
 * execution consumes a synchronous iterable which ends when no pending path
 * remains; later arrivals join it or start the next execution. An empty queue has no input read,
 * timer, or worker waiting in the background.
 *
 * Replacement affects unclaimed entries only. A running check may enqueue its
 * own path without waiting for an execution slot. It is not cancelled or replaced
 * by that later input. The host remains responsible for serialising any shared
 * resource or interaction inside the processor.
 *
 * Unhandled processing, cleanup, or observation errors stop further dispatch.
 * Started work and cleanup settle before completion waiters reject; unstarted
 * paths remain inspectable. Catch an item error inside process when the host's
 * explicit policy is to log and continue. There is no implicit retry or logging.
 */
export function createConflictCheckQueue(options: ConflictCheckQueueOptions): ConflictCheckQueue {
    const concurrency = options.concurrency ?? 10;
    if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
        throw new RangeError("Conflict check concurrency must be a positive safe integer.");
    }
    const pending = createKeyedPendingWork<FilePathWithPrefix, FilePathWithPrefix>((path) => path);
    const changed = createNotifier();
    const failures: unknown[] = [];
    let accepting = true;
    let aborted = false;
    let stoppingAfterFailure = false;
    let active = 0;
    let running: Promise<void> | undefined;

    const remaining = () => pending.size + active;
    const canDispatch = () => !aborted && !stoppingAfterFailure && failures.length === 0;
    const recordFailure = (error: unknown) => {
        accepting = false;
        stoppingAfterFailure = true;
        failures.push(error);
        changed.notify();
    };
    const reportProgress = () => {
        if (failures.length === 0) {
            try {
                options.onProgress?.(remaining());
            } catch (error) {
                recordFailure(error);
            }
        }
        changed.notify();
    };

    function* availableWork() {
        while (canDispatch()) {
            const entry = pending.peek();
            if (!entry) return;
            // Claim only when the callback starts: iteration may stop after a
            // pull, or a later input may replace this entry before dispatch.
            yield entry;
        }
    }

    function schedule(): void {
        if (running || !canDispatch() || pending.size === 0) return;
        running = Promise.resolve()
            .then(() =>
                withScope(undefined, (parent) =>
                    forEachInScope(parent, availableWork(), { concurrency }, async (entry, child) => {
                        if (!canDispatch() || !pending.claim(entry)) return;
                        active++;
                        // Register first so the host's item cleanup finishes
                        // before the check leaves the remaining count.
                        child.defer(() => {
                            active--;
                            reportProgress();
                        });
                        reportProgress();
                        try {
                            await options.process(entry.value, child);
                        } catch (error) {
                            accepting = false;
                            stoppingAfterFailure = true;
                            throw error;
                        }
                    })
                )
            )
            .then((): void => undefined, recordFailure)
            .finally(() => {
                running = undefined;
                schedule();
                changed.notify();
            });
    }

    async function waitForIdle(): Promise<boolean> {
        schedule();
        while (running) await changed.wait();
        if (failures.length === 1) throw failures[0];
        if (failures.length > 1) throw new AggregateError(failures, "Conflict checks failed.");
        return !aborted;
    }

    return {
        enqueue(path) {
            if (!accepting) throw new Error("The conflict check queue is closed.");
            pending.add(path);
            reportProgress();
            schedule();
        },
        waitForIdle,
        close() {
            accepting = false;
            schedule();
            return waitForIdle();
        },
        async abort() {
            accepting = false;
            aborted = true;
            changed.notify();
            await waitForIdle();
            return pending.values();
        },
        get pending() {
            return pending.values();
        },
        get remaining() {
            return remaining();
        },
    };
}
