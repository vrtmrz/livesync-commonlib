import {
    RpcError,
    RpcPouchDBProxy,
    RpcRoom,
    RpcSession,
    exposeDB,
    type JsonLike,
    type RpcRoomOptions,
} from "@vrtmrz/livesync-commonlib/rpc";
import type { TrysteroReplicatorP2PServer } from "@vrtmrz/livesync-commonlib/compat/replication/trystero/TrysteroReplicatorP2PServer";

declare const host: TrysteroReplicatorP2PServer;
declare const db: Parameters<typeof exposeDB>[1];
declare const options: RpcRoomOptions;

const hostRoom = host.rpcRoom!;
const room: RpcRoom = hostRoom;
const session: RpcSession = hostRoom.session("fixture-peer");
const boundSession = new RpcSession(hostRoom, "fixture-peer");
const ownRoom = new RpcRoom(options);

exposeDB(hostRoom, db);
const proxy = new RpcPouchDBProxy(hostRoom.session("fixture-peer"), "fixture-db");

const error = new RpcError("REMOTE_ERROR", "fixture error");
error.code = "TIMEOUT";
error.details = { fixture: true };
const shape: JsonLike = error.toShape();

void [room, session, boundSession, ownRoom, proxy, shape];
