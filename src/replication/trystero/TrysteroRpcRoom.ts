import {
    createJsonCodec,
    RpcRoom,
    type JsonLike,
    type RpcCancellationAwareMethodHandler,
    type RpcErrorShape,
    type RpcMethodHandler,
    type RpcRegisterOptions,
    type RpcRoomOptions,
} from "@vrtmrz/rpc/p2p";
import { asRpcErrorShape, RpcError } from "@lib/rpc/errors";
import { formatRpcCallbackFailure } from "./rpcCompat";

const responseErrors = new WeakMap<RpcErrorShape, RpcErrorShape>();

class HostedRpcError extends RpcError {
    constructor(
        private readonly originalError: unknown,
        method: string
    ) {
        super("REMOTE_ERROR", formatRpcCallbackFailure(method));
    }

    override toShape(): RpcErrorShape {
        const original = asRpcErrorShape(this.originalError);
        const safe = { code: original.code, message: this.message };
        responseErrors.set(safe, original);
        return safe;
    }
}

function redactCallbackErrors<Args extends unknown[], Result>(
    handler: (...args: Args) => Result | Promise<Result>,
    getMethod: (...args: Args) => string
) {
    return async (...args: Args): Promise<Result> => {
        try {
            return await handler(...args);
        } catch (error) {
            throw new HostedRpcError(error, getMethod(...args));
        }
    };
}

/** Adapts Fancy Kit's text diagnostics while retaining its wire responses. */
export class TrysteroRpcRoom extends RpcRoom<AbortSignal> {
    constructor(options: Omit<RpcRoomOptions<AbortSignal>, "codec">) {
        const codec = createJsonCodec();
        const { canAcceptRequest } = options;
        super({
            ...options,
            canAcceptRequest: canAcceptRequest && redactCallbackErrors(canAcceptRequest, (_peerId, method) => method),
            codec: {
                ...codec,
                encode(envelope) {
                    if (envelope.kind !== "response" || envelope.ok !== false) {
                        return codec.encode(envelope);
                    }
                    // Fancy Kit 0.1.0 passes the same shape to the response codec.
                    const original = responseErrors.get(envelope.error);
                    return codec.encode(original ? { ...envelope, error: original } : envelope);
                },
            },
        });
    }

    override register<Args extends JsonLike[], Result>(
        method: string,
        handler: RpcMethodHandler<Args, Result>,
        options?: RpcRegisterOptions
    ): void {
        super.register(method, redactCallbackErrors(handler, () => method), options);
    }

    override registerCancellable<Args extends JsonLike[], Result>(
        method: string,
        handler: RpcCancellationAwareMethodHandler<Args, Result, AbortSignal>,
        options?: RpcRegisterOptions
    ): void {
        super.registerCancellable(method, redactCallbackErrors(handler, () => method), options);
    }
}
