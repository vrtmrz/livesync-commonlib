export const RPC_VERSION_MAJOR = 1;
export const RPC_VERSION_MINOR = 0;

export type JsonLike = null | boolean | number | string | JsonLike[] | { [key: string]: JsonLike };

export type RpcErrorCode = "TIMEOUT" | "NOT_CONNECTED" | "REMOTE_ERROR" | "CANCELLED" | "PROTOCOL_ERROR";

export type RpcErrorShape = {
    code: RpcErrorCode;
    message: string;
    details?: JsonLike;
};

/**
 * Options which control one outbound RPC invocation.
 *
 * The numeric timeout overload remains supported by {@link RpcSession.call}
 * and {@link RpcRoom.invoke}; use this object when a caller also needs an
 * abort signal.
 */
export type RpcCallOptions = {
    readonly timeoutMs?: number;
    readonly signal?: AbortSignal;
};

/**
 * Context supplied to handlers registered through the cancellation-aware
 * registration API.
 *
 * Cancellation is cooperative: the handler must observe `signal.aborted` or
 * otherwise pass the signal to an abort-capable operation. The RPC layer still
 * suppresses a response after cancellation when a handler does not stop
 * immediately.
 */
export type RpcRequestContext = {
    readonly signal: AbortSignal;
};

export type RpcRequestEnvelope = {
    kind: "request";
    requestId: string;
    method: string;
    args: JsonLike[];
};

export type RpcResponseEnvelope = {
    kind: "response";
    requestId: string;
    ok: true;
    data: JsonLike;
};

export type RpcResponseErrorEnvelope = {
    kind: "response";
    requestId: string;
    ok: false;
    error: RpcErrorShape;
};

export type RpcCancelEnvelope = {
    kind: "cancel";
    requestId: string;
};

export type RpcHandshakeEnvelope = {
    kind: "handshake";
    versionMajor: number;
    versionMinor: number;
};

export type RpcEnvelope =
    | RpcRequestEnvelope
    | RpcResponseEnvelope
    | RpcResponseErrorEnvelope
    | RpcCancelEnvelope
    | RpcHandshakeEnvelope;

export type RpcWireMessageRaw = {
    wire: "raw";
    payload: string;
};

export type RpcWireMessageChunk = {
    wire: "chunk";
    streamId: string;
    index: number;
    total: number;
    payload: string;
};

export type RpcWireMessageChunkAck = {
    wire: "chunk-ack";
    streamId: string;
    missing: number[];
};

export type RpcWireMessage = RpcWireMessageRaw | RpcWireMessageChunk | RpcWireMessageChunkAck;

export type TransportOnMessage = (message: RpcWireMessage, peerId: string) => void;
export type TransportOnPeer = (peerId: string) => void;

export interface TransportAdapter {
    send(message: RpcWireMessage, peerId: string): void | Promise<void>;
    onMessage(handler: TransportOnMessage): () => void;
    onPeerJoin?(handler: TransportOnPeer): () => void;
    onPeerLeave?(handler: TransportOnPeer): () => void;
}

export type RpcRoomOptions = {
    transport: TransportAdapter;
    maxWirePayloadBytes?: number;
    chunkMissingRetryMs?: number;
    canAcceptRequest?: (peerId: string, method: string, context: RpcRequestContext) => boolean | Promise<boolean>;
    onProtocolWarning?: (message: string, peerId?: string) => void;
};

export type RpcMethodHandler<T extends JsonLike[], U> = (peerId: string, ...args: T) => U | Promise<U>;

/** Handler which can stop cooperative work when its request is cancelled. */
export type RpcCancellationAwareMethodHandler<T extends JsonLike[], U> = (
    context: RpcRequestContext,
    peerId: string,
    ...args: T
) => U | Promise<U>;

export type RpcRegisterOptions = {
    serial?: boolean;
};
