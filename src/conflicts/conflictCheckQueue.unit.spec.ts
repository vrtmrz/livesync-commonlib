import { describe, expect, it, vi } from "vitest";
import type { FilePathWithPrefix } from "../common/types.ts";
import { createConflictCheckQueue } from "./conflictCheckQueue.ts";

type QueueOptions = Parameters<typeof createConflictCheckQueue>[0];
type Processor = QueueOptions["process"];

function makeQueue(process: Processor, options: Omit<QueueOptions, "process"> = {}) {
    return createConflictCheckQueue({ ...options, process });
}

function asPath(value: string): FilePathWithPrefix {
    return value as FilePathWithPrefix;
}

function deferred() {
    let resolve!: () => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<void>((resolvePromise, rejectPromise) => {
        resolve = () => resolvePromise();
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
}

function barrier(target: number) {
    const reached = deferred();
    let count = 0;
    return {
        promise: reached.promise,
        signal() {
            count++;
            if (count === target) reached.resolve();
        },
    };
}

describe("createConflictCheckQueue", () => {
    it("starts processing asynchronously without scheduling a timer", async () => {
        vi.useFakeTimers();
        try {
            const path = asPath("note.md");
            const started = deferred();
            let didStart = false;
            const queue = makeQueue(() => {
                didStart = true;
                started.resolve();
            });

            queue.enqueue(path);

            expect(didStart).toBe(false);
            expect(vi.getTimerCount()).toBe(0);
            await started.promise;
            await expect(queue.waitForIdle()).resolves.toBe(true);
        } finally {
            vi.useRealTimers();
        }
    });

    it("includes accepted work when a progress observer waits before dispatch starts", async () => {
        const started = deferred();
        const finish = deferred();
        let idleSettled = false;
        let completion: Promise<boolean> | undefined;
        let queue!: ReturnType<typeof makeQueue>;
        queue = makeQueue(
            () => {
                started.resolve();
                return finish.promise;
            },
            {
                onProgress(remaining) {
                    if (remaining > 0 && !completion) {
                        completion = queue.waitForIdle().then((result) => {
                            idleSettled = true;
                            return result;
                        });
                    }
                },
            }
        );

        queue.enqueue(asPath("observed.md"));
        await started.promise;
        try {
            expect(completion).toBeDefined();
            expect(idleSettled).toBe(false);
        } finally {
            finish.resolve();
            await queue.waitForIdle();
        }
        await expect(completion).resolves.toBe(true);
    });

    it("accepts more pending paths than concurrency and moves a pending duplicate to the tail", async () => {
        const activePath = asPath("active.md");
        const activeGate = deferred();
        const activeStarted = deferred();
        const calls: FilePathWithPrefix[] = [];
        const queue = makeQueue(
            (path) => {
                calls.push(path);
                if (path === activePath) {
                    activeStarted.resolve();
                    return activeGate.promise;
                }
            },
            { concurrency: 1 }
        );
        const count = 1024;
        const paths = Array.from({ length: count }, (_, index) => asPath(`queued-${index}.md`));

        queue.enqueue(activePath);
        await activeStarted.promise;
        for (const path of paths) queue.enqueue(path);

        const duplicateIndex = 12;
        const duplicate = paths[duplicateIndex]!;
        queue.enqueue(duplicate);
        const expectedPending = paths.filter((_, index) => index !== duplicateIndex).concat(duplicate);

        expect(queue.pending).toEqual(expectedPending);
        expect(queue.pending.length).toBeGreaterThan(1);
        expect(queue.remaining).toBe(count + 1);

        const abort = queue.abort();
        activeGate.resolve();
        await expect(abort).resolves.toEqual(expectedPending);
        expect(queue.pending).toEqual(expectedPending);
        expect(calls).toEqual([activePath]);
    });

    it("uses the default concurrency of ten", async () => {
        const paths = Array.from({ length: 11 }, (_, index) => asPath(`default-${index}.md`));
        const gates = paths.map(() => deferred());
        const tenStarted = barrier(10);
        const eleventhStarted = deferred();
        const calls: FilePathWithPrefix[] = [];
        const queue = makeQueue((path) => {
            calls.push(path);
            const index = calls.length - 1;
            if (index < 10) tenStarted.signal();
            if (index === 10) eleventhStarted.resolve();
            return gates[index]!.promise;
        });

        for (const path of paths) queue.enqueue(path);
        await tenStarted.promise;

        expect(calls).toEqual(paths.slice(0, 10));
        expect(queue.pending).toEqual(paths.slice(10));
        expect(queue.remaining).toBe(11);

        const idle = queue.waitForIdle();
        for (const gate of gates.slice(0, 10)) gate.resolve();
        await eleventhStarted.promise;
        expect(calls).toEqual(paths);
        gates[10]!.resolve();
        await expect(idle).resolves.toBe(true);
    });

    it("keeps running work while its synchronous requeues wait for free slots, then remains reusable after idle", async () => {
        const first = asPath("first.md");
        const second = asPath("second.md");
        const later = asPath("later.md");
        const firstRuns = [deferred(), deferred()];
        const bothInitialRequeues = barrier(2);
        const followupCleanupGate = deferred();
        const bothFollowupCleanupsStarted = barrier(2);
        const laterStarted = deferred();
        const calls: FilePathWithPrefix[] = [];
        const runCount = new Map<FilePathWithPrefix, number>();
        let queue!: ReturnType<typeof makeQueue>;

        queue = makeQueue(
            (path, scope) => {
                calls.push(path);
                const run = (runCount.get(path) ?? 0) + 1;
                runCount.set(path, run);

                if (path === first || path === second) {
                    if (run === 1) {
                        expect(queue.enqueue(path)).toBeUndefined();
                        bothInitialRequeues.signal();
                        return path === first ? firstRuns[0]!.promise : firstRuns[1]!.promise;
                    }
                    scope.defer(() => {
                        bothFollowupCleanupsStarted.signal();
                        return followupCleanupGate.promise;
                    });
                    return;
                }

                if (path === later) laterStarted.resolve();
            },
            { concurrency: 2 }
        );

        queue.enqueue(first);
        queue.enqueue(second);
        await bothInitialRequeues.promise;

        expect(queue.pending).toEqual([first, second]);
        expect(queue.remaining).toBe(4);

        let idleSettled = false;
        const idle = queue.waitForIdle().then((result) => {
            idleSettled = true;
            return result;
        });
        firstRuns[0]!.resolve();
        firstRuns[1]!.resolve();
        await bothFollowupCleanupsStarted.promise;

        expect(idleSettled).toBe(false);
        expect(queue.pending).toEqual([]);
        expect(queue.remaining).toBe(2);

        followupCleanupGate.resolve();
        await expect(idle).resolves.toBe(true);
        expect(calls.slice(0, 2)).toEqual([first, second]);
        expect(calls.filter((path) => path === first)).toHaveLength(2);
        expect(calls.filter((path) => path === second)).toHaveLength(2);

        queue.enqueue(later);
        await laterStarted.promise;
        await expect(queue.waitForIdle()).resolves.toBe(true);
        expect(calls.at(-1)).toBe(later);
    });

    it("counts active cleanup as a slot and reports pending plus active work", async () => {
        const first = asPath("first.md");
        const second = asPath("second.md");
        const firstStarted = deferred();
        const firstWorkGate = deferred();
        const cleanupStarted = deferred();
        const cleanupGate = deferred();
        const secondStarted = deferred();
        const reports: number[] = [];
        const calls: FilePathWithPrefix[] = [];
        const queue = makeQueue(
            (path, scope) => {
                calls.push(path);
                if (path === first) {
                    firstStarted.resolve();
                    scope.defer(() => {
                        cleanupStarted.resolve();
                        return cleanupGate.promise;
                    });
                    return firstWorkGate.promise;
                }
                secondStarted.resolve();
            },
            { concurrency: 1, onProgress: (remaining) => reports.push(remaining) }
        );

        queue.enqueue(first);
        await firstStarted.promise;
        queue.enqueue(second);

        expect(queue.remaining).toBe(2);
        expect(reports).toContain(2);

        firstWorkGate.resolve();
        await cleanupStarted.promise;
        expect(calls).toEqual([first]);
        expect(queue.remaining).toBe(2);
        expect(reports.at(-1)).toBe(2);

        cleanupGate.resolve();
        await secondStarted.promise;
        await expect(queue.waitForIdle()).resolves.toBe(true);
        expect(calls).toEqual([first, second]);
        expect(reports).toContain(1);
        expect(reports.at(-1)).toBe(0);
    });

    it("closes admission and drains accepted work, with repeated close calls safe", async () => {
        const first = asPath("first.md");
        const second = asPath("second.md");
        const rejected = asPath("rejected.md");
        const firstGate = deferred();
        const firstStarted = deferred();
        const secondStarted = deferred();
        const calls: FilePathWithPrefix[] = [];
        const queue = makeQueue(
            (path) => {
                calls.push(path);
                if (path === first) {
                    firstStarted.resolve();
                    return firstGate.promise;
                }
                if (path === second) secondStarted.resolve();
            },
            { concurrency: 1 }
        );

        queue.enqueue(first);
        queue.enqueue(second);
        await firstStarted.promise;

        const firstClose = queue.close();
        expect(() => queue.enqueue(rejected)).toThrow();
        const secondClose = queue.close();
        firstGate.resolve();
        await secondStarted.promise;

        await expect(Promise.all([firstClose, secondClose])).resolves.toEqual([true, true]);
        expect(calls).toEqual([first, second]);
    });

    it("aborts admission and dispatch, waits for cleanup, and retains pending paths", async () => {
        const active = asPath("active.md");
        const firstPending = asPath("pending-1.md");
        const secondPending = asPath("pending-2.md");
        const rejected = asPath("rejected.md");
        const processGate = deferred();
        const processStarted = deferred();
        const cleanupGate = deferred();
        const cleanupStarted = deferred();
        const calls: FilePathWithPrefix[] = [];
        const queue = makeQueue(
            (_path, scope) => {
                calls.push(active);
                processStarted.resolve();
                scope.defer(() => {
                    cleanupStarted.resolve();
                    return cleanupGate.promise;
                });
                return processGate.promise;
            },
            { concurrency: 1 }
        );

        queue.enqueue(active);
        await processStarted.promise;
        queue.enqueue(firstPending);
        queue.enqueue(secondPending);

        let abortSettled = false;
        const aborted = queue.abort().then((paths) => {
            abortSettled = true;
            return paths;
        });
        let idleSettled = false;
        const idle = queue.waitForIdle().then((result) => {
            idleSettled = true;
            return result;
        });

        expect(() => queue.enqueue(rejected)).toThrow();
        expect(queue.pending).toEqual([firstPending, secondPending]);
        processGate.resolve();
        await cleanupStarted.promise;

        expect(abortSettled).toBe(false);
        expect(idleSettled).toBe(false);
        expect(queue.remaining).toBe(3);
        expect(queue.pending).toEqual([firstPending, secondPending]);

        cleanupGate.resolve();
        await expect(aborted).resolves.toEqual([firstPending, secondPending]);
        await expect(idle).resolves.toBe(false);
        expect(queue.pending).toEqual([firstPending, secondPending]);
        expect(queue.remaining).toBe(2);
        expect(calls).toEqual([active]);
    });

    it("returns false from waitForIdle after aborting an empty queue", async () => {
        const queue = makeQueue(() => undefined);

        await expect(queue.abort()).resolves.toEqual([]);
        await expect(queue.waitForIdle()).resolves.toBe(false);
    });

    it("retains unstarted work and rejects waitForIdle after processor and cleanup failures", async () => {
        const first = asPath("first.md");
        const second = asPath("second.md");
        const unstarted = asPath("unstarted.md");
        const rejected = asPath("rejected.md");
        const processorFailure = new Error("processor failed");
        const cleanupFailure = new Error("cleanup failed");
        const firstWorkGate = deferred();
        const firstCleanupGate = deferred();
        const firstCleanupStarted = deferred();
        const firstCleanupFinished = deferred();
        const secondWorkGate = deferred();
        const secondCleanupGate = deferred();
        const secondCleanupStarted = deferred();
        const starts = barrier(2);
        const calls: FilePathWithPrefix[] = [];
        const queue = makeQueue(
            (path, scope) => {
                calls.push(path);
                starts.signal();
                if (path === first) {
                    scope.defer(async () => {
                        firstCleanupStarted.resolve();
                        await firstCleanupGate.promise;
                        firstCleanupFinished.resolve();
                        throw cleanupFailure;
                    });
                    return firstWorkGate.promise;
                }
                if (path === second) {
                    scope.defer(async () => {
                        secondCleanupStarted.resolve();
                        await secondCleanupGate.promise;
                    });
                    return secondWorkGate.promise;
                }
            },
            { concurrency: 2 }
        );

        queue.enqueue(first);
        queue.enqueue(second);
        queue.enqueue(unstarted);
        await starts.promise;

        let idleSettled = false;
        const idle = queue.waitForIdle().then(
            (result) => {
                idleSettled = true;
                return result;
            },
            (error: unknown) => {
                idleSettled = true;
                throw error;
            }
        );
        firstWorkGate.reject(processorFailure);
        await firstCleanupStarted.promise;

        expect(queue.pending).toEqual([unstarted]);
        expect(() => queue.enqueue(rejected)).toThrow();
        firstCleanupGate.resolve();
        await firstCleanupFinished.promise;
        secondWorkGate.resolve();
        await secondCleanupStarted.promise;

        expect(idleSettled).toBe(false);
        expect(queue.pending).toEqual([unstarted]);
        expect(calls).toEqual([first, second]);

        secondCleanupGate.resolve();
        let failure: unknown;
        try {
            await idle;
        } catch (error) {
            failure = error;
        }

        expect(failure).toBeInstanceOf(AggregateError);
        expect((failure as AggregateError).errors).toEqual([processorFailure, cleanupFailure]);
        expect(queue.pending).toEqual([unstarted]);
        expect(queue.remaining).toBe(1);
        expect(calls).toEqual([first, second]);
    });

    it.each(["close", "abort"] as const)("rejects %s after processor failure and deferred cleanup", async (method) => {
        const path = asPath("failing.md");
        const failure = new Error("processor failed");
        const processStarted = deferred();
        const processGate = deferred();
        const cleanupStarted = deferred();
        const cleanupGate = deferred();
        const queue = makeQueue((_path, scope) => {
            processStarted.resolve();
            scope.defer(() => {
                cleanupStarted.resolve();
                return cleanupGate.promise;
            });
            return processGate.promise;
        });

        queue.enqueue(path);
        await processStarted.promise;
        const completion = method === "close" ? queue.close() : queue.abort();
        let settled = false;
        const observed = completion.then(
            (result) => {
                settled = true;
                return result;
            },
            (error: unknown) => {
                settled = true;
                throw error;
            }
        );

        processGate.reject(failure);
        await cleanupStarted.promise;
        expect(settled).toBe(false);
        cleanupGate.resolve();
        await expect(observed).rejects.toBe(failure);
    });

    it("continues after a processor failure which is explicitly caught", async () => {
        const failing = asPath("failing.md");
        const succeeding = asPath("succeeding.md");
        const failure = new Error("handled failure");
        const calls: FilePathWithPrefix[] = [];
        const logged: unknown[] = [];
        const queue = makeQueue(
            (path) => {
                calls.push(path);
                try {
                    if (path === failing) throw failure;
                } catch (error) {
                    logged.push(error);
                }
            },
            { concurrency: 1 }
        );

        queue.enqueue(failing);
        queue.enqueue(succeeding);

        await expect(queue.waitForIdle()).resolves.toBe(true);
        expect(calls).toEqual([failing, succeeding]);
        expect(logged).toEqual([failure]);
    });

    it("stops admission and dispatch when progress reporting throws, after active cleanup settles", async () => {
        const active = asPath("active.md");
        const pending = asPath("pending.md");
        const rejected = asPath("rejected.md");
        const progressFailure = new Error("progress failed");
        const processStarted = deferred();
        const processGate = deferred();
        const cleanupStarted = deferred();
        const cleanupGate = deferred();
        const calls: FilePathWithPrefix[] = [];
        const reports: number[] = [];
        const queue = makeQueue(
            (path, scope) => {
                calls.push(path);
                if (path === active) {
                    processStarted.resolve();
                    scope.defer(() => {
                        cleanupStarted.resolve();
                        return cleanupGate.promise;
                    });
                    return processGate.promise;
                }
            },
            {
                concurrency: 1,
                onProgress: (remaining) => {
                    reports.push(remaining);
                    if (remaining === 2) throw progressFailure;
                },
            }
        );

        queue.enqueue(active);
        await processStarted.promise;
        queue.enqueue(pending);
        expect(reports).toContain(2);
        expect(queue.pending).toEqual([pending]);
        expect(() => queue.enqueue(rejected)).toThrow();

        let idleSettled = false;
        const idle = queue.waitForIdle().then(
            (result) => {
                idleSettled = true;
                return result;
            },
            (error: unknown) => {
                idleSettled = true;
                throw error;
            }
        );
        processGate.resolve();
        await cleanupStarted.promise;

        expect(idleSettled).toBe(false);
        expect(queue.remaining).toBe(2);
        expect(queue.pending).toEqual([pending]);
        expect(calls).toEqual([active]);

        cleanupGate.resolve();
        await expect(idle).rejects.toBe(progressFailure);
        expect(queue.pending).toEqual([pending]);
        expect(calls).toEqual([active]);
    });

    it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
        "rejects invalid concurrency %s",
        (concurrency) => {
            expect(() => makeQueue(() => undefined, { concurrency })).toThrow(RangeError);
        }
    );
});
