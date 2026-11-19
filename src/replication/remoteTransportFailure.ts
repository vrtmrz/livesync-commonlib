import { RemoteRequestError } from "@lib/common/LSError.ts";
import type { ContinuousReplicationNetworkFailure } from "./ReplicatorProvider.ts";

export class OneShotConnectivityPreflightTimeoutError extends Error {
    constructor(timeoutMs: number) {
        super(`Remote connectivity preflight exceeded ${timeoutMs} ms.`);
        this.name = "OneShotConnectivityPreflightTimeoutError";
    }
}

const disconnectedTransportCodes = new Set([
    "ECONNABORTED",
    "ECONNREFUSED",
    "ECONNRESET",
    "EHOSTUNREACH",
    "ENETDOWN",
    "ENETRESET",
    "ENETUNREACH",
    "EPIPE",
    "ETIMEDOUT",
    "EAI_AGAIN",
    "UND_ERR_CONNECT_TIMEOUT",
    "UND_ERR_HEADERS_TIMEOUT",
    "UND_ERR_BODY_TIMEOUT",
    "UND_ERR_SOCKET",
]);

class ObservedReplicationNetworkFailure {
    constructor(readonly observation: ContinuousReplicationNetworkFailure) {}
}

function* errorChain(error: unknown): Generator<Record<PropertyKey, unknown>> {
    const seen = new Set<object>();
    while (typeof error === "object" && error !== null && !seen.has(error)) {
        seen.add(error);
        const current = error as Record<PropertyKey, unknown>;
        yield current;
        error = current.cause;
    }
}

/** Retrieve the observation made at an offline gate or a failed remote request. */
export function getReplicationNetworkFailure(error: unknown): ContinuousReplicationNetworkFailure | undefined {
    for (const cause of errorChain(error)) {
        const failure = cause.replicationNetworkFailure;
        if (failure instanceof ObservedReplicationNetworkFailure) return failure.observation;
    }
    return undefined;
}

/** PouchDB copies own string-keyed properties into its errors and drops the original prototype. */
export class ReplicationNetworkError extends RemoteRequestError {
    readonly replicationNetworkFailure: ObservedReplicationNetworkFailure;

    constructor(message: string, failure: ContinuousReplicationNetworkFailure, options?: { cause: unknown }) {
        super(message, options);
        this.replicationNetworkFailure = new ObservedReplicationNetworkFailure(failure);
    }
}

/**
 * Preserve a positively identified network failure at the final fetch boundary.
 * PouchDB copies own error properties when emitting a finite transfer failure.
 */
export function captureRemoteTransportFailure(error: unknown, signal: AbortSignal, isOnline: () => boolean): unknown {
    if (getReplicationNetworkFailure(error)) return error;
    let disconnected = false;
    if (signal.aborted) {
        disconnected =
            signal.reason instanceof OneShotConnectivityPreflightTimeoutError || signal.reason?.name === "TimeoutError";
    } else {
        for (const cause of errorChain(error)) {
            if (
                cause.name === "AbortError" ||
                (typeof cause.status === "number" && cause.status >= 400 && cause.status < 600)
            ) {
                return error;
            }
            if (
                cause.name === "TimeoutError" ||
                (typeof cause.code === "string" && disconnectedTransportCodes.has(cause.code))
            ) {
                disconnected = true;
            }
        }
    }
    if (!disconnected) return error;
    return new ReplicationNetworkError(
        error instanceof Error ? error.message : "Remote request failed",
        { reason: "remote-transport", hostOnlineAtFailure: isOnline(), failedAt: Date.now() },
        { cause: error }
    );
}
