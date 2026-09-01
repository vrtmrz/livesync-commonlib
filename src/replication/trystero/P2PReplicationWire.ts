import { RpcError, type JsonLike, type RpcErrorCode, type RpcErrorShape } from "@lib/rpc";
import { asRpcErrorShape } from "@lib/rpc/errors";
import type { P2PReplicationResult } from "./TrysteroReplicator";

/** JSON-safe representation used only while a replication result crosses RPC. */
export type P2PReplicationWireResult =
    | { readonly status: "completed"; readonly ok: true; readonly error?: never }
    | { readonly status: "cancelled"; readonly ok?: false; readonly error?: never }
    | { readonly status: "failed"; readonly ok?: false; readonly error: RpcErrorShape };

const RPC_ERROR_CODES = new Set<RpcErrorCode>([
    "TIMEOUT",
    "NOT_CONNECTED",
    "REMOTE_ERROR",
    "CANCELLED",
    "PROTOCOL_ERROR",
]);

function isRpcErrorCode(value: unknown): value is RpcErrorCode {
    return typeof value === "string" && RPC_ERROR_CODES.has(value as RpcErrorCode);
}

/**
 * Decompose a local result before it enters an `RpcRoom` success envelope.
 *
 * `Error` properties are not enumerable, so JSON would otherwise reduce the
 * failure to `{}` even though the surrounding result reaches the caller.
 */
export function toP2PReplicationWireResult(result: P2PReplicationResult): P2PReplicationWireResult {
    if (result.status !== "failed") return result;
    return { status: "failed", error: asRpcErrorShape(result.error) };
}

/**
 * Restore the local `Error` contract after a JSON-safe result leaves RPC.
 * Malformed results from an older or incompatible peer remain explicit errors
 * instead of leaking an untyped object into local result handling.
 */
export function fromP2PReplicationWireResult(result: P2PReplicationWireResult): P2PReplicationResult {
    if (result.status !== "failed") return result;
    const wireError = result.error as unknown;
    if (!wireError || typeof wireError !== "object" || !("message" in wireError)) {
        return {
            status: "failed",
            error: new RpcError(
                "REMOTE_ERROR",
                "The remote peer reported a replication failure without a usable reason."
            ),
        };
    }
    const record = wireError as { code?: unknown; message?: unknown; details?: JsonLike };
    if (typeof record.message !== "string") {
        return {
            status: "failed",
            error: new RpcError(
                "REMOTE_ERROR",
                "The remote peer reported a replication failure without a usable reason."
            ),
        };
    }
    const code = isRpcErrorCode(record.code) ? record.code : "REMOTE_ERROR";
    const { message, details } = record;
    return { status: "failed", error: new RpcError(code, message, details) };
}

/** Decompose an auxiliary command failure which remains inside successful RPC data. */
export function toP2PWireError(error: unknown): RpcErrorShape {
    return asRpcErrorShape(error);
}
