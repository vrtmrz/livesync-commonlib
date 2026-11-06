import type { LiveSyncEventHub } from "@lib/hub/hub";
import { EVENT_PLATFORM_UNLOADED } from "@lib/events/coreEvents";

/** Lightweight, context-owned observations without transport or configuration secrets. */
export type P2PDiagnosticCategory = "relay" | "peer" | "sync";

export type P2PDiagnosticCode =
    | "room-opening"
    | "room-opened"
    | "room-closed"
    | "room-open-failed"
    | "room-close-failed"
    | "room-open-cancelled"
    | "room-join-error"
    | "peer-advertised"
    | "peer-left"
    | "rtc-failed"
    | "auth-accepted"
    | "auth-refused"
    | "auth-timeout"
    | "auth-cancelled"
    | "auth-error"
    | "pull-started"
    | "pull-completed"
    | "pull-failed"
    | "pull-cancelled"
    | "watch-enabled"
    | "watch-disabled"
    | "watch-skipped"
    | "broadcast-enabled"
    | "broadcast-disabled"
    | "change-notification-received"
    | "change-notification-ignored"
    | "change-notification-sent"
    | "change-notification-timeout"
    | "change-notification-cancelled"
    | "change-notification-error";

export type P2PDiagnosticReason =
    | "relay-details-unobserved"
    | "transport-error"
    | "operation-cancelled"
    | "rpc-timeout"
    | "rpc-cancelled"
    | "rpc-error"
    | "authentication-refused"
    | "authentication-unobserved"
    | "replication-error"
    | "replication-not-ready"
    | "already-running"
    | "not-watching"
    | "not-accepted"
    | "setup-in-progress"
    | "peer-not-broadcasting"
    | "peer-broadcast-unobserved"
    | "ICE_GATHERING_NOT_COMPLETED"
    | "ICE_CONNECTIVITY_FAILED"
    | "STUN_REQUEST_TIMEOUT"
    | "SIGNALING_NOT_STABLE"
    | "CONNECTION_DROPPED_AFTER_ESTABLISHED"
    | "NETWORK_INTERRUPTED"
    | "UNKNOWN";

export type P2PDiagnosticEvent = {
    readonly category: P2PDiagnosticCategory;
    readonly code: P2PDiagnosticCode;
    /** Milliseconds since the Unix epoch, captured at the observed source boundary. */
    readonly timestamp: number;
    readonly peerId?: string;
    readonly reason?: P2PDiagnosticReason;
};

/** Missing categories have not been observed; no zero or successful result is implied. */
export type P2PDiagnosticSnapshot = Readonly<Partial<Record<P2PDiagnosticCategory, P2PDiagnosticEvent>>>;

export type P2PDiagnosticInput = Omit<P2PDiagnosticEvent, "timestamp">;
export type P2PDiagnosticReporter = (event: P2PDiagnosticEvent) => void;

/** Accepted, fenced events from the diagnostic store of this Commonlib context. */
export const EVENT_P2P_DIAGNOSTIC = "p2p-diagnostic";
declare global {
    interface LSEvents {
        [EVENT_P2P_DIAGNOSTIC]: P2PDiagnosticEvent;
    }
}

/** Publish a fixed observation without allowing diagnostic callbacks to affect the operation. */
export function reportP2PDiagnostic(reporter: P2PDiagnosticReporter | undefined, input: P2PDiagnosticInput): void {
    if (!reporter) {
        return;
    }
    try {
        reporter(Object.freeze({ ...input, timestamp: Date.now() }));
    } catch {
        // Diagnostic observers do not own replication or transport control flow.
    }
}

/** Classify only stable RPC error identifiers; never expose the error text or details. */
export function classifyP2PRpcFailure(
    error: unknown,
    signal?: AbortSignal
): "rpc-timeout" | "rpc-cancelled" | "rpc-error" {
    const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
    const name = typeof error === "object" && error !== null && "name" in error ? error.name : undefined;
    if (signal?.aborted || code === "CANCELLED" || name === "AbortError") {
        return "rpc-cancelled";
    }
    return code === "TIMEOUT" ? "rpc-timeout" : "rpc-error";
}

/** Retain only the latest observation of each category for one service context. */
export function createP2PDiagnosticStore(events: LiveSyncEventHub) {
    let snapshot: P2PDiagnosticSnapshot = Object.freeze({});
    let disposed = false;
    const listeners = new Set<P2PDiagnosticReporter>();
    const lifetime = new AbortController();
    const dispose = () => {
        disposed = true;
        listeners.clear();
        lifetime.abort();
    };
    events.onEvent(EVENT_PLATFORM_UNLOADED, dispose, { signal: lifetime.signal });
    return {
        getSnapshot: (): P2PDiagnosticSnapshot => snapshot,
        subscribe: (listener: P2PDiagnosticReporter): (() => void) => {
            if (!disposed) {
                listeners.add(listener);
            }
            return () => {
                listeners.delete(listener);
            };
        },
        record: (input: P2PDiagnosticEvent): void => {
            if (disposed) {
                return;
            }
            const event: P2PDiagnosticEvent = Object.freeze({
                category: input.category,
                code: input.code,
                timestamp: input.timestamp,
                ...(input.peerId !== undefined ? { peerId: input.peerId } : {}),
                ...(input.reason !== undefined ? { reason: input.reason } : {}),
            });
            const previous = snapshot[event.category];
            if (
                previous?.code === event.code &&
                previous.peerId === event.peerId &&
                previous.reason === event.reason &&
                previous.timestamp === event.timestamp
            ) {
                return;
            }
            snapshot = Object.freeze({ ...snapshot, [event.category]: event });
            for (const listener of listeners) {
                try {
                    listener(event);
                } catch {
                    /* Observers cannot prevent another observer from receiving the event. */
                }
            }
            try {
                events.emitEvent(EVENT_P2P_DIAGNOSTIC, event);
            } catch {
                /* Keep event delivery outside operation control flow. */
            }
        },
        dispose,
    };
}
