import { Logger, LOG_LEVEL_VERBOSE } from "octagonal-wheels/common/logger";
import { type PromiseWithResolvers, promiseWithResolver } from "octagonal-wheels/promises";
import type { EntryDoc } from "../../common/types";
import type { PouchDBShim } from "../../pouchdb/ReplicatorShim";
import type { TrysteroReplicatorP2PServer } from "./TrysteroReplicatorP2PServer";
import {
    DEFAULT_RPC_TIMEOUT,
    type Request,
    DIRECTION_REQUEST,
    type Response,
    type BindableObject,
    type NonPrivateMethodKeys,
} from "./types";

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
            bulkGet: this.bindRemoteFunction("bulkGet"),
            put: this.bindRemoteFunction("put"),
            get: this.bindRemoteFunction("get"),
        } as PouchDBShim<EntryDoc>;
    }

    get __send() {
        return this._server?.__send.bind(this._server);
    }

    _prevSeq = 0;
    generateNewSeq(): number {
        const seq = Math.floor(Math.random() * 115) + 1 + this._prevSeq;
        if (!this.waitingInvocations.has(seq)) {
            this._prevSeq = seq % ~~(Number.MAX_SAFE_INTEGER / 2);
            return seq;
        }
        return this.generateNewSeq();
    }

    waitingInvocations = new Map<number, PromiseWithResolvers<any>>();
    invocationTimeouts = new Map<number, ReturnType<typeof setTimeout>>();

    _sendRPC(type: string, args: any[], timeout = DEFAULT_RPC_TIMEOUT) {
        if (!this.__send) {
            throw new Error("Not connected to any room");
        }
        const seq = this.generateNewSeq();
        const p = promiseWithResolver<any>();
        this.waitingInvocations.set(seq, p);
        const request: Request = {
            type: type,
            direction: DIRECTION_REQUEST,
            seq: seq,
            args,
        };
        if (timeout && timeout > 0) {
            this.invocationTimeouts.set(
                seq,
                setTimeout(() => {
                    if (this.waitingInvocations.has(seq)) {
                        this.waitingInvocations.delete(seq);
                        p.reject(new Error(`Invocation Timed out: ${type} (${seq}) (Timeout: ${timeout}ms)`));
                    }
                    this.invocationTimeouts.delete(seq);
                }, timeout)
            );
        }
        void this.__send(request, this._connectedPeerId);
        return p.promise;
    }

    __onResponse(data: Response) {
        const seq = data.seq;
        const type = data.type;
        if (this.invocationTimeouts.has(seq)) {
            clearTimeout(this.invocationTimeouts.get(seq));
            this.invocationTimeouts.delete(seq);
        }
        const p = this.waitingInvocations.get(seq);
        if (!p) {
            Logger(
                `Invoking remote function [ERROR] : ${type} (${seq}) : No Handler left. Possibly timed out`,
                LOG_LEVEL_VERBOSE
            );
            return;
        }
        this.waitingInvocations.delete(seq);
        if (data.error) {
            p.reject(data.error);
            Logger(`Invoking remote function [ DONE] : ${type} (${seq}) : (Error)`, LOG_LEVEL_VERBOSE);
        } else {
            p.resolve(data.data);
            // Logger(`Invoking remote function [ DONE] : ${type} (${seq})`, LOG_LEVEL_VERBOSE);
        }
    }

    bindRemoteFunction<T extends any[], U>(type: string, timeout = DEFAULT_RPC_TIMEOUT) {
        return async (...args: T) => {
            if (!this.__send) {
                throw new Error("Not connected to any room");
            }
            return (await this._sendRPC(type, args, timeout)) as U;
        };
    }
    async invokeRemoteFunction<T extends any[], U>(type: string, args: T, timeout = DEFAULT_RPC_TIMEOUT) {
        if (!this.__send) {
            throw new Error("Not connected to any room");
        }
        return (await this._sendRPC(type, args, timeout)) as U;
    }
    bindRemoteObjectFunctions<T extends BindableObject<any>, U extends keyof T>(key: U, timeout = DEFAULT_RPC_TIMEOUT) {
        type F = T[U];
        type P = Parameters<T[U]>;
        type R = ReturnType<F>;
        return async (...args: P): Promise<Awaited<R>> => {
            if (!this.__send) {
                throw new Error("Not connected to any room");
            }
            return (await this._sendRPC(`${key.toString()}`, args, timeout)) as Awaited<R>;
        };
    }
    async invokeRemoteObjectFunction<T extends BindableObject<any>, U extends NonPrivateMethodKeys<T>>(
        key: U,
        args: Parameters<T[U]>,
        timeout = DEFAULT_RPC_TIMEOUT
    ) {
        if (!this.__send) {
            throw new Error("Not connected to any room");
        }
        return (await this._sendRPC(`${key.toString()}`, args, timeout)) as Awaited<ReturnType<T[U]>>;
    }

    close() {
        this._remoteDB = undefined!;
        this._server = undefined!;
    }
}
