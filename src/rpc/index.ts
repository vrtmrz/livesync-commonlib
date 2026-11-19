import { RpcRoom as StandaloneRpcRoom } from "./RpcRoom";
import type { RpcSession } from "./RpcSession";

/** Public room operations shared by the standalone and hosted rooms. */
export type RpcRoom = Omit<StandaloneRpcRoom, "session"> & {
    session(peerId: string): RpcSession;
};

export const RpcRoom: {
    new (...args: ConstructorParameters<typeof StandaloneRpcRoom>): RpcRoom;
    readonly prototype: RpcRoom;
} = StandaloneRpcRoom;

export { RpcSession } from "./RpcSession";
export { RpcError } from "./errors";
export { exposeDB } from "./pouchdb/RpcPouchDBServer";
export { RpcPouchDBProxy } from "./pouchdb/RpcPouchDBProxy";
export type {
    JsonLike,
    RpcEnvelope,
    RpcErrorCode,
    RpcErrorShape,
    RpcCallOptions,
    RpcCancellationAwareMethodHandler,
    RpcMethodHandler,
    RpcRegisterOptions,
    RpcRequestContext,
    RpcRoomOptions,
    RpcWireMessage,
    TransportAdapter,
} from "./types";
