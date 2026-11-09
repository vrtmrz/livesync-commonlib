/**
 * Durable file-operation contracts and pure plans for attempts and ordering.
 * This module selects and correlates attempts without installing them or invoking handlers.
 */
import type { FileEventItem } from "@lib/common/models/fileaccess.type";
import { promiseWithResolvers, type PromiseWithResolvers } from "octagonal-wheels/promises";

/** The settled outcome of one attempt; a later retry receives a different outcome promise. */
export type OperationResult = { ok: true } | { ok: false; error: unknown };

/** Per-attempt execution state, separate from the durable operation that may be retried. */
export type FileEventAttempt = {
    /** Settles once for this attempt, leaving earlier callers attached to their original attempt. */
    completion: PromiseWithResolvers<OperationResult>;
    /** Prevents concurrent dispatch from starting the same attempt twice. */
    started: boolean;
    /** Marks this invocation for current-state reconciliation inside the ordinary handler. */
    reconcile: boolean;
    /** Failure-sequence cutoff used when this attempt captures retryable dependencies. */
    retryBefore?: number;
    /** An admission failure which must be observed after an active handler settles. */
    admissionFailure?: { error: unknown };
    /** Related operations whose captured attempts must succeed before this one proceeds. */
    prerequisites?: Map<PendingFileEvent, FileEventAttempt>;
    /** Earlier ordered work which must settle, regardless of whether it succeeded. */
    orderedPredecessors?: Map<PendingFileEvent, FileEventAttempt>;
    /** Successor which owns completion when this operation was coalesced away. */
    successor?: FileEventAttempt;
    /** Cached terminal result for this attempt. */
    result?: OperationResult;
    /** Position of this failure within the manager's finite failure sequence. */
    failureSequence?: number;
};

/** Durable ownership of an accepted file event across one or more execution attempts. */
export type PendingFileEvent = {
    /** Original event intent retained for persistence and replay. */
    event: FileEventItem;
    /** Manager-local ordering position used by snapshots and finite boundaries. */
    sequence: number;
    /** Admission time for this event; batch planning may inherit an earlier gate start. */
    acceptedAt: number;
    /** Failure-sequence position at admission, excluding later failures from this operation's retry scope. */
    failureBoundary: number;
    /** Sentinel sequence which earlier ordered work must settle before this operation. */
    barrierBefore?: number;
    /** Current execution attempt; replacing it does not rewrite a previously settled attempt. */
    attempt: FileEventAttempt;
    /** Whether initialisation has linked the operation's prerequisites. */
    initialised: boolean;
    /** Whether this operation has been entered into the per-path predecessor index. */
    registered: boolean;
    /** Latest unresolved operation for each path touched by this event. */
    predecessors: Map<string, PendingFileEvent>;
    /** Related operations which must succeed before this event can be processed. */
    prerequisites: Set<PendingFileEvent>;
    /** Whether captured work must bypass batch waiting and signal any optional handler. */
    flushRequested: boolean;
    /** Signal shared with optional handlers which support flush-aware completion. */
    flushSignal?: PromiseWithResolvers<void>;
};

/**
 * Create a fresh attempt with its own unresolved completion promise.
 * @param reconcile - Whether the handler should reconcile this event against current file state.
 * @returns An unstarted attempt with no result or dependency captures.
 * @remarks This allocates attempt-local state only; it does not replace a durable operation's current attempt
 * or schedule processing.
 */
export function createFileEventAttempt(reconcile = false): FileEventAttempt {
    return { completion: promiseWithResolvers<OperationResult>(), started: false, reconcile };
}

/**
 * Enforce an admission failure recorded while an attempt's handler was active.
 * @param attempt - The attempt whose admission outcome must be checked before it advances.
 * @returns No value; returns normally when no admission failure is recorded.
 * @remarks Throws the original admission error when present and does not change attempt state.
 */
export function checkFileEventAdmission(attempt: FileEventAttempt): void {
    if (attempt.admissionFailure) throw attempt.admissionFailure.error;
}

/**
 * Decide whether the manager may automatically retry an event in the current session.
 * @param event - The original file-event intent.
 * @returns True for a non-INTERNAL event whose file is not internal.
 * @remarks Internal and optional-provider work keeps its provider-owned retry contract; this predicate is read-only.
 */
export function canRetryFileEvent(event: FileEventItem): boolean {
    return event.type !== "INTERNAL" && !event.args.file.isInternal;
}

/**
 * Resolve the paths which establish ordering for this event.
 * @param event - The original file-event intent.
 * @returns The file path plus its related path when present; RENAME uses oldPath and other events use renameTarget.
 * @remarks The returned paths are used for ownership and ordering only; this function does not index the event.
 */
export function getFileEventPaths(event: FileEventItem): string[] {
    const related = event.type === "RENAME" ? event.args.oldPath : event.args.renameTarget;
    return related ? [event.args.file.path, related] : [event.args.file.path];
}

/** A side-effect-free selection of the attempts a caller may capture and await. */
type FileEventAttemptPlan = {
    /** Attempt chosen for every operation reached within the finite plan. */
    captured: Map<PendingFileEvent, FileEventAttempt>;
    /** Newly allocated attempts which the caller may install and start. */
    retries: Map<PendingFileEvent, FileEventAttempt>;
};

/**
 * Check whether the operation's current attempt is eligible at a finite failure boundary.
 * @param operation - The durable operation whose current attempt is inspected.
 * @param retryBefore - The inclusive highest failure sequence allowed into this plan.
 * @returns True only for a retryable event with a recorded failed result at or before the boundary.
 * @remarks An absent failure sequence is treated as later than every finite boundary. No operation or attempt is changed.
 */
function isFileEventRetryEligible(operation: Readonly<PendingFileEvent>, retryBefore: number): boolean {
    const attempt = operation.attempt;
    return (
        attempt.result?.ok === false &&
        (attempt.failureSequence ?? Number.POSITIVE_INFINITY) <= retryBefore &&
        canRetryFileEvent(operation.event)
    );
}

/**
 * Select current and replacement attempts through a finite failure sequence without starting work.
 * @param operations - The initial durable operations in the caller's boundary.
 * @param retryBefore - Inclusive highest failure sequence eligible for a replacement attempt; defaults to no retries.
 * @returns A map of captured attempts and a separate map containing only newly planned retries.
 * @remarks Existing attempts remain installed. Eligible operations receive newly allocated attempts in the plan;
 * already-initialised retries also add their prerequisites to the captured set so dependency waits use one boundary.
 * The caller is responsible for installing retries and scheduling them.
 */
export function planFileEventAttempts(operations: readonly PendingFileEvent[], retryBefore = -1): FileEventAttemptPlan {
    const captured = new Map<PendingFileEvent, FileEventAttempt>();
    const retries = new Map<PendingFileEvent, FileEventAttempt>();
    const pending = [...operations];
    for (let index = 0; index < pending.length; index++) {
        const operation = pending[index];
        if (captured.has(operation)) continue;
        let attempt = operation.attempt;
        if (isFileEventRetryEligible(operation, retryBefore)) {
            attempt = createFileEventAttempt(true);
            attempt.retryBefore = retryBefore;
            retries.set(operation, attempt);
            if (operation.initialised) {
                for (const previous of operation.prerequisites) pending.push(previous);
            }
        }
        captured.set(operation, attempt);
    }
    for (const [operation, attempt] of retries) {
        if (operation.initialised) {
            attempt.prerequisites = new Map(
                [...operation.prerequisites].map((previous) => [previous, captured.get(previous)!])
            );
        }
    }
    return { captured, retries };
}

/** One predecessor decision for a path, produced without changing gates or operation links. */
type BatchPredecessorAction = { kind: "coalesce" | "depend"; path: string; previous: PendingFileEvent };

/**
 * Plan coalescing and dependency links for the operation's unresolved path predecessors.
 * @param operation - The operation whose predecessor relationships are being initialised.
 * @param waiting - Optional current batch gate, used only when it belongs to a coalescible predecessor.
 * @returns The batch start time to use and one coalesce/depend action for each unresolved predecessor path.
 * @remarks A gate is inherited only for the same event object, while it is not flush-requested, and when event
 * types match or the new event is DELETE. This is a pure plan: the caller applies actions and cancels any gates.
 */
export function planFileEventPredecessors(
    operation: Readonly<PendingFileEvent>,
    waiting?: Readonly<{ event: FileEventItem; since: number }>
): { since: number; actions: BatchPredecessorAction[] } {
    let since = operation.acceptedAt;
    const actions: BatchPredecessorAction[] = [];
    for (const [path, previous] of operation.predecessors) {
        if (previous.attempt.result?.ok) continue;
        const coalesce =
            waiting?.event === previous.event &&
            !previous.flushRequested &&
            (previous.event.type === operation.event.type || operation.event.type === "DELETE");
        if (coalesce) since = waiting.since;
        actions.push({ kind: coalesce ? "coalesce" : "depend", path, previous });
    }
    return { since, actions };
}

/**
 * Require every captured operation result to be successful.
 * @param results - Results in their capture order.
 * @returns No value when all results are successful or the collection is empty.
 * @remarks Throws the error from the first failed result in input order; it does not alter any result or operation.
 */
export function requireSuccessfulFileEvents(results: readonly OperationResult[]): void {
    const failure = results.find((result) => !result.ok);
    if (failure?.ok === false) throw failure.error;
}
