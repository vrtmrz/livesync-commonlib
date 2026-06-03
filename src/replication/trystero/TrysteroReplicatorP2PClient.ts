import type { EntryDoc } from "../../common/types";
import type { PouchDBShim } from "../../pouchdb/ReplicatorShim";
import type { TrysteroReplicatorP2PServer } from "./TrysteroReplicatorP2PServer";
import { BULK_GET_RPC_TIMEOUT, DEFAULT_RPC_TIMEOUT, type BindableObject, type NonPrivateMethodKeys } from "./types";
import { toRpcMethodName } from "./rpcCompat";

export class TrysteroReplicatorP2PClient {
    _server: TrysteroReplicatorP2PServer;

    _connectedPeerId: string;
    _remoteDB: PouchDBShim<EntryDoc>;

    get remoteDB() {
        return this._remoteDB;
    }

    constructor(server: TrysteroReplicatorP2PServer, connectedPeerId: string) {
        this._server = server;
        this._connectedPeerId = connectedPeerId;
        this._remoteDB = this._bindRemoteDB();
    }

    _bindRemoteDB() {
        return {
            info: this.bindRemoteFunction("info"),
            changes: this.bindRemoteFunction("changes"),
            revsDiff: this.bindRemoteFunction("revsDiff"),
            bulkDocs: this.bindRemoteFunction("bulkDocs"),
            bulkGet: this.bindRemoteFunction("bulkGet", BULK_GET_RPC_TIMEOUT),
            put: this.bindRemoteFunction("put"),
            get: this.bindRemoteFunction("get"),
        } as PouchDBShim<EntryDoc>;
    }

    _sendRPC(type: string, args: any[], timeout = DEFAULT_RPC_TIMEOUT) {
        const room = this._server?.rpcRoom;
        if (!room) {
            throw new Error("Not connected to any room");
        }
        const session = room.session(this._connectedPeerId);
        return session.call(toRpcMethodName(type), args, timeout);
    }

    __onResponse(_data: any) {
        // Responses are now handled by RpcRoom.
    }

    bindRemoteFunction<T extends any[], U>(type: string, timeout = DEFAULT_RPC_TIMEOUT) {
        return async (...args: T) => {
            const room = this._server?.rpcRoom;
            if (!room) {
                throw new Error("Not connected to any room");
            }
            return (await room.session(this._connectedPeerId).call(toRpcMethodName(type), args as any, timeout)) as U;
        };
    }
    async invokeRemoteFunction<T extends any[], U>(type: string, args: T, timeout = DEFAULT_RPC_TIMEOUT) {
        const room = this._server?.rpcRoom;
        if (!room) {
            throw new Error("Not connected to any room");
        }
        return (await room.session(this._connectedPeerId).call(toRpcMethodName(type), args as any, timeout)) as U;
    }
    bindRemoteObjectFunctions<T extends BindableObject<any>, U extends keyof T>(key: U, timeout = DEFAULT_RPC_TIMEOUT) {
        type F = T[U];
        type P = Parameters<T[U]>;
        type R = ReturnType<F>;
        return async (...args: P): Promise<Awaited<R>> => {
            const room = this._server?.rpcRoom;
            if (!room) {
                throw new Error("Not connected to any room");
            }
            return await room
                .session(this._connectedPeerId)
                .call(toRpcMethodName(key.toString()), args as any, timeout);
        };
    }
    async invokeRemoteObjectFunction<T extends BindableObject<any>, U extends NonPrivateMethodKeys<T>>(
        key: U,
        args: Parameters<T[U]>,
        timeout = DEFAULT_RPC_TIMEOUT
    ): Promise<Awaited<ReturnType<T[U]>>> {
        const room = this._server?.rpcRoom;
        if (!room) {
            throw new Error("Not connected to any room");
        }
        return await room.session(this._connectedPeerId).call(toRpcMethodName(key.toString()), args as any, timeout);
    }

    close() {
        this._remoteDB = undefined!;
        this._server = undefined!;
    }
}
