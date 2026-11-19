import { asRpcErrorShape as asP2pRpcErrorShape, RpcError as P2pRpcError } from "@vrtmrz/rpc/p2p";
import type { JsonLike, RpcErrorCode, RpcErrorShape } from "./types";

/** The Commonlib error contract used by both RPC implementations. */
export interface RpcError extends Error {
    code: RpcErrorCode;
    details?: JsonLike;
    toShape(): RpcErrorShape;
}

export const RpcError: {
    new (code: RpcErrorCode, message: string, details?: JsonLike): RpcError;
    readonly prototype: RpcError;
} = class RpcError extends P2pRpcError {
    constructor(code: RpcErrorCode, message: string, details?: JsonLike) {
        super(code, message, details);
    }

    override toShape(): RpcErrorShape {
        return { code: this.code, message: this.message, details: this.details };
    }
};

export function toCommonlibRpcError(error: unknown): unknown {
    if (error instanceof P2pRpcError && !(error instanceof RpcError)) {
        return new RpcError(error.code, error.message, error.details);
    }
    return error;
}

/** Return the structured error through Commonlib's JSON-compatible type. */
export function asRpcErrorShape(error: unknown): RpcErrorShape {
    return asP2pRpcErrorShape(toCommonlibRpcError(error));
}
