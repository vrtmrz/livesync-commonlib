import { type ActionSender, type Room, selfId, joinRoom } from "trystero/nostr";
import { LOG_LEVEL_INFO, LOG_LEVEL_NOTICE, type P2PSyncSetting } from "../../common/types";
import { LOG_LEVEL_VERBOSE, Logger } from "../../common/logger";
import {
    DIRECTION_RESPONSE,
    type ReplicatorHostEnv,
    type FullFilledDeviceInfo,
    ResponsePreventedError,
    type Request,
    type Response,
    type Payload,
    DIRECTION_REQUEST,
    type Advertisement,
    type BindableObject,
} from "./types";
import { StoredMapLike } from "../../dataobject/StoredMap";
import { TrysteroReplicatorP2PClient } from "./TrysteroReplicatorP2PClient";
import { eventHub } from "../../hub/hub";
import { createHostingDB } from "./ProxiedDB";
import { mixedHash } from "octagonal-wheels/hash/purejs";
import { EVENT_PLATFORM_UNLOADED } from "../../PlatformAPIs/base/APIBase";
import { $msg } from "../../common/i18n";
import { shareRunningResult } from "octagonal-wheels/concurrency/lock_v2";
import { Refiner } from "octagonal-wheels/dataobject/Refiner.js";

export type PeerInfo = Advertisement & {
    isAccepted: boolean | undefined;
    isTemporaryAccepted: boolean | undefined;
};
export type AcceptanceDecision = {
    peerId: string;
    name: string;
    decision: boolean;
    isTemporary: boolean;
};
export type RevokeAcceptanceDecision = {
    peerId: string;
    name: string;
};
export type P2PServerInfo = {
    isConnected: boolean;
    knownAdvertisements: PeerInfo[];
    serverPeerId: string;
};
export const EVENT_SERVER_STATUS = "p2p-server-status";
export const EVENT_MAKE_DECISION = "make-decision-p2p-peer";
export const EVENT_REVOKE_DECISION = "revoke-decision-p2p-peer";
export const EVENT_ADVERTISEMENT_RECEIVED = "p2p-advertisement-received";
export const EVENT_DEVICE_LEAVED = "p2p-device-leaved";
export const EVENT_REQUEST_STATUS = "p2p-request-status";
export const EVENT_P2P_REQUEST_FORCE_OPEN = "p2p-request-force-open";
export const EVENT_P2P_CONNECTED = "p2p-connected";
export const EVENT_P2P_DISCONNECTED = "p2p-disconnected";
export const EVENT_P2P_REPLICATOR_STATUS = "p2p-replicator-status";
export const EVENT_P2P_REPLICATOR_PROGRESS = "p2p-replicator-progress";
declare global {
    interface LSEvents {
        [EVENT_SERVER_STATUS]: P2PServerInfo;
        [EVENT_MAKE_DECISION]: AcceptanceDecision;
        [EVENT_REVOKE_DECISION]: RevokeAcceptanceDecision;
        [EVENT_ADVERTISEMENT_RECEIVED]: Advertisement;
        [EVENT_DEVICE_LEAVED]: string;
        [EVENT_REQUEST_STATUS]: undefined;
        [EVENT_P2P_REQUEST_FORCE_OPEN]: undefined;
        [EVENT_P2P_CONNECTED]: undefined;
        [EVENT_P2P_DISCONNECTED]: undefined;
    }
}

export class TrysteroReplicatorP2PServer {
    _env: ReplicatorHostEnv;
    _room?: Room;
    _serverPeerId: string;
    ___send?: ActionSender<Payload>;
    assignedFunctions = new Map<string, (...args: any[]) => any>();
    clients: Map<string, TrysteroReplicatorP2PClient> = new Map();
    _bindingObjects: BindableObject<any>[] = [];

    get isDisposed() {
        return !this._room;
    }
    get isServing() {
        return this._room !== undefined;
    }

    async ensureLeaved() {
        if (this._room) {
            try {
                await this._room?.leave();
            } catch (ex) {
                Logger(
                    `Some error has been occurred while leaving the room, but possibly can be ignored`,
                    LOG_LEVEL_VERBOSE
                );
                Logger(ex, LOG_LEVEL_VERBOSE);
            }
            this._room = undefined;
            eventHub.emitEvent(EVENT_P2P_DISCONNECTED);
        }
    }
    async setRoom(room: Room) {
        await this._room?.leave();
        this._room = room;
    }

    async shutdown() {
        try {
            await this.close();
            await this.ensureLeaved();
        } catch (ex) {
            Logger(`Some error has been occurred while shutting down the server`, LOG_LEVEL_INFO);
            Logger(ex, LOG_LEVEL_VERBOSE);
        }
    }

    async dispatchConnectionStatus() {
        const adsTasks = [...this.knownAdvertisements].map(async (e) => {
            const isAccepted = await this.acceptedPeers.get(e.name);
            const isTemporaryAccepted = this.temporaryAcceptedPeers.get(e.peerId);
            return {
                ...e,
                isAccepted,
                isTemporaryAccepted,
            };
        });
        const ads = await Promise.all(adsTasks);
        eventHub.emitEvent(EVENT_SERVER_STATUS, {
            isConnected: this.isServing,
            knownAdvertisements: ads,
            serverPeerId: this.serverPeerId,
        });
    }

    constructor(env: ReplicatorHostEnv, _serverPeerId = selfId) {
        this._env = env;
        this._serverPeerId = _serverPeerId;
        eventHub.onEvent(EVENT_PLATFORM_UNLOADED, () => {
            void this.shutdown();
        });
        this.acceptedPeers = new StoredMapLike(this._env.simpleStore, "p2p-device-decisions");
    }
    async makeDecision(decision: AcceptanceDecision) {
        if (decision.decision) {
            if (decision.isTemporary) {
                this.temporaryAcceptedPeers.set(decision.peerId, true);
            } else {
                await this.acceptedPeers.set(decision.name, true);
            }
        } else {
            if (decision.isTemporary) {
                this.temporaryAcceptedPeers.set(decision.peerId, false);
            } else {
                await this.acceptedPeers.set(decision.name, false);
            }
        }
        await this.dispatchConnectionStatus();
    }
    async revokeDecision(decision: RevokeAcceptanceDecision) {
        this.temporaryAcceptedPeers.delete(decision.peerId);
        await this.acceptedPeers.delete(decision.name);
        await this.dispatchConnectionStatus();
    }

    get room() {
        return this._room;
    }
    get serverPeerId() {
        return this._serverPeerId;
    }

    get db() {
        return this._env.db;
    }
    get confirm() {
        return this._env.confirm;
    }
    get settings() {
        return this._env.settings;
    }

    get isEnabled() {
        return this.settings.P2P_Enabled;
    }

    get deviceInfo(): FullFilledDeviceInfo {
        return {
            currentPeerId: this._serverPeerId,
            name: this._env.deviceName,
            platform: this._env.platform,
            version: "0.0.0",
        };
    }

    _sendAdvertisement?: ActionSender<Advertisement>;
    sendAdvertisement(peerId?: string) {
        if (!this.isEnabled) return;
        const devInfo = this.deviceInfo;
        const data = {
            peerId: devInfo.currentPeerId,
            name: devInfo.name,
            platform: devInfo.platform,
        };
        if (this._sendAdvertisement) {
            Logger(`peerId: ${this.serverPeerId} Sending Advertisement to ${peerId ?? "All"}`, LOG_LEVEL_VERBOSE);
            void this._sendAdvertisement(data, peerId);
        }
    }

    _knownAdvertisements = new Map<string, Advertisement>();
    get knownAdvertisements() {
        return [...this._knownAdvertisements.values()];
    }

    onAdvertisement(data: Advertisement, peerId: string) {
        if (!this.isEnabled) return;
        Logger(`Advertisement from ${peerId}`, LOG_LEVEL_VERBOSE);
        if (peerId === this.serverPeerId) return;
        if (data.peerId === this.serverPeerId) return;
        if (data.name === this.deviceInfo.name) return;
        if (data.peerId !== peerId) return;
        this._knownAdvertisements.set(peerId, data);
        void this.dispatchConnectionStatus();
        void eventHub.emitEvent(EVENT_ADVERTISEMENT_RECEIVED, data);
    }

    acceptedPeers: StoredMapLike<boolean>;

    temporaryAcceptedPeers = new Map<string, boolean>();

    confirmUserToAccept(peerId: string) {
        return shareRunningResult(`confirmUserToAccept-${peerId}`, () => this._confirmUserToAccept(peerId));
    }
    _confirmUserToAccept(peerId: string) {
        const peerInfo = this._knownAdvertisements.get(peerId);
        if (!peerInfo) throw new Error("Unknown Peer");
        const peerName = peerInfo.name;
        const message = `Are you sure to establish connection to ${peerName} (${peerId})?
You can chose as follows:
- Accept: Accept all connections from this peer.
- Ignore: Reject all connections from this peer.
- Accept Temporarily: Accept the connection for this session only.
- Ignore Temporarily: Reject the connection for this session only.

>[!INFO] You can revoke your decision from the Peer-to-Peer Replicator Pane.`;

        const OPTION_ACCEPT = "Accept";
        const OPTION_IGNORE = "Ignore";
        const OPTION_ACCEPT_TEMPORARILY = "Accept Temporarily";
        const OPTION_IGNORE_TEMPORARILY = "Ignore Temporarily";
        const OPTIONS = [OPTION_ACCEPT, OPTION_IGNORE, OPTION_ACCEPT_TEMPORARILY, OPTION_IGNORE_TEMPORARILY];
        return this.confirm
            .askSelectStringDialogue(message, OPTIONS, {
                title: "P2P Connection Request",
                defaultAction: "Ignore Temporarily",
                timeout: 30,
            })
            .then((decision) => {
                if (decision === OPTION_ACCEPT_TEMPORARILY) {
                    this.temporaryAcceptedPeers.set(peerId, true);
                    void this.dispatchConnectionStatus();
                    return true;
                } else if (decision === OPTION_IGNORE_TEMPORARILY) {
                    this.temporaryAcceptedPeers.set(peerId, false);
                    void this.dispatchConnectionStatus();
                    return false;
                } else if (decision === OPTION_ACCEPT) {
                    this.temporaryAcceptedPeers.delete(peerId);
                    void this.acceptedPeers.set(peerName, true);
                    void this.dispatchConnectionStatus();
                    return true;
                } else if (decision === OPTION_IGNORE) {
                    this.temporaryAcceptedPeers.delete(peerId);
                    void this.acceptedPeers.set(peerName, false);
                    void this.dispatchConnectionStatus();
                    return false;
                } else {
                    throw new ResponsePreventedError("User Accepting failed");
                }
            });
    }
    _acceptablePeers = new Refiner({
        evaluation: (settings: P2PSyncSetting) => {
            return `${settings?.P2P_AutoAcceptingPeers ?? ""}`
                .split(",")
                .map((e) => e.trim())
                .filter((e) => !!e)
                .map((e) => (e.startsWith("~") ? new RegExp(e.substring(1), "i") : new RegExp(`^${e}$`, "i")));
        },
    });
    _shouldDenyPeers = new Refiner({
        evaluation: (settings: P2PSyncSetting) => {
            return `${settings?.P2P_AutoDenyingPeers ?? ""}`
                .split(",")
                .map((e) => e.trim())
                .filter((e) => !!e)
                .map((e) => (e.startsWith("~") ? new RegExp(e.substring(1), "i") : new RegExp(`^${e}$`, "i")));
        },
    });

    async isAcceptablePeer(peerId: string) {
        if (!this.isEnabled) return undefined;
        const peerInfo = this._knownAdvertisements.get(peerId);
        if (!peerInfo) return false;
        const peerName = peerInfo.name;
        if (this.temporaryAcceptedPeers.has(peerId)) return this.temporaryAcceptedPeers.get(peerId);
        const accepted = await this.acceptedPeers.get(peerName);
        if (accepted !== undefined && accepted !== null) return accepted;
        const isAcceptable = (await this._acceptablePeers.update(this.settings).value).some((e) => e.test(peerName));
        const isDeny = (await this._shouldDenyPeers.update(this.settings).value).some((e) => e.test(peerName));

        if (isAcceptable) {
            if (isDeny) return false;
            this.temporaryAcceptedPeers.set(peerId, true);
            void this.dispatchConnectionStatus();
            return true;
        }
        if (this.settings.P2P_IsHeadless) {
            return false;
        }
        return await this.confirmUserToAccept(peerId);
    }

    async __send(data: Payload, peerId: string) {
        if (!this.isEnabled) return;
        if (!(await this.isAcceptablePeer(peerId))) {
            Logger(`Invalid Message to ${peerId}`, LOG_LEVEL_VERBOSE);
            Logger(data, LOG_LEVEL_VERBOSE);
            return;
        }
        if (this.___send) {
            return await this.___send(data, peerId);
        } else {
            Logger(`Cannot send response, no send function`);
        }
    }

    async processArrivedRPC(data: Payload, peerId: string) {
        if (!this.isEnabled) return;
        if (!data.type.startsWith("!")) {
            const isAcceptable = await this.isAcceptablePeer(peerId);
            if (!isAcceptable) {
                throw new Error(`Not acceptable peer ${peerId}`);
            }
            // Logger(`Peer accepted: ${peerId}`, LOG_LEVEL_VERBOSE);
        } else {
            // Logger(`No acceptable check for ${peerId}`, LOG_LEVEL_VERBOSE);
        }
        if (data.direction === DIRECTION_RESPONSE) {
            this.__onResponse(data, peerId);
        } else if (data.direction === DIRECTION_REQUEST) {
            await this.__onRequest(data, peerId);
        } else {
            throw new Error(`Invalid Message from ${peerId}`);
        }
    }

    activePeer = new Map<string, RTCPeerConnection>();
    onAfterJoinRoom() {
        Logger(`Initializing...`, LOG_LEVEL_VERBOSE);
        const room = this.room;
        if (!room) throw new Error("This server has been already disconnected");
        const [send, arrived] = room.makeAction<Payload>("rpc");
        this.___send = send;
        arrived((data, peerId) => {
            this.processArrivedRPC(data, peerId).catch((e) => {
                Logger(e.message, LOG_LEVEL_INFO);
                Logger(e, LOG_LEVEL_VERBOSE);
            });
        });
        const [adSend, adArrived] = room.makeAction<Advertisement>("ad");

        this._sendAdvertisement = adSend;
        adArrived((data, peerId) => {
            void this.onAdvertisement(data, peerId);
        });
        room.onPeerJoin((peerId) => {
            const peers = room.getPeers();
            const peer = peers[peerId];
            this.activePeer.set(peerId, peer);
            this.sendAdvertisement(peerId);
        });
        room.onPeerLeave((peerId) => {
            this._knownAdvertisements.delete(peerId);
            const peerConn = this.activePeer.get(peerId);
            if (peerConn) {
                peerConn.close();
                this.activePeer.delete(peerId);
            }
            void eventHub.emitEvent(EVENT_DEVICE_LEAVED, peerId);
            void this.dispatchConnectionStatus();
        });

        eventHub.emitEvent(EVENT_P2P_CONNECTED);
        void this.dispatchConnectionStatus();
    }

    async startService(bindings: BindableObject<any>[] = []) {
        if (!this.isEnabled) {
            Logger($msg("P2P.NotEnabled"), LOG_LEVEL_NOTICE);
            return;
        }
        const servingDB = createHostingDB(this._env);
        this._bindingObjects = [...bindings, servingDB];
        this._bindingObjects.forEach((b) => {
            this.serveObject(b);
        });
        await this.sendAdvertisement();
    }

    async start(bindings: BindableObject<any>[] = []) {
        const passphraseNumbers = mixedHash(this.settings.P2P_passphrase, 0);
        const passphrase = passphraseNumbers[0].toString(36) + passphraseNumbers[1].toString(36);
        await this.shutdown();
        if (!this.settings.P2P_Enabled) {
            Logger($msg("P2P.NotEnabled"), LOG_LEVEL_NOTICE);
            return;
        }
        const relays = this.settings.P2P_relays.split(",").filter((e) => e.trim().length > 0);
        const room = joinRoom(
            {
                relayUrls: relays,
                appId: this.settings.P2P_AppID,
                password: passphrase,
            },
            this.settings.P2P_roomID,
            //@ts-ignore
            (error: any) => {
                Logger(`Some error has been occurred while connecting the signalling server.`, LOG_LEVEL_INFO);
                Logger(`Error: ${JSON.stringify(error)}`, LOG_LEVEL_INFO);

                void this.ensureLeaved();
            }
        );
        await this.setRoom(room);
        this.onAfterJoinRoom();
        void this.dispatchConnectionStatus();
        await this.startService(bindings);
    }

    serveFunction<T extends any[], U>(type: string, func: (...args: T) => U | Promise<U>) {
        // Logger(`Serving function: ${type}`, LOG_LEVEL_VERBOSE);
        this.assignedFunctions.set(type, func);
    }
    serveObject<T>(obj: BindableObject<T>) {
        const keys = Object.keys(obj) as (keyof BindableObject<T>)[];
        keys.forEach((key) => {
            if (key.toString().startsWith("_")) return;
            const func = (obj[key] as (...args: any[]) => any).bind(obj);
            // Logger(`Serving function: ${key.toString()}`, LOG_LEVEL_VERBOSE);
            this.assignedFunctions.set(key.toString(), func);
        });
    }

    __onResponse(data: Response, peerId: string) {
        const peer = this.clients.get(peerId);
        if (!peer) {
            Logger(`Response from unknown peer ${peerId}`, LOG_LEVEL_VERBOSE);
            return;
        }
        peer.__onResponse(data);
    }

    async __onRequest(data: Request, peerId: string) {
        try {
            const func = this.assignedFunctions.get(data.type);
            if (typeof func !== "function")
                throw new Error(`Cannot serve function ${data.type}, no function provided or I am only a client`);
            const r = await Promise.resolve(func.apply(this, data.args));
            await this.__send({ type: data.type, seq: data.seq, direction: DIRECTION_RESPONSE, data: r }, peerId);
        } catch (e) {
            if (e instanceof ResponsePreventedError) {
                Logger(`Serving function: [FAILED] ${data.type}: Response prevented.`, LOG_LEVEL_VERBOSE);
                return;
            }
            Logger(`Serving function: [FAILED] ${data.type} sending back the failure information`, LOG_LEVEL_VERBOSE);
            Logger(e instanceof Error ? e.message : e, LOG_LEVEL_VERBOSE);

            await this.__send(
                { type: data.type, seq: data.seq, direction: DIRECTION_RESPONSE, data: undefined, error: e },
                peerId
            );
        }
    }
    async close() {
        this.assignedFunctions.clear();
        const peers = this.room?.getPeers() ?? {};
        this.clients.forEach((client) => client.close());
        this.clients.clear();
        for (const [, peer] of Object.entries(peers)) {
            peer.close();
        }
        await this.ensureLeaved();
        this._knownAdvertisements.clear();
        await this.dispatchConnectionStatus();
    }

    getConnection(peerId: string) {
        if (this.clients.has(peerId)) {
            return this.clients.get(peerId)!;
        }
        if (!this._knownAdvertisements.has(peerId)) {
            throw new Error(`Unknown Peer ${peerId}`);
        }
        const client = new TrysteroReplicatorP2PClient(this, peerId);
        this.clients.set(peerId, client);
        return client;
    }
}
