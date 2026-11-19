import {
    createJsonCodec,
    RpcRoom,
    type JsonLike,
    type RpcCallOptions,
    type RpcCancellationAwareMethodHandler,
    type RpcSession as FancyKitRpcSession,
    type RpcErrorShape,
    type RpcMethodHandler,
    type RpcRegisterOptions,
    type RpcRoomOptions,
} from "@vrtmrz/rpc/p2p";
import { commonlibRpcRoom } from "@lib/rpc/commonlibRpcRoom";
import { asRpcErrorShape, RpcError, toCommonlibRpcError } from "@lib/rpc/errors";
import { RpcSession } from "@lib/rpc/RpcSession";
import { formatRpcProtocolWarning } from "./rpcCompat";

const responseErrors = new WeakMap<RpcErrorShape, unknown>();

class HostedRpcError extends RpcError {
    constructor(private readonly originalError: unknown) {
        super("REMOTE_ERROR", "Commonlib RPC callback failed");
    }

    override toShape(): RpcErrorShape {
        const safe = super.toShape();
        responseErrors.set(safe, this.originalError);
        return safe;
    }
}

function redactCallbackErrors<Args extends unknown[], Result>(handler: (...args: Args) => Result | Promise<Result>) {
    return async (...args: Args): Promise<Result> => {
        try {
            return await handler(...args);
        } catch (error) {
            throw new HostedRpcError(error);
        }
    };
}

function getResponseError(safe: RpcErrorShape): RpcErrorShape {
    try {
        const { code, message, details } = asRpcErrorShape(responseErrors.get(safe));
        return { code, message, details };
    } catch {
        return safe;
    }
}

/** Adapts Fancy Kit's text diagnostics while retaining its wire responses. */
export class TrysteroRpcRoom extends RpcRoom<AbortSignal> {
    readonly [commonlibRpcRoom] = true;
    // Follow the underlying cache's lifetime, including peer departure and room closure.
    private readonly commonlibSessions = new WeakMap<FancyKitRpcSession, InstanceType<typeof RpcSession>>();

    constructor(options: Omit<RpcRoomOptions<AbortSignal>, "codec">) {
        const codec = createJsonCodec();
        const {
            canAcceptRequest,
            onProtocolWarning,
            createAbortController = () => {
                if (typeof AbortController === "undefined") {
                    throw new RpcError("PROTOCOL_ERROR", "Supply createAbortController in this host");
                }
                return new AbortController();
            },
        } = options;
        let notificationMethod: string | undefined;
        let minorMismatch: { message: string; peerId?: string } | undefined;
        const emitWarning = async (message: string, peerId?: string) => {
            try {
                await onProtocolWarning?.(message, peerId);
            } catch {
                // Match Fancy Kit's isolation of diagnostic observers.
            }
        };

        super({
            ...options,
            createAbortController() {
                const controller = createAbortController();
                return {
                    signal: controller.signal,
                    abort(reason) {
                        controller.abort(toCommonlibRpcError(reason));
                    },
                };
            },
            canAcceptRequest: canAcceptRequest && redactCallbackErrors(canAcceptRequest),
            onProtocolWarning(message, peerId) {
                if (message.startsWith("RPC minor mismatch: ")) {
                    const warning = { message, peerId };
                    minorMismatch = warning;
                    // Only associate a mismatch with a method read in the same turn.
                    queueMicrotask(() => {
                        if (minorMismatch === warning) {
                            minorMismatch = undefined;
                            void emitWarning(message, peerId);
                        }
                    });
                    return;
                }
                return onProtocolWarning?.(formatRpcProtocolWarning(message, notificationMethod), peerId);
            },
            codec: {
                decode(payload) {
                    const envelope = codec.decode(payload);
                    if (envelope.kind !== "request") {
                        return envelope;
                    }
                    const { method, expectsResponse } = envelope;
                    return {
                        ...envelope,
                        get method() {
                            // Fancy Kit 0.1.0 reads the method immediately before emitting a
                            // notification failure and immediately after a minor mismatch.
                            // Neither path yields between the read and the warning.
                            notificationMethod = expectsResponse === false ? method : undefined;
                            if (minorMismatch) {
                                const { message, peerId } = minorMismatch;
                                minorMismatch = undefined;
                                void emitWarning(
                                    expectsResponse === false
                                        ? `RPC notification ${method}: protocol minor version mismatch`
                                        : message,
                                    peerId
                                );
                            }
                            return method;
                        },
                    };
                },
                encode(envelope) {
                    if (envelope.kind !== "response" || envelope.ok !== false) {
                        return codec.encode(envelope);
                    }
                    // Fancy Kit 0.1.0 passes the same shape to the response codec.
                    if (!responseErrors.has(envelope.error)) {
                        return codec.encode(envelope);
                    }
                    return codec.encode({ ...envelope, error: getResponseError(envelope.error) });
                },
            },
        });
    }

    override session(peerId: string) {
        try {
            const underlying = super.session(peerId);
            let session = this.commonlibSessions.get(underlying);
            if (!session) {
                session = new RpcSession(this, peerId);
                this.commonlibSessions.set(underlying, session);
            }
            return session;
        } catch (error) {
            throw toCommonlibRpcError(error);
        }
    }

    override async invoke(
        peerId: string,
        method: string,
        args: JsonLike[],
        options?: number | RpcCallOptions
    ): Promise<JsonLike> {
        try {
            return await super.invoke(peerId, method, args, options);
        } catch (error) {
            throw toCommonlibRpcError(error);
        }
    }

    override async notify(peerId: string, method: string, args: JsonLike[]): Promise<void> {
        try {
            await super.notify(peerId, method, args);
        } catch (error) {
            throw toCommonlibRpcError(error);
        }
    }

    override register<Args extends JsonLike[], Result>(
        method: string,
        handler: RpcMethodHandler<Args, Result>,
        options?: RpcRegisterOptions
    ): void {
        try {
            super.register(method, redactCallbackErrors(handler), options);
        } catch (error) {
            throw toCommonlibRpcError(error);
        }
    }

    override registerCancellable<Args extends JsonLike[], Result>(
        method: string,
        handler: RpcCancellationAwareMethodHandler<Args, Result, AbortSignal>,
        options?: RpcRegisterOptions
    ): void {
        try {
            super.registerCancellable(method, redactCallbackErrors(handler), options);
        } catch (error) {
            throw toCommonlibRpcError(error);
        }
    }
}
