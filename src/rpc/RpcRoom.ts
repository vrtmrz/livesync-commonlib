import { IncomingChunkBuffer, estimateBytes, splitIntoChunks } from "./chunking";
import { asRpcErrorShape, RpcError } from "./errors";
import { RpcSession } from "./RpcSession";
import {
    RPC_VERSION_MAJOR,
    RPC_VERSION_MINOR,
    type JsonLike,
    type RpcEnvelope,
    type RpcMethodHandler,
    type RpcRegisterOptions,
    type RpcRoomOptions,
    type RpcWireMessage,
} from "./types";

type PendingInvocation = {
    resolve: (value: JsonLike) => void;
    reject: (reason?: unknown) => void;
    timeoutHandle?: ReturnType<typeof setTimeout>;
};

type InboundCallContext = {
    cancelled: boolean;
};

type RegisteredMethod = {
    handler: RpcMethodHandler;
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
    private methods = new Map<string, RegisteredMethod>();
    private sessions = new Map<string, RpcSession>();
    private outgoingChunkMap = new Map<string, OutgoingChunkState>();
    private incomingChunkMap = new Map<string, IncomingChunkBuffer>();
    private incomingChunkTimers = new Map<string, ReturnType<typeof setTimeout>>();
    private peerVersion = new Map<string, { major: number; minor: number }>();
    private disposer: (() => void) | undefined;

    constructor(options: RpcRoomOptions) {
        this.options = {
            maxWirePayloadBytes: options.maxWirePayloadBytes ?? 32 * 1024,
            chunkMissingRetryMs: options.chunkMissingRetryMs ?? 350,
            ...options,
        };
        this.disposer = this.options.transport.onMessage((msg, peerId) => {
            void this.onWireMessage(msg, peerId);
        });
        if (this.options.transport.onPeerJoin) {
            this.options.transport.onPeerJoin((peerId) => {
                void this.sendEnvelope(peerId, {
                    kind: "handshake",
                    versionMajor: RPC_VERSION_MAJOR,
                    versionMinor: RPC_VERSION_MINOR,
                });
            });
        }
        if (this.options.transport.onPeerLeave) {
            this.options.transport.onPeerLeave((peerId) => {
                this.sessions.delete(peerId);
                this.peerVersion.delete(peerId);
            });
        }
    }

    close() {
        this.disposer?.();
        this.pending.forEach((pending) => pending.reject(new RpcError("NOT_CONNECTED", "Room closed")));
        this.pending.clear();
        this.inboundCalls.clear();
        this.methods.clear();
        this.sessions.clear();
        this.outgoingChunkMap.clear();
        this.incomingChunkMap.clear();
        this.incomingChunkTimers.forEach((h) => clearTimeout(h));
        this.incomingChunkTimers.clear();
    }

    session(peerId: string) {
        const existing = this.sessions.get(peerId);
        if (existing) return existing;
        const s = new RpcSession(this, peerId);
        this.sessions.set(peerId, s);
        return s;
    }

    register(method: string, handler: RpcMethodHandler, options: RpcRegisterOptions = {}) {
        if (!validNamespacedMethod(method)) {
            throw new RpcError("PROTOCOL_ERROR", `Method must be namespaced: ${method}`);
        }
        this.methods.set(method, {
            handler,
            serial: options.serial ?? false,
            queue: Promise.resolve(),
        });
    }

    async invoke(peerId: string, method: string, args: JsonLike[], timeoutMs = 30000): Promise<JsonLike> {
        if (!validNamespacedMethod(method)) {
            throw new RpcError("PROTOCOL_ERROR", `Method must be namespaced: ${method}`);
        }
        const requestId = newId("req");
        const p = new Promise<JsonLike>((resolve, reject) => {
            const pending: PendingInvocation = { resolve, reject };
            if (timeoutMs > 0) {
                pending.timeoutHandle = setTimeout(() => {
                    this.pending.delete(requestId);
                    reject(new RpcError("TIMEOUT", `RPC timed out: ${method}`));
                }, timeoutMs);
            }
            this.pending.set(requestId, pending);
        });

        await this.sendEnvelope(peerId, {
            kind: "request",
            requestId,
            method,
            args,
        });

        return await p;
    }

    async cancel(peerId: string, requestId: string) {
        await this.sendEnvelope(peerId, {
            kind: "cancel",
            requestId,
        });
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
        if (existing) clearTimeout(existing);
        const handle = setTimeout(() => {
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
                if (timer) clearTimeout(timer);
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
            if (ctx) ctx.cancelled = true;
            return;
        }
        if (envelope.kind === "response") {
            const pending = this.pending.get(envelope.requestId);
            if (!pending) return;
            this.pending.delete(envelope.requestId);
            if (pending.timeoutHandle) clearTimeout(pending.timeoutHandle);
            if (envelope.ok) {
                pending.resolve(envelope.data);
            } else {
                pending.reject(new RpcError(envelope.error.code, envelope.error.message, envelope.error.details));
            }
            return;
        }

        const accepted = await this.options.canAcceptRequest?.(peerId, envelope.method);
        if (accepted === false) {
            // Intentional timeout semantics for unauthorized caller.
            return;
        }

        const version = this.peerVersion.get(peerId);
        if (version && version.major !== RPC_VERSION_MAJOR) {
            await this.sendEnvelope(peerId, {
                kind: "response",
                requestId: envelope.requestId,
                ok: false,
                error: {
                    code: "REMOTE_ERROR",
                    message: `RPC major mismatch: local=${RPC_VERSION_MAJOR}, remote=${version.major}`,
                },
            });
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
            await this.sendEnvelope(peerId, {
                kind: "response",
                requestId: envelope.requestId,
                ok: false,
                error: {
                    code: "REMOTE_ERROR",
                    message: `Method not found: ${envelope.method}`,
                },
            });
            return;
        }

        const ctx: InboundCallContext = { cancelled: false };
        this.inboundCalls.set(envelope.requestId, ctx);

        const runner = async () => {
            try {
                if (ctx.cancelled) {
                    throw new RpcError("CANCELLED", "Invocation cancelled");
                }
                const data = await method.handler(peerId, ...envelope.args);
                if (ctx.cancelled) {
                    throw new RpcError("CANCELLED", "Invocation cancelled");
                }
                await this.sendEnvelope(peerId, {
                    kind: "response",
                    requestId: envelope.requestId,
                    ok: true,
                    data,
                });
            } catch (ex) {
                await this.sendEnvelope(peerId, {
                    kind: "response",
                    requestId: envelope.requestId,
                    ok: false,
                    error: asRpcErrorShape(ex),
                });
            } finally {
                this.inboundCalls.delete(envelope.requestId);
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
