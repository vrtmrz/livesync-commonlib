import { RpcSession as FancyKitRpcSession } from "@vrtmrz/rpc/p2p";
import type { RpcRoom } from "./RpcRoom";
import type { JsonLike, RpcCallOptions } from "./types";

export interface RpcSession extends Pick<FancyKitRpcSession, "peerId" | "notify" | "createProxy"> {
    call<T = JsonLike>(method: string, args?: JsonLike[], timeoutMs?: number): Promise<T>;
    call<T = JsonLike>(method: string, args?: JsonLike[], options?: RpcCallOptions): Promise<T>;
    call<T = JsonLike>(method: string, args: JsonLike[] | undefined, options?: number | RpcCallOptions): Promise<T>;
}

export const RpcSession: {
    new (room: Pick<RpcRoom, "invoke" | "notify">, peerId: string): RpcSession;
    readonly prototype: RpcSession;
} = FancyKitRpcSession;
