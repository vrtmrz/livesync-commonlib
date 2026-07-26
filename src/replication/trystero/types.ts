import type { JsonLike } from "@lib/rpc";
import type { P2PSyncSetting, EntryDoc } from "@lib/common/types";
import type { SimpleStore } from "@lib/common/utils";
import type { Confirm } from "@lib/interfaces/Confirm";
import type { AsyncActivityRunner } from "@lib/interfaces/AsyncActivityRunner";
import type { LiveSyncEventHub } from "@lib/hub/hub";
import type { MessageTranslator } from "@lib/services/base/MessageTranslator";

export const DIRECTION_REQUEST = "request";
export type DIRECTION_REQUEST = typeof DIRECTION_REQUEST;
export const DIRECTION_RESPONSE = "response";
export type DIRECTION_RESPONSE = typeof DIRECTION_RESPONSE;
export const DEFAULT_RPC_TIMEOUT = 30000;
export const BULK_GET_RPC_TIMEOUT = 40000;

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- This is a generic type for objects that can have their methods served over RPC, so we can't be more specific about the types here.
export type BindableFunction = (...args: any[]) => any;
export type NonPrivateMethodKeys<T> = {
    [K in keyof T]: K extends `_${string}`
        ? never
        : K extends `constructor`
          ? never
          : T[K] extends BindableFunction
            ? K
            : never;
}[keyof T];

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- This is a generic type for objects that can have their methods served over RPC, so we can't be more specific about the types here.
export type BindableObject<T = any> = {
    [k in NonPrivateMethodKeys<T>]: T[k] extends BindableFunction ? T[k] : never;
};

export type ConnectionInfo = {
    relayURIs: string[];
    roomId: string;
    password: string;
    appId: string;
};

export class ResponsePreventedError extends Error {
    constructor(message: string) {
        super(`Response prevented: ${message}`);
    }
}

export type Request<T = JsonLike[]> = {
    type: string;
    direction: DIRECTION_REQUEST;
    seq: number;
    args: T;
};
export type Response<T = JsonLike> = {
    type: string;
    direction: DIRECTION_RESPONSE;
    seq: number;
    data?: T;
    error?: JsonLike;
};

export type DeviceInfo = {
    currentPeerId: string;
    name?: string;
    version?: string;
    platform?: string;
    decision?: DeviceDecisions;
};
export type DeviceInfoForRequest = {
    currentPeerId: string;
    name: string;
};
export type FullFilledDeviceInfo = {
    currentPeerId: string;
    name: string;
    version: string;
    platform: string;
    decision?: DeviceDecisions;
};

export enum DeviceDecisions {
    ACCEPT = "accepted",
    REJECT = "rejected",
    IGNORE = "ignore",
}

export const ID_P2PKnownDevices = "_local/P2PKnownDevices";
export type KnownDevices = {
    _id: typeof ID_P2PKnownDevices;
    devices: {
        [deviceName: string]: DeviceDecisions;
    };
};

export type Payload = Request | Response;

export interface ReplicatorHost {
    deviceName: string;
    platform: string;
    confirm: Confirm;
}
export interface ReplicatorHostEnv extends ReplicatorHost {
    /** Event channel owned by the containing Commonlib service composition. */
    events: LiveSyncEventHub;
    /** Message translation owned by the containing Commonlib service composition. */
    translate: MessageTranslator;
    settings: P2PSyncSetting;
    db: PouchDB.Database<EntryDoc>;
    simpleStore: SimpleStore<unknown>;
    runFiniteReplicationActivity?: AsyncActivityRunner["run"];
    /** Lightweight, repeatable host policy checked before ordinary P2P replication starts. */
    canStartOrdinaryReplication?(showMessage?: boolean): Promise<boolean>;

    processReplicatedDocs(docs: Array<PouchDB.Core.ExistingDocument<EntryDoc>>): void | Promise<void>;
}

export type Advertisement = {
    peerId: string;
    name: string;
    platform: string;
};

export const KEY_DEVICE_DECISIONS = "p2p-device-decisions";
