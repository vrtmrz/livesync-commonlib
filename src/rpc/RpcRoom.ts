import { compatGlobal } from "@lib/common/coreEnvFunctions";
import { IncomingChunkBuffer, estimateBytes, splitIntoChunks } from "./chunking";
import { asRpcErrorShape, RpcError } from "./errors";
import { RpcSession } from "./RpcSession";
import {
    RPC_VERSION_MAJOR,
    RPC_VERSION_MINOR,
    type JsonLike,
    type RpcCallOptions,
    type RpcCancellationAwareMethodHandler,
    type RpcEnvelope,
    type RpcMethodHandler,
    type RpcRegisterOptions,
    type RpcRequestContext,
    type RpcRoomOptions,
    type RpcWireMessage,
} from "./types";

type PendingInvocation = {
    peerId: string;
    method: string;
    resolve: (value: JsonLike) => void;
    reject: (reason?: unknown) => void;
    timeoutHandle?: number;
    signal?: AbortSignal;
    abortListener?: () => void;
    requestSent: boolean;
    cancelRequested: boolean;
};

type InboundCallContext = RpcRequestContext & {
    peerId: string;
    controller: AbortController;
};

type RegisteredMethod<T extends JsonLike[], U> = {
    handler: RpcMethodHandler<T, U> | RpcCancellationAwareMethodHandler<T, U>;
    cancellationAware: boolean;
    serial: boolean;
    queue: Promise<void>;
};

type OutgoingChunkState = {
    peerId: string;
    chunks: string[];
};

function newId(prefix: string) {
    return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function validNamespacedMethod(method: string) {
    return method.includes(".") || method.includes("/");
}

export class RpcRoom {
    private options: Required<Pick<RpcRoomOptions, "maxWirePayloadBytes" | "chunkMissingRetryMs">> & RpcRoomOptions;
    private pending = new Map<string, PendingInvocation>();
    private inboundCalls = new Map<string, InboundCallContext>();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- This is a generic type for method handlers, so we can't be more specific about the types here.
    private methods = new Map<string, RegisteredMethod<any, any>>();
    private sessions = new Map<string, RpcSession>();
    private outgoingChunkMap = new Map<string, OutgoingChunkState>();
    private incomingChunkMap = new Map<string, IncomingChunkBuffer>();
    private incomingChunkTimers = new Map<string, number>();
    private peerVersion = new Map<string, { major: number; minor: number }>();
    private disposers: Array<() => void> = [];
    private closed = false;

    constructor(options: RpcRoomOptions) {
        this.options = {
            maxWirePayloadBytes: options.maxWirePayloadBytes ?? 32 * 1024,
            chunkMissingRetryMs: options.chunkMissingRetryMs ?? 350,
            ...options,
        };
        this.disposers.push(
            this.options.transport.onMessage((msg, peerId) => {
                void this.onWireMessage(msg, peerId);
            })
        );
        if (this.options.transport.onPeerJoin) {
            this.disposers.push(
                this.options.transport.onPeerJoin((peerId) => {
                    void this.sendEnvelope(peerId, {
                        kind: "handshake",
                        versionMajor: RPC_VERSION_MAJOR,
                        versionMinor: RPC_VERSION_MINOR,
                    });
                })
            );
        }
        if (this.options.transport.onPeerLeave) {
            this.disposers.push(
                this.options.transport.onPeerLeave((peerId) => {
                    this.pending.forEach((pending, requestId) => {
                        if (pending.peerId !== peerId) return;
                        this.rejectPending(requestId, new RpcError("NOT_CONNECTED", "Peer disconnected"));
                    });
                    this.inboundCalls.forEach((context, requestId) => {
                        if (context.peerId !== peerId) return;
                        this.abortInboundCall(requestId, context);
                        this.inboundCalls.delete(requestId);
                    });
                    this.outgoingChunkMap.forEach((state, streamId) => {
                        if (state.peerId === peerId) this.outgoingChunkMap.delete(streamId);
                    });
                    this.sessions.delete(peerId);
                    this.peerVersion.delete(peerId);
                })
            );
        }
    }

    close() {
        if (this.closed) return;
        this.closed = true;
        this.disposers.splice(0).forEach((dispose) => dispose());
        this.pending.forEach((_pending, requestId) => {
            this.rejectPending(requestId, new RpcError("NOT_CONNECTED", "Room closed"), true);
        });
        this.inboundCalls.forEach((context, requestId) => {
            this.abortInboundCall(requestId, context);
        });
        this.inboundCalls.clear();
        this.methods.clear();
        this.sessions.clear();
        this.outgoingChunkMap.clear();
        this.incomingChunkMap.clear();
        this.incomingChunkTimers.forEach((h) => compatGlobal.clearTimeout(h));
        this.incomingChunkTimers.clear();
    }

    session(peerId: string) {
        const existing = this.sessions.get(peerId);
        if (existing) return existing;
        const s = new RpcSession(this, peerId);
        this.sessions.set(peerId, s);
        return s;
    }

    register<T extends JsonLike[], U>(
        method: string,
        handler: RpcMethodHandler<T, U>,
        options?: RpcRegisterOptions
    ): void;
    register<T extends JsonLike[], U>(
        method: string,
        handler: RpcMethodHandler<T, U>,
        options: RpcRegisterOptions = {}
    ) {
        this.registerMethod(method, handler, false, options);
    }

    /**
     * Register a handler which receives an AbortSignal for cooperative
     * cancellation. The original `register` API deliberately remains
     * unchanged for handlers which do not need request context.
     */
    registerCancellable<T extends JsonLike[], U>(
        method: string,
        handler: RpcCancellationAwareMethodHandler<T, U>,
        options?: RpcRegisterOptions
    ): void;
    registerCancellable<T extends JsonLike[], U>(
        method: string,
        handler: RpcCancellationAwareMethodHandler<T, U>,
        options: RpcRegisterOptions = {}
    ) {
        this.registerMethod(method, handler, true, options);
    }

    private registerMethod<T extends JsonLike[], U>(
        method: string,
        handler: RpcMethodHandler<T, U> | RpcCancellationAwareMethodHandler<T, U>,
        cancellationAware: boolean,
        options: RpcRegisterOptions
    ) {
        if (!validNamespacedMethod(method)) {
            throw new RpcError("PROTOCOL_ERROR", `Method must be namespaced: ${method}`);
        }
        this.methods.set(method, {
            handler,
            cancellationAware,
            serial: options.serial ?? false,
            queue: Promise.resolve(),
        });
    }

    async invoke(peerId: string, method: string, args: JsonLike[], timeoutMs?: number): Promise<JsonLike>;
    async invoke(peerId: string, method: string, args: JsonLike[], options?: RpcCallOptions): Promise<JsonLike>;
    async invoke(
        peerId: string,
        method: string,
        args: JsonLike[],
        timeoutOrOptions?: number | RpcCallOptions
    ): Promise<JsonLike>;
    async invoke(
        peerId: string,
        method: string,
        args: JsonLike[],
        timeoutOrOptions: number | RpcCallOptions = 30000
    ): Promise<JsonLike> {
        if (!validNamespacedMethod(method)) {
            throw new RpcError("PROTOCOL_ERROR", `Method must be namespaced: ${method}`);
        }
        if (this.closed) {
            throw new RpcError("NOT_CONNECTED", "Room is closed");
        }
        const options: RpcCallOptions =
            typeof timeoutOrOptions === "number" ? { timeoutMs: timeoutOrOptions } : (timeoutOrOptions ?? {});
        const timeoutMs = options.timeoutMs ?? 30000;
        if (options.signal?.aborted) {
            throw new RpcError("CANCELLED", `RPC cancelled: ${method}`);
        }
        const requestId = newId("req");
        let pending!: PendingInvocation;
        const p = new Promise<JsonLike>((resolve, reject) => {
            pending = {
                peerId,
                method,
                resolve,
                reject,
                signal: options.signal,
                requestSent: false,
                cancelRequested: false,
            };
            if (timeoutMs > 0) {
                pending.timeoutHandle = compatGlobal.setTimeout(() => {
                    this.rejectPending(requestId, new RpcError("TIMEOUT", `RPC timed out: ${method}`), true);
                }, timeoutMs);
            }
            this.pending.set(requestId, pending);
            if (options.signal) {
                const onAbort = () => {
                    const current = this.pending.get(requestId);
                    if (!current) return;
                    this.rejectPending(requestId, new RpcError("CANCELLED", `RPC cancelled: ${method}`), true);
                };
                pending.abortListener = onAbort;
                options.signal.addEventListener("abort", onAbort, { once: true });
                // The signal can be aborted between the check above and the
                // listener registration in an embedding host.
                if (options.signal.aborted) onAbort();
            }
        });

        const sendTask = this.sendEnvelope(peerId, {
            kind: "request",
            requestId,
            method,
            args,
        });
        void sendTask.then(
            () => {
                // The invocation can already have been cancelled while the
                // transport was waiting. Mark the request as sent only after
                // the transport settles, then preserve request-before-cancel
                // ordering for the late cancellation notification.
                const current = this.pending.get(requestId);
                pending.requestSent = true;
                if (!current && pending.cancelRequested) {
                    this.notifyRemoteCancellation(peerId, requestId);
                }
            },
            (ex: unknown) => {
                // A cancellation may have already removed the pending call.
                // In that case the late transport failure is deliberately
                // consumed here rather than becoming an unhandled rejection.
                const current = this.pending.get(requestId);
                if (!current) return;
                const failed = this.removePending(requestId);
                if (failed) failed.reject(ex);
            }
        );

        return await p;
    }

    async cancel(peerId: string, requestId: string) {
        const pending = this.pending.get(requestId);
        if (pending?.peerId === peerId) {
            const requestSent = pending.requestSent;
            pending.cancelRequested = true;
            this.rejectPending(requestId, new RpcError("CANCELLED", "Invocation cancelled"));
            // If the request is still being sent, invoke() sends the cancel
            // after its request envelope settles to preserve wire ordering.
            if (!requestSent) return;
        }
        await this.sendEnvelope(peerId, {
            kind: "cancel",
            requestId,
        });
    }

    private removePending(requestId: string) {
        const pending = this.pending.get(requestId);
        if (!pending) return undefined;
        this.pending.delete(requestId);
        if (pending.timeoutHandle !== undefined) {
            compatGlobal.clearTimeout(pending.timeoutHandle);
        }
        if (pending.signal && pending.abortListener) {
            pending.signal.removeEventListener("abort", pending.abortListener);
        }
        return pending;
    }

    private rejectPending(requestId: string, error: RpcError, notifyRemote = false) {
        const pending = this.pending.get(requestId);
        if (!pending) return;
        if (notifyRemote) pending.cancelRequested = true;
        const removed = this.removePending(requestId);
        if (!removed) return;
        removed.reject(error);
        if (notifyRemote && removed.requestSent) this.notifyRemoteCancellation(removed.peerId, requestId);
    }

    private notifyRemoteCancellation(peerId: string, requestId: string) {
        void this.sendEnvelope(peerId, { kind: "cancel", requestId }).catch((error: unknown) => {
            this.options.onProtocolWarning?.(`Failed to send RPC cancellation: ${String(error)}`, peerId);
        });
    }

    private abortInboundCall(requestId: string, context: InboundCallContext) {
        if (this.inboundCalls.get(requestId) !== context) return;
        if (!context.signal.aborted) {
            context.controller.abort(new RpcError("CANCELLED", "Invocation cancelled"));
        }
    }

    private async sendEnvelope(peerId: string, envelope: RpcEnvelope) {
        const serialized = JSON.stringify(envelope);
        if (estimateBytes(serialized) <= this.options.maxWirePayloadBytes) {
            await this.options.transport.send({ wire: "raw", payload: serialized }, peerId);
            return;
        }
        const streamId = newId("stream");
        const chunks = splitIntoChunks(serialized, this.options.maxWirePayloadBytes);
        this.outgoingChunkMap.set(streamId, { peerId, chunks });
        for (let i = 0; i < chunks.length; i++) {
            await this.options.transport.send(
                {
                    wire: "chunk",
                    streamId,
                    index: i,
                    total: chunks.length,
                    payload: chunks[i],
                },
                peerId
            );
        }
    }

    private scheduleMissingAck(streamId: string, peerId: string) {
        const existing = this.incomingChunkTimers.get(streamId);
        if (existing) compatGlobal.clearTimeout(existing);
        const handle = compatGlobal.setTimeout(() => {
            const state = this.incomingChunkMap.get(streamId);
            if (!state || state.isComplete()) return;
            const missing = state.missingIndices();
            void this.options.transport.send({ wire: "chunk-ack", streamId, missing }, peerId);
        }, this.options.chunkMissingRetryMs);
        this.incomingChunkTimers.set(streamId, handle);
    }

    private async onWireMessage(message: RpcWireMessage, peerId: string) {
        if (message.wire === "raw") {
            await this.onEnvelopePayload(message.payload, peerId);
            return;
        }
        if (message.wire === "chunk") {
            let state = this.incomingChunkMap.get(message.streamId);
            if (!state) {
                state = new IncomingChunkBuffer(message.total);
                this.incomingChunkMap.set(message.streamId, state);
            }
            state.add(message.index, message.payload);
            this.scheduleMissingAck(message.streamId, peerId);
            if (state.isComplete()) {
                const timer = this.incomingChunkTimers.get(message.streamId);
                if (timer) compatGlobal.clearTimeout(timer);
                this.incomingChunkTimers.delete(message.streamId);
                this.incomingChunkMap.delete(message.streamId);
                await this.options.transport.send(
                    { wire: "chunk-ack", streamId: message.streamId, missing: [] },
                    peerId
                );
                await this.onEnvelopePayload(state.toPayload(), peerId);
            }
            return;
        }
        const state = this.outgoingChunkMap.get(message.streamId);
        if (!state) return;
        if (message.missing.length === 0) {
            this.outgoingChunkMap.delete(message.streamId);
            return;
        }
        for (const index of message.missing) {
            const payload = state.chunks[index];
            if (payload === undefined) continue;
            await this.options.transport.send(
                {
                    wire: "chunk",
                    streamId: message.streamId,
                    index,
                    total: state.chunks.length,
                    payload,
                },
                state.peerId
            );
        }
    }

    private async onEnvelopePayload(payload: string, peerId: string) {
        let envelope: RpcEnvelope;
        try {
            envelope = JSON.parse(payload) as RpcEnvelope;
        } catch (ex) {
            this.options.onProtocolWarning?.("Invalid payload", peerId);
            this.options.onProtocolWarning?.(String(ex), peerId);
            return;
        }
        if (envelope.kind === "handshake") {
            this.peerVersion.set(peerId, { major: envelope.versionMajor, minor: envelope.versionMinor });
            if (envelope.versionMajor !== RPC_VERSION_MAJOR) {
                this.options.onProtocolWarning?.(
                    `RPC major mismatch: local=${RPC_VERSION_MAJOR}, remote=${envelope.versionMajor}`,
                    peerId
                );
            }
            return;
        }
        if (envelope.kind === "cancel") {
            const ctx = this.inboundCalls.get(envelope.requestId);
            if (ctx && ctx.peerId === peerId) this.abortInboundCall(envelope.requestId, ctx);
            return;
        }
        if (envelope.kind === "response") {
            const pending = this.pending.get(envelope.requestId);
            if (!pending) return;
            const settled = this.removePending(envelope.requestId);
            if (!settled) return;
            if (envelope.ok === true) {
                settled.resolve(envelope.data);
            } else {
                settled.reject(new RpcError(envelope.error.code, envelope.error.message, envelope.error.details));
            }
            return;
        }

        // Register the request context before admission can await. A caller
        // may cancel while admission performs asynchronous policy checks.
        const controller = new AbortController();
        const ctx: InboundCallContext = { controller, signal: controller.signal, peerId };
        this.inboundCalls.set(envelope.requestId, ctx);

        let accepted: boolean | undefined;
        try {
            accepted = await this.options.canAcceptRequest?.(peerId, envelope.method, ctx);
        } catch (ex) {
            this.inboundCalls.delete(envelope.requestId);
            if (!ctx.signal.aborted && !this.closed) {
                await this.sendEnvelope(peerId, {
                    kind: "response",
                    requestId: envelope.requestId,
                    ok: false,
                    error: asRpcErrorShape(ex),
                });
            }
            return;
        }
        if (accepted === false) {
            // Intentional timeout semantics for unauthorized caller.
            this.inboundCalls.delete(envelope.requestId);
            return;
        }
        if (ctx.signal.aborted || this.closed) {
            this.inboundCalls.delete(envelope.requestId);
            return;
        }

        const version = this.peerVersion.get(peerId);
        if (version && version.major !== RPC_VERSION_MAJOR) {
            if (!ctx.signal.aborted && !this.closed) {
                await this.sendEnvelope(peerId, {
                    kind: "response",
                    requestId: envelope.requestId,
                    ok: false,
                    error: {
                        code: "REMOTE_ERROR",
                        message: `RPC major mismatch: local=${RPC_VERSION_MAJOR}, remote=${version.major}`,
                    },
                });
            }
            this.inboundCalls.delete(envelope.requestId);
            return;
        }
        if (version && version.minor !== RPC_VERSION_MINOR) {
            this.options.onProtocolWarning?.(
                `RPC minor mismatch: local=${RPC_VERSION_MINOR}, remote=${version.minor}`,
                peerId
            );
        }

        const method = this.methods.get(envelope.method);
        if (!method) {
            if (!ctx.signal.aborted && !this.closed) {
                await this.sendEnvelope(peerId, {
                    kind: "response",
                    requestId: envelope.requestId,
                    ok: false,
                    error: {
                        code: "REMOTE_ERROR",
                        message: `Method not found: ${envelope.method}`,
                    },
                });
            }
            this.inboundCalls.delete(envelope.requestId);
            return;
        }

        const runner = async () => {
            try {
                if (ctx.signal.aborted || this.closed) return;
                // Private registration stores this flag with the matching
                // handler arm, so it is the discriminant for invocation here.
                const data = method.cancellationAware
                    ? await (method.handler as RpcCancellationAwareMethodHandler<JsonLike[], JsonLike>)(
                          ctx,
                          peerId,
                          ...envelope.args
                      )
                    : await (method.handler as RpcMethodHandler<JsonLike[], JsonLike>)(peerId, ...envelope.args);
                if (ctx.signal.aborted || this.closed) return;
                await this.sendEnvelope(peerId, {
                    kind: "response",
                    requestId: envelope.requestId,
                    ok: true,
                    data,
                });
            } catch (ex) {
                // A cancellation-aware handler may reject after observing its
                // signal. The caller already has the cancellation outcome, so
                // never send a stale response in that case.
                if (ctx.signal.aborted || this.closed) return;
                await this.sendEnvelope(peerId, {
                    kind: "response",
                    requestId: envelope.requestId,
                    ok: false,
                    error: asRpcErrorShape(ex),
                });
            } finally {
                if (this.inboundCalls.get(envelope.requestId) === ctx) {
                    this.inboundCalls.delete(envelope.requestId);
                }
            }
        };

        if (method.serial) {
            method.queue = method.queue.then(runner, runner);
            await method.queue;
        } else {
            await runner();
        }
    }
}
