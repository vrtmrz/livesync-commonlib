/** Transient handler requests which reuse reconciliation without changing the persisted event schema. */
import type { FileEventItem } from "./fileaccess.type";

/** Keep the runtime brand private so callers construct requests through the factory. */
const RECONCILE_FILE_EVENT = Symbol("reconcileFileEvent");

/**
 * A transient request to re-evaluate an event against current storage and database state.
 *
 * @remarks
 * This is a handler invocation, not a new durable operation. The manager retains
 * the original event for snapshots; the private symbol is absent from JSON persistence.
 */
export type ReconcileFileEvent = FileEventItem & {
    [RECONCILE_FILE_EVENT]: true;
};

/**
 * Create a marked handler invocation without changing the retained operation's event.
 *
 * @param event - The original accepted file event whose current effect must be reconsidered.
 * @returns A shallow event copy branded as a reconciliation request; its arguments are shared with the original.
 * @remarks
 * Continue persisting the original event. The returned request only selects the
 * current-state reconciliation route for this attempt and does not alter earlier results.
 */
export function createReconcileEvent(event: FileEventItem): ReconcileFileEvent {
    return { ...event, [RECONCILE_FILE_EVENT]: true };
}

/**
 * Narrow a valid file event to a transient reconciliation request.
 *
 * @param event - An already typed file event passed to a handler.
 * @returns Whether the private reconciliation marker is present and true.
 * @remarks
 * This checks the invocation marker, not the full shape of an unknown payload.
 * Persisted restart events use restoredFromPreviousRuntime and are checked separately.
 */
export function isReconcileEvent(event: FileEventItem): event is ReconcileFileEvent {
    return RECONCILE_FILE_EVENT in event && event[RECONCILE_FILE_EVENT] === true;
}
