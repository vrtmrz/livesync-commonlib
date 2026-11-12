import type { PouchDBShim, SomeDocument } from "@lib/pouchdb/ReplicatorShim";
import type { RpcSessionProvider } from "./rpcSessionProvider";
import {
    BULK_GET_RPC_TIMEOUT,
    DEFAULT_RPC_TIMEOUT,
    type BindableObject,
    type NonPrivateMethodKeys,
    type Response,
} from "./types";
import { toRpcMethodName } from "./rpcCompat";
import type { JsonLike, RpcCallOptions } from "@lib/rpc";

export class TrysteroReplicatorP2PClient<TProvider extends RpcSessionProvider = RpcSessionProvider> {
    _server: TProvider | undefined;

    _connectedPeerId: string;
    _remoteDB: PouchDBShim<SomeDocument<object>> | undefined;

    /** The cached remote database facade, or undefined after this client closes. */
    get remoteDB() {
        return this._remoteDB;
    }

    /**
     * Return the cached database facade or bind its calls to a finite-operation signal.
     * Each facade resolves the provider's current room when an operation runs.
     *
     * @throws {Error} when this client has closed.
     */
    getRemoteDB(signal?: AbortSignal): PouchDBShim<SomeDocument<object>> {
        const remoteDB = this._remoteDB;
        if (remoteDB === undefined) {
            throw new Error("Not connected to any room");
        }
        return signal ? this._bindRemoteDB(signal) : remoteDB;
    }

    constructor(server: TProvider, connectedPeerId: string) {
        this._server = server;
        this._connectedPeerId = connectedPeerId;
        this._remoteDB = this._bindRemoteDB();
    }

    _bindRemoteDB(signal?: AbortSignal) {
        return {
            info: this.bindRemoteFunction("info", DEFAULT_RPC_TIMEOUT, signal),
            changes: this.bindRemoteFunction("changes", DEFAULT_RPC_TIMEOUT, signal),
            revsDiff: this.bindRemoteFunction("revsDiff", DEFAULT_RPC_TIMEOUT, signal),
            bulkDocs: this.bindRemoteFunction("bulkDocs", DEFAULT_RPC_TIMEOUT, signal),
            bulkGet: this.bindRemoteFunction("bulkGet", BULK_GET_RPC_TIMEOUT, signal),
            put: this.bindRemoteFunction("put", DEFAULT_RPC_TIMEOUT, signal),
            get: this.bindRemoteFunction("get", DEFAULT_RPC_TIMEOUT, signal),
        } as PouchDBShim<SomeDocument<object>>;
    }

    private getCallOptions(timeout: number, signal?: AbortSignal): RpcCallOptions {
        return { timeoutMs: timeout, signal };
    }

    private getRpcRoom() {
        const room = this._server?.rpcRoom;
        if (!room) {
            throw new Error("Not connected to any room");
        }
        return room;
    }

    _sendRPC(type: string, args: JsonLike[], timeout = DEFAULT_RPC_TIMEOUT): Promise<JsonLike> {
        return this.getRpcRoom().session(this._connectedPeerId).call(toRpcMethodName(type), args, timeout);
    }

    __onResponse(_data: Response) {
        // Responses are now handled by RpcRoom.
    }

    bindRemoteFunction<T extends unknown[], U>(type: string, timeout = DEFAULT_RPC_TIMEOUT, signal?: AbortSignal) {
        return async (...args: T) => {
            return (await this.getRpcRoom()
                .session(this._connectedPeerId)
                .call(toRpcMethodName(type), args as JsonLike[], this.getCallOptions(timeout, signal))) as U;
        };
    }
    async invokeRemoteFunction<T extends unknown[], U>(
        type: string,
        args: T,
        timeout = DEFAULT_RPC_TIMEOUT,
        signal?: AbortSignal
    ) {
        return (await this.getRpcRoom()
            .session(this._connectedPeerId)
            .call(toRpcMethodName(type), args as JsonLike[], this.getCallOptions(timeout, signal))) as U;
    }
    /**
     * Send a notification without requesting an RPC response.
     * Resolves when the transport send completes.
     */
    async notifyRemoteFunction(type: string, args: JsonLike[]): Promise<void> {
        await this.getRpcRoom().session(this._connectedPeerId).notify(toRpcMethodName(type), args);
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- This is a generic function binder, so we can't be more specific about the types here.
    bindRemoteObjectFunctions<T extends BindableObject<any>, U extends keyof T>(key: U, timeout = DEFAULT_RPC_TIMEOUT) {
        type F = T[U];
        type P = Parameters<T[U]>;
        type R = ReturnType<F>;
        return async (...args: P): Promise<Awaited<R>> => {
            return (await this.getRpcRoom()
                .session(this._connectedPeerId)
                .call(toRpcMethodName(key.toString()), args as JsonLike[], timeout)) as Awaited<R>;
        };
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- This is a generic function binder, so we can't be more specific about the types here.
    async invokeRemoteObjectFunction<T extends BindableObject<any>, U extends NonPrivateMethodKeys<T>>(
        key: U,
        args: Parameters<T[U]>,
        timeout = DEFAULT_RPC_TIMEOUT,
        signal?: AbortSignal
    ): Promise<Awaited<ReturnType<T[U]>>> {
        return (await this.getRpcRoom()
            .session(this._connectedPeerId)
            .call(toRpcMethodName(key.toString()), args as JsonLike[], this.getCallOptions(timeout, signal))) as Awaited<
            ReturnType<T[U]>
        >;
    }

    /** Release the cached facade and provider reference; captured operations then reject without sending. */
    close() {
        this._remoteDB = undefined;
        this._server = undefined;
    }
}
