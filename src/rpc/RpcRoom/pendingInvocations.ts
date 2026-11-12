import { createDeferredAction, type TimeoutScheduler } from "octagonal-wheels/concurrency/deferredAction";
import { RpcError } from "../errors";
import type { JsonLike, RpcCallOptions, RpcEnvelope, RpcResponseErrorEnvelope, RpcResponseEnvelope } from "../types";

type PendingInvocation = {
    peerId: string;
    resolve: (value: JsonLike) => void;
    reject: (reason?: unknown) => void;
    releaseWait: () => void;
    /** Set only after the request send completes, so cancellation can follow it on the wire. */
    requestSent: boolean;
    /** Kept on the send task's captured record after map removal until cancellation sequencing is complete. */
    cancelRequested: boolean;
};

type PendingInvocationsOptions = {
    /** Calls RpcRoom's current envelope sender at invocation time; the Room owns wire serialisation and chunking. */
    sendEnvelope: (peerId: string, envelope: RpcEnvelope) => Promise<void>;
    /** Uses RpcRoom's existing request-ID generator, shared with its other request-envelope producers. */
    createRequestId: () => string;
    /** Uses RpcRoom's compatibility timer scheduler; non-positive timeout values do not schedule a deadline. */
    scheduleTimeout: TimeoutScheduler;
    /** Reports failures from background cancellation sends. */
    onProtocolWarning?: (message: string, peerId: string) => void;
};

/**
 * Creates the owner for outbound response-bearing invocation waits.
 *
 * RpcRoom checks method names and room-open state, and owns envelope
 * serialisation, transport, chunking, and inbound requests. This component
 * owns pending request IDs, wait resources, cancellation sequencing, and
 * response-to-promise settlement.
 *
 * The Room supplies narrow callbacks rather than its full state. Completing a
 * request send records wire progress but does not complete the invocation;
 * only a matching response supplies its remote result. The returned operations
 * also handle explicit cancellation, response dispatch, peer departure, and close.
 */
export function createPendingInvocations({
    sendEnvelope,
    createRequestId,
    scheduleTimeout,
    onProtocolWarning,
}: PendingInvocationsOptions) {
    const pending = new Map<string, PendingInvocation>();

    /**
     * Removes a wait and synchronously releases its deadline and abort listener
     * before the caller resolves or rejects its promise.
     */
    function removePending(requestId: string) {
        const invocation = pending.get(requestId);
        if (!invocation) {
            return undefined;
        }
        pending.delete(requestId);
        invocation.releaseWait();
        return invocation;
    }

    /**
     * Rejects a live wait. When remote cancellation is requested, records that
     * intent even if the request send has not completed yet.
     */
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

    /** Sends cancellation without delaying the local outcome; reports a failed background send. */
    function notifyRemoteCancellation(peerId: string, requestId: string) {
        void sendEnvelope(peerId, { kind: "cancel", requestId }).catch((error: unknown) => {
            onProtocolWarning?.(`Failed to send RPC cancellation: ${String(error)}`, peerId);
        });
    }

    /**
     * Registers and sends one response-bearing request, then waits for its
     * matching response. The returned promise resolves with response data and
     * rejects with remote RPC errors, a request-send failure, or local RpcError
     * outcomes: CANCELLED for abort or explicit cancellation, TIMEOUT for the
     * deadline, and NOT_CONNECTED for peer or room disconnection.
     *
     * Transport send completion only establishes whether cancellation can be
     * sent immediately; it is not the remote operation's result. A non-positive
     * timeout disables the deadline while keeping abort and other settlement
     * paths active. An already-aborted signal rejects before allocating an ID,
     * scheduling a deadline, registering a listener, or sending the request.
     *
     * @param timeoutOrOptions - A timeout in milliseconds or RPC call options.
     * Non-positive timeouts disable only the deadline; an AbortSignal remains
     * active.
     */
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
            // A non-positive timeout retains the existing no-deadline policy.
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
                // This captured record survives removal from the map. If a
                // local outcome requested cancellation while the send was
                // held, retain that intent and send cancel only after request.
                const current = pending.get(requestId);
                invocation.requestSent = true;
                if (!current && invocation.cancelRequested) {
                    notifyRemoteCancellation(peerId, requestId);
                }
            },
            (error: unknown) => {
                // A response or local outcome may have settled and removed
                // this wait first. Consume that late send failure; otherwise,
                // propagate the send failure as the invocation's local outcome.
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

    /**
     * Rejects a matching local wait and requests remote cancellation.
     *
     * If its request send is still pending, returns after local rejection; the
     * send-completion path will preserve request-before-cancel wire order. If
     * the request has already been sent, this call waits for the cancel send.
     * Failure from that immediate send rejects this call; a deferred send uses
     * the background warning path. An unknown ID or an ID owned by another peer
     * still sends the supplied cancellation envelope, preserving
     * RpcRoom.cancel behaviour.
     */
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

    /**
     * Settles the wait for a matching request ID, resolving successful data
     * or rejecting with the remote error's code, message, and details.
     * Unknown IDs are ignored, including unsolicited or surplus replies from
     * peers that answer one-way notifications.
     */
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

    /**
     * Rejects this peer's local waits without attempting remote cancellation:
     * a departed peer is no longer available to receive it.
     */
    function peerLeft(peerId: string) {
        pending.forEach((invocation, requestId) => {
            if (invocation.peerId !== peerId) {
                return;
            }
            rejectPending(requestId, new RpcError("NOT_CONNECTED", "Peer disconnected"));
        });
    }

    /**
     * Rejects all local waits with NOT_CONNECTED and requests remote
     * cancellation for sent requests. RpcRoom calls this before clearing its
     * state, while the send callback is still usable. Requests still being sent
     * carry cancellation intent until their send completes.
     */
    function close() {
        pending.forEach((_invocation, requestId) => {
            rejectPending(requestId, new RpcError("NOT_CONNECTED", "Room closed"), true);
        });
    }

    return { invoke, cancel, receiveResponse, peerLeft, close };
}
