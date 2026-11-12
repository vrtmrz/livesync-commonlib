import type { RpcRoom } from "@lib/rpc/RpcRoom";
import type { RpcSession } from "@lib/rpc/RpcSession";

type RpcSessionCall = (...args: Parameters<RpcSession["call"]>) => ReturnType<RpcRoom["invoke"]>;

/** The current RPC room capability required by a P2P client. */
export type RpcSessionProvider = {
    /** Resolve the active room for each operation; it may be replaced during the client's lifetime. */
    rpcRoom?: {
        session(peerId: string): Pick<RpcSession, "notify"> & { call: RpcSessionCall };
    };
};
