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
    static override [Symbol.hasInstance](value: unknown): boolean {
        return (
            Function.prototype[Symbol.hasInstance].call(this, value) ||
            (this === RpcError && value instanceof P2pRpcError)
        );
    }

    override toShape(): RpcErrorShape {
        return { code: this.code, message: this.message, details: this.details };
    }
};

/** Return the structured error through Commonlib's JSON-compatible type. */
export function asRpcErrorShape(error: unknown): RpcErrorShape {
    return asP2pRpcErrorShape(error);
}
