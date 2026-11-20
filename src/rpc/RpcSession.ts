import { RpcSession as FancyKitRpcSession } from "@vrtmrz/rpc/p2p";
import { toCommonlibRpcError } from "./errors";
import type { RpcRoom } from "./RpcRoom";
import type { JsonLike, RpcCallOptions } from "./types";

export interface RpcSession extends Pick<FancyKitRpcSession, "peerId" | "notify" | "createProxy"> {
    call<T = JsonLike>(method: string, args?: JsonLike[], timeoutMs?: number): Promise<T>;
    call<T = JsonLike>(method: string, args?: JsonLike[], options?: RpcCallOptions): Promise<T>;
    call<T = JsonLike>(method: string, args: JsonLike[] | undefined, options?: number | RpcCallOptions): Promise<T>;
}

class CommonlibRpcSession extends FancyKitRpcSession {
    override async call<T = JsonLike>(
        method: string,
        args?: JsonLike[],
        options?: number | RpcCallOptions
    ): Promise<T> {
        try {
            return await super.call<T>(method, args, options);
        } catch (error) {
            throw toCommonlibRpcError(error);
        }
    }

    override async notify(method: string, args?: JsonLike[]): Promise<void> {
        try {
            await super.notify(method, args);
        } catch (error) {
            throw toCommonlibRpcError(error);
        }
    }
}

export const RpcSession: {
    new (room: Pick<RpcRoom, "invoke" | "notify">, peerId: string): RpcSession & FancyKitRpcSession;
    readonly prototype: RpcSession;
} = CommonlibRpcSession;
