import { compatGlobal } from "@lib/common/coreEnvFunctions";
import {
    createDeferredAction,
    type DeferredAction,
    type TimeoutScheduler,
} from "octagonal-wheels/concurrency/deferredAction";
import { IncomingChunkBuffer, estimateBytes, splitIntoChunks } from "./chunking";
import { createPendingInvocations } from "./RpcRoom/pendingInvocations";
import { asRpcErrorShape, RpcError } from "./errors";
import { RpcSession } from "./RpcSession";
import {
    RPC_VERSION_MAJOR,
    RPC_VERSION_MINOR,
    type JsonLike,
    type RpcCallOptions,
    type RpcCancellationAwareMethodHandler,
    type RpcEnvelope,
    type RpcErrorShape,
    type RpcMethodHandler,
    type RpcRegisterOptions,
    type RpcRequestContext,
    type RpcRequestEnvelope,
    type RpcRoomOptions,
    type RpcWireMessage,
} from "./types";

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

const scheduleRpcTimeout: TimeoutScheduler = (callback, delayMs) => {
    const handle = compatGlobal.setTimeout(callback, delayMs);
    return () => compatGlobal.clearTimeout(handle);
};

export class RpcRoom {
    private options: Required<Pick<RpcRoomOptions, "maxWirePayloadBytes" | "chunkMissingRetryMs">> & RpcRoomOptions;
    private pendingInvocations: ReturnType<typeof createPendingInvocations>;
    private inboundCalls = new Map<string, InboundCallContext>();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- This is a generic type for method handlers, so we can't be more specific about the types here.
    private methods = new Map<string, RegisteredMethod<any, any>>();
    private sessions = new Map<string, RpcSession>();
    private outgoingChunkMap = new Map<string, OutgoingChunkState>();
    private incomingChunkMap = new Map<string, IncomingChunkBuffer>();
    private incomingChunkWaits = new Map<string, DeferredAction>();
    private peerVersion = new Map<string, { major: number; minor: number }>();
    private disposers: Array<() => void> = [];
    private closed = false;

    constructor(options: RpcRoomOptions) {
        this.options = {
            maxWirePayloadBytes: options.maxWirePayloadBytes ?? 32 * 1024,
            chunkMissingRetryMs: options.chunkMissingRetryMs ?? 350,
            ...options,
        };
        this.pendingInvocations = createPendingInvocations({
            sendEnvelope: (peerId, envelope) => this.sendEnvelope(peerId, envelope),
            createRequestId: () => newId("req"),
            scheduleTimeout: scheduleRpcTimeout,
            onProtocolWarning: (message, peerId) => this.options.onProtocolWarning?.(message, peerId),
        });
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
                    this.pendingInvocations.peerLeft(peerId);
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
        this.pendingInvocations.close();
        this.inboundCalls.forEach((context, requestId) => {
            this.abortInboundCall(requestId, context);
        });
        this.inboundCalls.clear();
        this.methods.clear();
        this.sessions.clear();
        this.outgoingChunkMap.clear();
        this.incomingChunkMap.clear();
        this.incomingChunkWaits.forEach((wait) => wait.dispose());
        this.incomingChunkWaits.clear();
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
        return await this.pendingInvocations.invoke(peerId, method, args, timeoutOrOptions);
    }

    /**
     * Send a notification to a peer without creating an RPC response wait.
     * Resolves when the local transport send completes; it does not report
     * whether the peer accepted or completed the handler.
     */
    async notify(peerId: string, method: string, args: JsonLike[]): Promise<void> {
        if (!validNamespacedMethod(method)) {
            throw new RpcError("PROTOCOL_ERROR", `Method must be namespaced: ${method}`);
        }
        if (this.closed) {
            throw new RpcError("NOT_CONNECTED", "Room is closed");
        }
        await this.sendEnvelope(peerId, {
            kind: "request",
            requestId: newId("req"),
            method,
            args,
            expectsResponse: false,
        });
    }

    async cancel(peerId: string, requestId: string) {
        return await this.pendingInvocations.cancel(peerId, requestId);
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
            await this.sendChunk(peerId, streamId, chunks.length, i, chunks[i]);
        }
    }

    private sendChunk(peerId: string, streamId: string, total: number, index: number, payload: string) {
        return this.options.transport.send({ wire: "chunk", streamId, index, total, payload }, peerId);
    }

    private sendErrorResponse(peerId: string, requestId: string, error: RpcErrorShape) {
        return this.sendEnvelope(peerId, { kind: "response", requestId, ok: false, error });
    }

    private async reportRequestFailure(
        envelope: RpcRequestEnvelope,
        peerId: string,
        error: RpcErrorShape,
        notificationReason: string
    ) {
        if (envelope.expectsResponse === false) {
            this.warnNotificationIssue(envelope, notificationReason, peerId);
            return;
        }
        await this.sendErrorResponse(peerId, envelope.requestId, error);
    }

    private warnNotificationIssue(envelope: RpcRequestEnvelope, reason: string, peerId: string) {
        try {
            this.options.onProtocolWarning?.(`RPC notification ${envelope.method}: ${reason}`, peerId);
        } catch {
            // Diagnostic callbacks must not interrupt request cleanup or handler processing.
        }
    }

    private scheduleMissingAck(streamId: string, peerId: string) {
        this.incomingChunkWaits.get(streamId)?.dispose();
        const wait = createDeferredAction(() => {
            const state = this.incomingChunkMap.get(streamId);
            if (!state || state.isComplete()) return;
            const missing = state.missingIndices();
            void this.options.transport.send({ wire: "chunk-ack", streamId, missing }, peerId);
        }, scheduleRpcTimeout);
        wait.schedule(this.options.chunkMissingRetryMs);
        this.incomingChunkWaits.set(streamId, wait);
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
                this.incomingChunkWaits.get(message.streamId)?.dispose();
                this.incomingChunkWaits.delete(message.streamId);
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
            await this.sendChunk(state.peerId, message.streamId, state.chunks.length, index, payload);
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
            this.pendingInvocations.receiveResponse(envelope);
            return;
        }

        return this.onRequest(envelope, peerId);
    }

    private async onRequest(envelope: RpcRequestEnvelope, peerId: string) {
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
                await this.reportRequestFailure(envelope, peerId, asRpcErrorShape(ex), "admission check failed");
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
                await this.reportRequestFailure(
                    envelope,
                    peerId,
                    {
                        code: "REMOTE_ERROR",
                        message: `RPC major mismatch: local=${RPC_VERSION_MAJOR}, remote=${version.major}`,
                    },
                    "protocol major version mismatch"
                );
            }
            this.inboundCalls.delete(envelope.requestId);
            return;
        }
        if (version && version.minor !== RPC_VERSION_MINOR) {
            if (envelope.expectsResponse === false) {
                this.warnNotificationIssue(envelope, "protocol minor version mismatch", peerId);
            } else {
                this.options.onProtocolWarning?.(
                    `RPC minor mismatch: local=${RPC_VERSION_MINOR}, remote=${version.minor}`,
                    peerId
                );
            }
        }

        const method = this.methods.get(envelope.method);
        if (!method) {
            if (!ctx.signal.aborted && !this.closed) {
                await this.reportRequestFailure(
                    envelope,
                    peerId,
                    {
                        code: "REMOTE_ERROR",
                        message: `Method not found: ${envelope.method}`,
                    },
                    "method not found"
                );
            }
            this.inboundCalls.delete(envelope.requestId);
            return;
        }

        const runner = () => this.runMethod(method, envelope, peerId, ctx);

        if (method.serial) {
            method.queue = method.queue.then(runner, runner);
            await method.queue;
        } else {
            await runner();
        }
    }

    private async runMethod(
        method: RegisteredMethod<JsonLike[], JsonLike>,
        envelope: RpcRequestEnvelope,
        peerId: string,
        ctx: InboundCallContext
    ) {
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
            if (ctx.signal.aborted || this.closed || envelope.expectsResponse === false) {
                return;
            }
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
            await this.reportRequestFailure(envelope, peerId, asRpcErrorShape(ex), "handler failed");
        } finally {
            if (this.inboundCalls.get(envelope.requestId) === ctx) {
                this.inboundCalls.delete(envelope.requestId);
            }
        }
    }
}
