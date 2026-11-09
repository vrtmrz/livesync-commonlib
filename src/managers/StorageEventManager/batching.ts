/**
 * Manage batch gates, deadlines, and predecessor coalescing for storage-event operations.
 */
import type { FileEventItem, FileEventType } from "@lib/common/types";
import { LOG_LEVEL_DEBUG } from "@lib/common/types";
import { compatGlobal } from "@lib/common/coreEnvFunctions";
import type { LogFunction } from "@lib/services/lib/logUtils";
import {
    createDeferredAction,
    type DeferredAction,
    type TimeoutScheduler,
} from "octagonal-wheels/concurrency/deferredAction";
import { promiseWithResolvers, type PromiseWithResolvers } from "octagonal-wheels/promises";
import { planFileEventPredecessors, type PendingFileEvent } from "./operations";

/** One path's pending batch gate, its deadline, and the event which owns the gate. */
export type WaitInfo = {
    since: number;
    type: FileEventType;
    canProceed: PromiseWithResolvers<boolean>;
    deadline: DeferredAction;
    event: FileEventItem;
};
/**
 * Inject waiting state, live delay settings, logging, snapshots, and gate control into batching.
 * @remarks The facade provides dynamic setting accessors so each new gate observes current host settings.
 */
export interface StorageEventBatching {
    waiting(): Map<string, WaitInfo>;
    operation(event: FileEventItem): PendingFileEvent | undefined;
    minimumDelay(): number;
    maximumDelay(): number;
    enabled(): boolean;
    log: LogFunction;
    requestSnapshot(): void;
    proceed(path: string): void;
    cancel(path: string): void;
    add(path: string, event: FileEventItem, since?: number): WaitInfo;
}
/**
 * Schedule a batch deadline through the host-compatible global timer API.
 * @param callback - The action which releases the gate when its deadline expires.
 * @param delayMs - The delay in milliseconds.
 * @returns A function which cancels the scheduled timer.
 */
const scheduleStorageTimeout: TimeoutScheduler = (callback, delayMs) => {
    const handle = compatGlobal.setTimeout(callback, delayMs);
    return () => compatGlobal.clearTimeout(handle);
};

/**
 * Resolve and remove a path's current gate, dispose its timer, and request a snapshot.
 * @param batching - Host effects for waiting state and snapshot requests.
 * @param path - The path whose gate should be completed.
 * @param proceed - Whether the waiting event may proceed or has been cancelled.
 * @returns Nothing; snapshotting is requested even when the path has no current gate, and processing is not awaited.
 */
export function finishBatchWaiting(batching: StorageEventBatching, path: string, proceed: boolean): void {
    const waiting = batching.waiting();
    const waitInfo = waiting.get(path);
    if (waitInfo) {
        waitInfo.canProceed.resolve(proceed);
        waitInfo.deadline.dispose();
        waiting.delete(path);
    }
    batching.requestSnapshot();
}

/**
 * Calculate a gate delay which honours both minimum and maximum batch windows.
 * @param now - The current time in milliseconds.
 * @param acceptedAt - When the operation entered admission, used for the minimum delay.
 * @param since - The inherited start of the maximum-delay window.
 * @param minimum - The minimum delay in milliseconds.
 * @param maximum - The maximum delay in milliseconds.
 * @returns Whether the maximum window has expired and the non-negative delay to schedule.
 * @remarks The original timing sketch follows; each row shows an event arriving within the same maximum window.
 * ```text
 * x*<------- maxDelay --------->*
 * x*<-- minDelay -->*
 * x*       x<-- nextDelay -->*
 * x*              x<-- Capped-->*
 * x*                    x.......*
 * x: event
 * *: batch gate becomes eligible for processing
 * ```
 * The quiet delay is measured from the latest accepted event. Coalescing inherits the first uncommitted event's
 * maximum window, so repeated events cannot postpone eligibility indefinitely. Filtering time already spent since
 * acceptance counts towards both delays. The maximum caps intentional batching, not semaphore, I/O, or snapshot
 * completion time; it does not guarantee a minimum interval between completed saves.
 */
export function planBatchDeadline(now: number, acceptedAt: number, since: number, minimum: number, maximum: number) {
    const elapsed = now - since;
    return {
        expired: elapsed >= maximum,
        delay: Math.min(Math.max(0, maximum - elapsed), Math.max(0, minimum - (now - acceptedAt))),
    };
}

/**
 * Create and schedule a timed gate for one path, then request a snapshot.
 * @param batching - Host effects for state, settings, logging, and gate control.
 * @param path - The key which must not already own a gate.
 * @param event - The event which will wait at this gate.
 * @param waitedSince - Optional inherited start for the maximum-delay window.
 * @returns The gate and its `canProceed` promise; its boolean result is not handler completion.
 * @throws An error when a gate already exists for `path`.
 */
export function addBatchWaiting(
    batching: StorageEventBatching,
    path: string,
    event: FileEventItem,
    waitedSince?: number
): WaitInfo {
    const waiting = batching.waiting();
    if (waiting.has(path)) throw new Error(`Already waiting for key: ${path}`);
    const now = Date.now();
    const acceptedAt = batching.operation(event)?.acceptedAt ?? now;
    const since = waitedSince ?? acceptedAt;
    const maximum = batching.maximumDelay() * 1000;
    const minimum = batching.minimumDelay() * 1000;
    const plan = planBatchDeadline(now, acceptedAt, since, minimum, maximum);
    batching.log(
        plan.expired
            ? `Processing ${path}: Batch save maximum delay already exceeded: ${event.type}`
            : `Processing ${path}: Adding waiting for batch save: ${event.type} (${plan.delay}ms)`,
        LOG_LEVEL_DEBUG
    );
    const deadline = createDeferredAction(() => {
        batching.log(`Processing ${path}: Batch save timeout reached: ${event.type}`, LOG_LEVEL_DEBUG);
        batching.proceed(path);
    }, scheduleStorageTimeout);
    const waitInfo: WaitInfo = {
        since,
        type: event.type,
        event,
        canProceed: promiseWithResolvers<boolean>(),
        deadline,
    };
    deadline.schedule(plan.delay);
    waiting.set(path, waitInfo);
    batching.requestSnapshot();
    return waitInfo;
}

/**
 * Mark operations for flushing, signal active optional handlers, and release matching gates.
 * @param batching - Host effects for waiting state and gate control.
 * @param operations - The operations whose flush requests should be applied.
 * @returns Nothing; this opens gates but does not wait for handlers or operation completion.
 */
export function releaseFileEventBatches(batching: StorageEventBatching, operations: readonly PendingFileEvent[]): void {
    for (const operation of operations) {
        operation.flushRequested = true;
        operation.flushSignal?.resolve();
        const path = operation.event.args.file.path;
        if (batching.waiting().get(path)?.event === operation.event) batching.proceed(path);
    }
}

/**
 * Apply coalescing and ordering actions from a predecessor plan.
 * @param batching - Host effects used to cancel or release predecessor gates.
 * @param operation - The successor operation receiving dependency relationships.
 * @param plan - The coalescing and dependency actions previously calculated for this operation.
 * @returns Nothing; the successor inherits prior prerequisites, and the prior attempt follows successor completion.
 */
function applyPredecessorPlan(
    batching: StorageEventBatching,
    operation: PendingFileEvent,
    plan: ReturnType<typeof planFileEventPredecessors>
): void {
    for (const action of plan.actions) {
        const { previous, path } = action;
        if (action.kind === "coalesce") {
            previous.attempt.successor = operation.attempt;
            for (const dependency of previous.prerequisites) operation.prerequisites.add(dependency);
            batching.cancel(path);
        } else {
            operation.prerequisites.add(previous);
            if (batching.waiting().get(path)?.event === previous.event) batching.proceed(path);
        }
    }
}

/**
 * Initialise predecessor relationships and obtain this operation's batch-gate result.
 * @param batching - Host effects for operation lookup, current settings, deadlines, and gate control.
 * @param operation - The operation whose predecessor plan and gate are being prepared.
 * @returns A promise resolving to the gate's boolean proceed result, not file-handler completion.
 * @remarks A coalesced predecessor's eventual completion follows its successor attempt.
 * @throws An error if the path already has a batch gate when this operation needs one.
 */
export function initialiseFileEventBatch(
    batching: StorageEventBatching,
    operation: PendingFileEvent
): Promise<boolean> {
    operation.initialised = true;
    const event = operation.event;
    const path = event.args.file.path;
    const waiting = batching.waiting().get(path);
    const plan = planFileEventPredecessors(operation, waiting);
    applyPredecessorPlan(batching, operation, plan);
    // A direct caller can provide a waiting gate before dispatching its owner.
    if (batching.waiting().get(path) === waiting && waiting) batching.proceed(path);
    if (operation.flushRequested) releaseFileEventBatches(batching, [...operation.prerequisites]);
    const shouldWait =
        batching.enabled() &&
        !event.skipBatchWait &&
        !operation.flushRequested &&
        (event.type === "CREATE" || event.type === "CHANGED");
    return shouldWait ? batching.add(path, event, plan.since).canProceed.promise : Promise.resolve(true);
}
