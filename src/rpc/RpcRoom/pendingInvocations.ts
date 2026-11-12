import { createDeferredAction, type TimeoutScheduler } from "octagonal-wheels/concurrency/deferredAction";
import { RpcError } from "../errors";
import type { JsonLike, RpcCallOptions, RpcEnvelope, RpcResponseErrorEnvelope, RpcResponseEnvelope } from "../types";

type PendingInvocation = {
    peerId: string;
    resolve: (value: JsonLike) => void;
    reject: (reason?: unknown) => void;
    releaseWait: () => void;
    requestSent: boolean;
    cancelRequested: boolean;
};

type PendingInvocationsOptions = {
    sendEnvelope: (peerId: string, envelope: RpcEnvelope) => Promise<void>;
    createRequestId: () => string;
    scheduleTimeout: TimeoutScheduler;
    onProtocolWarning?: (message: string, peerId: string) => void;
};

/**
 * Owns outbound RPC invocation waits, including their deadlines, abort
 * subscriptions, cancellation ordering, and response settlement.
 *
 * The room supplies narrow transport, ID, timing, and warning callbacks.
 * Incoming request handling and wire/chunk state remain with RpcRoom.
 */
export function createPendingInvocations({
    sendEnvelope,
    createRequestId,
    scheduleTimeout,
    onProtocolWarning,
}: PendingInvocationsOptions) {
    const pending = new Map<string, PendingInvocation>();

    function removePending(requestId: string) {
        const invocation = pending.get(requestId);
        if (!invocation) {
            return undefined;
        }
        pending.delete(requestId);
        invocation.releaseWait();
        return invocation;
    }

    function rejectPending(requestId: string, error: RpcError, notifyRemote = false) {
        const invocation = pending.get(requestId);
        if (!invocation) {
            return;
        }
        if (notifyRemote) {
            invocation.cancelRequested = true;
        }
        const removed = removePending(requestId);
        if (!removed) {
            return;
        }
        removed.reject(error);
        if (notifyRemote && removed.requestSent) {
            notifyRemoteCancellation(removed.peerId, requestId);
        }
    }

    function notifyRemoteCancellation(peerId: string, requestId: string) {
        void sendEnvelope(peerId, { kind: "cancel", requestId }).catch((error: unknown) => {
            onProtocolWarning?.(`Failed to send RPC cancellation: ${String(error)}`, peerId);
        });
    }

    async function invoke(
        peerId: string,
        method: string,
        args: JsonLike[],
        timeoutOrOptions: number | RpcCallOptions = 30000
    ): Promise<JsonLike> {
        const options: RpcCallOptions =
            typeof timeoutOrOptions === "number" ? { timeoutMs: timeoutOrOptions } : (timeoutOrOptions ?? {});
        const timeoutMs = options.timeoutMs ?? 30000;
        if (options.signal?.aborted) {
            throw new RpcError("CANCELLED", `RPC cancelled: ${method}`);
        }
        const requestId = createRequestId();
        let invocation!: PendingInvocation;
        const result = new Promise<JsonLike>((resolve, reject) => {
            const signal = options.signal;
            const onAbort = () => {
                const current = pending.get(requestId);
                if (!current) {
                    return;
                }
                rejectPending(requestId, new RpcError("CANCELLED", `RPC cancelled: ${method}`), true);
            };
            const deadline =
                timeoutMs > 0
                    ? createDeferredAction(() => {
                          rejectPending(requestId, new RpcError("TIMEOUT", `RPC timed out: ${method}`), true);
                      }, scheduleTimeout)
                    : undefined;
            invocation = {
                peerId,
                resolve,
                reject,
                releaseWait: () => {
                    deadline?.dispose();
                    signal?.removeEventListener("abort", onAbort);
                },
                requestSent: false,
                cancelRequested: false,
            };
            deadline?.schedule(timeoutMs);
            pending.set(requestId, invocation);
            if (signal) {
                signal.addEventListener("abort", onAbort, { once: true });
                // An embedding host can abort between the check above and
                // listener registration.
                if (signal.aborted) {
                    onAbort();
                }
            }
        });

        const sendTask = sendEnvelope(peerId, {
            kind: "request",
            requestId,
            method,
            args,
        });
        void sendTask.then(
            () => {
                // If cancellation happened during transport send, mark the
                // request sent before issuing its remote cancellation.
                const current = pending.get(requestId);
                invocation.requestSent = true;
                if (!current && invocation.cancelRequested) {
                    notifyRemoteCancellation(peerId, requestId);
                }
            },
            (error: unknown) => {
                // A late transport failure after cancellation is consumed.
                const current = pending.get(requestId);
                if (!current) {
                    return;
                }
                const failed = removePending(requestId);
                if (failed) {
                    failed.reject(error);
                }
            }
        );

        return await result;
    }

    async function cancel(peerId: string, requestId: string) {
        const invocation = pending.get(requestId);
        if (invocation?.peerId === peerId) {
            const requestSent = invocation.requestSent;
            invocation.cancelRequested = true;
            rejectPending(requestId, new RpcError("CANCELLED", "Invocation cancelled"));
            // An in-flight request is cancelled after its send settles.
            if (!requestSent) {
                return;
            }
        }
        await sendEnvelope(peerId, {
            kind: "cancel",
            requestId,
        });
    }

    function receiveResponse(envelope: RpcResponseEnvelope | RpcResponseErrorEnvelope) {
        const settled = removePending(envelope.requestId);
        if (!settled) {
            return;
        }
        if (envelope.ok === true) {
            settled.resolve(envelope.data);
        } else {
            settled.reject(new RpcError(envelope.error.code, envelope.error.message, envelope.error.details));
        }
    }

    function peerLeft(peerId: string) {
        pending.forEach((invocation, requestId) => {
            if (invocation.peerId !== peerId) {
                return;
            }
            rejectPending(requestId, new RpcError("NOT_CONNECTED", "Peer disconnected"));
        });
    }

    function close() {
        pending.forEach((_invocation, requestId) => {
            rejectPending(requestId, new RpcError("NOT_CONNECTED", "Room closed"), true);
        });
    }

    return { invoke, cancel, receiveResponse, peerLeft, close };
}
