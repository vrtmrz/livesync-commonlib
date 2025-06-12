import type { P2PSyncSetting, EntryDoc } from "../../common/types";
import type { SimpleStore } from "../../common/utils";
import type { Confirm } from "../../interfaces/Confirm";

export const DIRECTION_REQUEST = "request";
export type DIRECTION_REQUEST = typeof DIRECTION_REQUEST;
export const DIRECTION_RESPONSE = "response";
export type DIRECTION_RESPONSE = typeof DIRECTION_RESPONSE;
export const DEFAULT_RPC_TIMEOUT = 30000;

export type NonPrivateMethodKeys<T> = {
    [K in keyof T]: K extends `_${string}`
        ? never
        : K extends `constructor`
          ? never
          : T[K] extends (...args: any[]) => any
            ? K
            : never;
}[keyof T];

export type BindableObject<T> = {
    [k in NonPrivateMethodKeys<T>]: (...args: any[]) => any;
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

export type Request = {
    type: string;
    direction: DIRECTION_REQUEST;
    seq: number;
    args: any[];
};
export type Response = {
    type: string;
    direction: DIRECTION_RESPONSE;
    seq: number;
    data?: any;
    error?: any;
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
    settings: P2PSyncSetting;
    db: PouchDB.Database<EntryDoc>;
    simpleStore: SimpleStore<any>;

    processReplicatedDocs(docs: Array<PouchDB.Core.ExistingDocument<EntryDoc>>): void | Promise<void>;
}

export type Advertisement = {
    peerId: string;
    name: string;
    platform: string;
};

export const KEY_DEVICE_DECISIONS = "p2p-device-decisions";
