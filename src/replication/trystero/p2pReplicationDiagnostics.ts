import { classifyP2PRpcFailure, type P2PDiagnosticInput } from "@lib/p2p/p2pDiagnostics";
import type { P2PReplicationResult } from "./replicationTypes";

const authenticationFailureCodes = {
    "rpc-timeout": "auth-timeout",
    "rpc-cancelled": "auth-cancelled",
    "rpc-error": "auth-error",
} as const;

const notificationFailureCodes = {
    "rpc-timeout": "change-notification-timeout",
    "rpc-cancelled": "change-notification-cancelled",
    "rpc-error": "change-notification-error",
} as const;

/** Describe an observed response without coercing an unavailable response to refusal. */
export function authenticationResultDiagnostic(peerId: string, response: unknown): P2PDiagnosticInput {
    if (response === true) {
        return { category: "peer", code: "auth-accepted", peerId };
    }
    if (response === false) {
        return { category: "peer", code: "auth-refused", reason: "authentication-refused", peerId };
    }
    return { category: "peer", code: "auth-error", reason: "authentication-unobserved", peerId };
}

export function authenticationFailureDiagnostic(
    peerId: string,
    error: unknown,
    signal?: AbortSignal
): P2PDiagnosticInput {
    const reason = classifyP2PRpcFailure(error, signal);
    return { category: "peer", code: authenticationFailureCodes[reason], reason, peerId };
}

/** Classify the result without changing the operation's result object or error. */
export function pullResultDiagnostic(peerId: string, status: P2PReplicationResult["status"]): P2PDiagnosticInput {
    switch (status) {
        case "completed":
            return { category: "sync", code: "pull-completed", peerId };
        case "cancelled":
            return { category: "sync", code: "pull-cancelled", reason: "operation-cancelled", peerId };
        default:
            return { category: "sync", code: "pull-failed", reason: "replication-error", peerId };
    }
}

export function pullFailureDiagnostic(peerId: string, cancelled: boolean): P2PDiagnosticInput {
    if (cancelled) {
        return pullResultDiagnostic(peerId, "cancelled");
    }
    return pullResultDiagnostic(peerId, "failed");
}

export function notificationFailureDiagnostic(peerId: string, error: unknown): P2PDiagnosticInput {
    const reason = classifyP2PRpcFailure(error);
    return { category: "sync", code: notificationFailureCodes[reason], reason, peerId };
}
