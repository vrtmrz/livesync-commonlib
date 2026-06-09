import { type ActionSender, type Room, selfId, joinRoom } from "@trystero-p2p/nostr";
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
import { EVENT_PLATFORM_UNLOADED } from "@lib/events/coreEvents";
import { $msg } from "../../common/i18n";
import { shareRunningResult } from "octagonal-wheels/concurrency/lock_v2";
import { Computed } from "octagonal-wheels/dataobject/Computed";
import { RpcRoom, type JsonLike, type RpcWireMessage, type TransportAdapter } from "@lib/rpc";
import { TRYSTERO_RPC_DEFAULTS } from "@lib/rpc/transports/TrysteroTransport";
import { toRpcMethodName } from "./rpcCompat";
import { generateJoinRoomOptions } from "@lib/rpc/transports/trysteroUtils";
import { subscribeConnectionStatus, subscribeFailureDiagnosis } from "@lib/rpc/transports/DiagRTCPeerConnections";
import { type DiagRTCStats } from "@lib/rpc/transports/DiagRTCPeerConnections.types";

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
    roomId: string;
    diag: DiagRTCStats;
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
// const ADVERTISEMENT_REBROADCAST_INTERVAL_MS = 25000;
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
    _activeRoomId: string = "";
    ___send?: ActionSender<Payload>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    assignedFunctions = new Map<string, (...args: any[]) => any>();
    clients: Map<string, TrysteroReplicatorP2PClient> = new Map();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    _bindingObjects: BindableObject<any>[] = [];
    _rpcRoom?: RpcRoom;

    protected _peerStatusEventCleanup: (() => void) | undefined = undefined;
    protected _peerFailureAnalysisCleanup: (() => void) | undefined = undefined;

    protected _peerConnectionEventCleanup() {
        if (this._peerStatusEventCleanup) {
            this._peerStatusEventCleanup();
            this._peerStatusEventCleanup = undefined;
        }
        if (this._peerFailureAnalysisCleanup) {
            this._peerFailureAnalysisCleanup();
            this._peerFailureAnalysisCleanup = undefined;
        }
    }

    _diagStats: DiagRTCStats = {
        totalNewConnections: 0,
        totalFailedConnections: 0,
        totalSuccessfulConnections: 0,
        totalClosedConnections: 0,
        details: {},
    };

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
            this._rpcRoom?.close();
            this._rpcRoom = undefined;
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
            roomId: this._activeRoomId,
            diag: this._diagStats,
        });
    }

    constructor(env: ReplicatorHostEnv, _serverPeerId = selfId) {
        this._env = env;
        this._serverPeerId = _serverPeerId;
        eventHub.onEvent(EVENT_PLATFORM_UNLOADED, () => {
            void this.shutdown();
        });
        // SimpleStore has no type support now.
        // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
        this.acceptedPeers = new StoredMapLike<boolean>(this._env.simpleStore, "p2p-device-decisions");
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
    // _advertisementTimer?: ReturnType<typeof setInterval>;
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

    // startAdvertisementBroadcast() {
    //     if (this._advertisementTimer) {
    //         clearInterval(this._advertisementTimer);
    //     }
    //     this._advertisementTimer = setInterval(() => {
    //         if (!this.isServing || !this.isEnabled) {
    //             return;
    //         }
    //         this.sendAdvertisement();
    //     }, ADVERTISEMENT_REBROADCAST_INTERVAL_MS);
    // }

    // stopAdvertisementBroadcast() {
    //     if (this._advertisementTimer) {
    //         clearInterval(this._advertisementTimer);
    //         this._advertisementTimer = undefined;
    //     }
    // }

    _knownAdvertisements = new Map<string, Advertisement>();
    get knownAdvertisements() {
        return [...this._knownAdvertisements.values()];
    }

    onAdvertisement(data: Advertisement, peerId: string) {
        if (!this.isEnabled) return;
        Logger(`Advertisement from ${peerId}`, LOG_LEVEL_VERBOSE);
        if (peerId === this.serverPeerId) return;
        if (data.peerId === this.serverPeerId) return;
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
    _acceptablePeers = new Computed({
        evaluation: (settings: P2PSyncSetting) => {
            return `${settings?.P2P_AutoAcceptingPeers ?? ""}`
                .split(",")
                .map((e) => e.trim())
                .filter((e) => !!e)
                .map((e) => (e.startsWith("~") ? new RegExp(e.substring(1), "i") : new RegExp(`^${e}$`, "i")));
        },
    });
    _shouldDenyPeers = new Computed({
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
        const isAcceptable = (await this._acceptablePeers.update(this.settings)).value.some((e) => e.test(peerName));
        const isDeny = (await this._shouldDenyPeers.update(this.settings)).value.some((e) => e.test(peerName));

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

    private _onPeerJoin(peerId: string) {
        if (!this._room) {
            Logger(`Received peer join event from ${peerId}, but no active room. Ignoring.`, LOG_LEVEL_VERBOSE);
            //
            return;
        }
        const peers = this._room.getPeers();
        const peer = peers[peerId];
        Logger(`Peer joined: ${peerId}`, LOG_LEVEL_VERBOSE);
        this.activePeer.set(peerId, peer);
        this.sendAdvertisement(peerId);
    }
    private _onPeerLeave(peerId: string) {
        Logger(`Peer left: ${peerId}`, LOG_LEVEL_VERBOSE);
        this._knownAdvertisements.delete(peerId);
        const peerConn = this.activePeer.get(peerId);
        if (peerConn) {
            peerConn.close();
            this.activePeer.delete(peerId);
        }
        void eventHub.emitEvent(EVENT_DEVICE_LEAVED, peerId);
        void this.dispatchConnectionStatus();
    }

    activePeer = new Map<string, RTCPeerConnection>();
    onAfterJoinRoom() {
        Logger(`Initializing...`, LOG_LEVEL_VERBOSE);
        const room = this.room;
        if (!room) throw new Error("This server has been already disconnected");
        const [sendRpc, arrivedRpc] = room.makeAction<RpcWireMessage>("rpc2");
        const transport: TransportAdapter = {
            send: (message, peerId) => {
                return sendRpc(message, peerId).then(() => undefined);
            },
            onMessage: (handler) => {
                arrivedRpc((data, peerId) => {
                    handler(data, peerId);
                });
                return () => undefined;
            },
            onPeerJoin: (handler) => {
                room.onPeerJoin((peerId) => {
                    this._onPeerJoin(peerId);
                    handler(peerId);
                });
                return () => undefined;
            },
            onPeerLeave: (handler) => {
                room.onPeerLeave((peerId) => {
                    this._onPeerLeave(peerId);
                    handler(peerId);
                });
                return () => undefined;
            },
        };
        this._rpcRoom?.close();
        this._rpcRoom = new RpcRoom({
            ...TRYSTERO_RPC_DEFAULTS,
            transport,
            canAcceptRequest: async (peerId, method) => {
                if (method === toRpcMethodName("!reqAuth")) return true;
                return (await this.isAcceptablePeer(peerId)) === true;
            },
            onProtocolWarning: (message, peerId) => {
                Logger(`RPC Protocol warning${peerId ? ` from ${peerId}` : ""}: ${message}`, LOG_LEVEL_VERBOSE);
            },
        });
        const [adSend, adArrived] = room.makeAction<Advertisement>("ad");

        this._sendAdvertisement = adSend;
        adArrived((data, peerId) => {
            void this.onAdvertisement(data, peerId);
        });

        eventHub.emitEvent(EVENT_P2P_CONNECTED);
        void this.dispatchConnectionStatus();
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
        await Promise.resolve(this.sendAdvertisement());
        // this.startAdvertisementBroadcast();
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async start(bindings: BindableObject<any>[] = []) {
        await this.shutdown();
        if (!this.settings.P2P_Enabled) {
            Logger($msg("P2P.NotEnabled"), LOG_LEVEL_NOTICE);
            return;
        }
        const options = generateJoinRoomOptions(this.settings);
        const roomId = this.settings.P2P_roomID;
        this._peerConnectionEventCleanup();
        this._peerStatusEventCleanup = subscribeConnectionStatus((status) => {
            // Subscribe for statics
            this._diagStats = status;
            void this.dispatchConnectionStatus();
        });
        this._peerFailureAnalysisCleanup = subscribeFailureDiagnosis((status) => {
            Logger(`[P2P] Connection failure detected: ${status.userMessage}`, LOG_LEVEL_NOTICE);
        });
        const room = joinRoom(options, roomId, {
            handshakeTimeoutMs: 30000,
            onJoinError: (error) => {
                Logger("Some peer Failed to join Trystero room");
                Logger(error, LOG_LEVEL_VERBOSE);
            },
        });
        await this.setRoom(room);
        this._activeRoomId = roomId;
        this.onAfterJoinRoom();
        void this.dispatchConnectionStatus();
        await this.startService(bindings);
    }

    /**
     * @deprecated Use serveFunction or serveObject instead. This is only for backward compatibility and may be removed in the future.
     * @param type
     * @param func
     */
    serveFunction<T extends JsonLike[], U>(type: string, func: (peerId: string, ...args: T) => U | Promise<U>) {
        // Logger(`Serving function: ${type}`, LOG_LEVEL_VERBOSE);
        this.assignedFunctions.set(type, func);
        this._rpcRoom?.register<T, U>(toRpcMethodName(type), async (peerId: string, ...args: T) => {
            return await Promise.resolve(func.apply(this, [peerId, ...args]));
        });
    }
    serveObject<T>(obj: BindableObject<T>) {
        const keys = Object.keys(obj) as (keyof BindableObject<T>)[];
        keys.forEach((key) => {
            if (key.toString().startsWith("_")) return;
            const func = (obj[key] as (...args: JsonLike[]) => JsonLike).bind(obj);
            // Logger(`Serving function: ${key.toString()}`, LOG_LEVEL_VERBOSE);
            this.assignedFunctions.set(key.toString(), func);
            this._rpcRoom?.register(toRpcMethodName(key.toString()), async (_peerId, ...args) => {
                return await Promise.resolve(func(...args));
            });
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
            const r = (await Promise.resolve(func.apply(this, data.args))) as JsonLike;
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
        // this.stopAdvertisementBroadcast();
        this.assignedFunctions.clear();
        const peers = this.room?.getPeers() ?? {};
        this.clients.forEach((client) => client.close());
        this.clients.clear();
        this._rpcRoom?.close();
        this._rpcRoom = undefined;
        for (const [, peer] of Object.entries(peers)) {
            peer.close();
        }
        await this.ensureLeaved();
        this._activeRoomId = "";
        this._knownAdvertisements.clear();
        this._peerConnectionEventCleanup();
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

    get rpcRoom() {
        return this._rpcRoom;
    }
}

export { TrysteroReplicatorP2PServer as P2PHost };
