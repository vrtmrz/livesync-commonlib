import { RpcRoom as StandaloneRpcRoom } from "./RpcRoom";
import { RpcSession as StandaloneRpcSession } from "./RpcSession";

/** Public session operations shared by both RPC implementations. */
export type RpcSession = Pick<StandaloneRpcSession, keyof StandaloneRpcSession>;

/** Public room operations shared by the standalone and hosted rooms. */
export type RpcRoom = Omit<StandaloneRpcRoom, "session"> & {
    session(peerId: string): RpcSession;
};

export const RpcRoom: {
    new (...args: ConstructorParameters<typeof StandaloneRpcRoom>): RpcRoom;
    readonly prototype: RpcRoom;
} = StandaloneRpcRoom;

export const RpcSession: {
    new (...args: ConstructorParameters<typeof StandaloneRpcSession>): RpcSession;
    readonly prototype: RpcSession;
} = StandaloneRpcSession;

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
