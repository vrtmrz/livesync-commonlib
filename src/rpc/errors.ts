import type { JsonLike, RpcErrorCode, RpcErrorShape } from "./types";

export class RpcError extends Error {
    code: RpcErrorCode;
    details?: JsonLike;

    constructor(code: RpcErrorCode, message: string, details?: JsonLike) {
        super(message);
        this.name = "RpcError";
        this.code = code;
        this.details = details;
    }

    toShape(): RpcErrorShape {
        return { code: this.code, message: this.message, details: this.details };
    }
}

export function asRpcErrorShape(ex: unknown): RpcErrorShape {
    if (ex instanceof RpcError) {
        return ex.toShape();
    }
    if (ex instanceof Error) {
        return { code: "REMOTE_ERROR", message: ex.message };
    }
    return { code: "REMOTE_ERROR", message: "Unknown remote error" };
}
