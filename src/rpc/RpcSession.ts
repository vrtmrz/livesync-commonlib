import { RpcError } from "./errors";
import type { JsonLike } from "./types";
import type { RpcRoom } from "./RpcRoom";

export class RpcSession {
    readonly peerId: string;
    private room: RpcRoom;

    constructor(room: RpcRoom, peerId: string) {
        this.room = room;
        this.peerId = peerId;
    }

    async call<T = JsonLike>(method: string, args: JsonLike[] = [], timeoutMs?: number): Promise<T> {
        if (!this.peerId) {
            throw new RpcError("NOT_CONNECTED", "Peer is not connected");
        }
        return (await this.room.invoke(this.peerId, method, args, timeoutMs)) as T;
    }

    createProxy<T extends object>(namespace: string): T {
        // Proxy handler needs access to `this` session instance, so we capture it in a closure here.
        // eslint-disable-next-line @typescript-eslint/no-this-alias
        const session = this;
        return new Proxy(
            {},
            {
                get(_target, propKey) {
                    if (typeof propKey !== "string") return undefined;
                    return async (...args: JsonLike[]) => {
                        return await session.call(`${namespace}.${propKey}`, args);
                    };
                },
            }
        ) as T;
    }
}
