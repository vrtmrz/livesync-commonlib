import { reportP2PDiagnostic } from "@lib/p2p/p2pDiagnostics";
import { parsePeerPatterns } from "./peerPatterns";
import { type Room, selfId, joinRoom } from "@trystero-p2p/nostr";
import { LOG_LEVEL_INFO, LOG_LEVEL_NOTICE, type P2PSyncSetting } from "@lib/common/types";
import { LOG_LEVEL_VERBOSE, Logger } from "@lib/common/logger";
import {
    DIRECTION_RESPONSE,
    resolveCurrentP2PSettings,
    type ReplicatorHostEnv,
    type FullFilledDeviceInfo,
    ResponsePreventedError,
    type Request,
    type Response,
    type Payload,
    DIRECTION_REQUEST,
    type Advertisement,
    type BindableObject,
    type BindableFunction,
} from "./types";
import { StoredMapLike } from "@lib/dataobject/StoredMap";
import { TrysteroReplicatorP2PClient } from "./TrysteroReplicatorP2PClient";
import { createHostingDB } from "./ProxiedDB";
import { EVENT_PLATFORM_UNLOADED } from "@lib/events/coreEvents";
import { Computed } from "octagonal-wheels/dataobject/Computed";
import { RpcRoom, type JsonLike, type RpcRequestContext, type RpcWireMessage, type TransportAdapter } from "@lib/rpc";
import { resolveTrysteroRpcOptions } from "@lib/rpc/transports/TrysteroTransport";
import { subscribeTrysteroPeerEvents } from "@lib/rpc/transports/trysteroRoomEvents";
import { toRpcMethodName } from "./rpcCompat";
import { generateJoinRoomOptions } from "@lib/rpc/transports/trysteroUtils";
import { subscribeConnectionStatus, subscribeFailureDiagnosis } from "@lib/rpc/transports/DiagRTCPeerConnections";
import { type DiagRTCStats } from "@lib/rpc/transports/DiagRTCPeerConnections.types";
import type { SimpleStore } from "@lib/common/utils";
import { asRpcErrorShape } from "@lib/rpc/errors";
import type { P2PPeerAcceptance } from "./replicationTypes";
export type { P2PPeerAcceptance } from "./replicationTypes";
import {
    createPeerAdmission,
    type AcceptanceDecision,
    type RevokeAcceptanceDecision,
} from "./TrysteroReplicatorP2PServer/peerAdmission";
export type { AcceptanceDecision, RevokeAcceptanceDecision } from "./TrysteroReplicatorP2PServer/peerAdmission";

/** Room creation is borrowed; the Server still owns each joined room and its RPC bindings. */
export interface P2PServerOptions {
    createRoom?: typeof joinRoom;
}

export type PeerInfo = Advertisement & {
    isAccepted: boolean | undefined;
    isTemporaryAccepted: boolean | undefined;
};
export type P2PServerInfo = {
    isConnected: boolean;
    knownAdvertisements: PeerInfo[];
    serverPeerId: string;
    roomId: string;
    diag: DiagRTCStats;
};

/** Peer callbacks bound to one room session rather than the global event hub. */
export interface P2PSessionPeerHandlers {
    onAdvertisement(peer: Advertisement): void | Promise<void>;
    onPeerLeft(peerId: string): void;
}
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
    _activeRoomId: string = "";
    ___send?: (data: Payload, peerId?: string) => Promise<void>;
    assignedFunctions = new Map<string, BindableFunction>();
    clients: Map<string, TrysteroReplicatorP2PClient<this>> = new Map();
    _bindingObjects: BindableObject[] = [];
    _rpcRoom?: RpcRoom;

    protected _peerStatusEventCleanup: (() => void) | undefined = undefined;
    protected _peerFailureAnalysisCleanup: (() => void) | undefined = undefined;
    private _platformUnloadCleanup: (() => void) | undefined;
    private _sessionPeerHandlers: P2PSessionPeerHandlers | undefined;
    private _hostLifetimeEnded = false;
    private readonly createRoom: typeof joinRoom;
    private readonly peerAdmission: ReturnType<typeof createPeerAdmission> = createPeerAdmission({
        isEnabled: () => this.isEnabled,
        advertisement: (peerId) => this._knownAdvertisements.get(peerId),
        currentSettings: () => this.currentSettings,
        acceptedPeers: () => this.acceptedPeers,
        temporaryAcceptedPeers: () => this.temporaryAcceptedPeers,
        confirm: () => this.confirm,
        dispatchConnectionStatus: () => this.dispatchConnectionStatus(),
        acceptablePatterns: () => this._acceptablePeers,
        deniedPatterns: () => this._shouldDenyPeers,
        promptPeerAcceptance: (peerId) => this._confirmUserToAccept(peerId),
        evaluatePeerAcceptance: (peerId) => this.evaluatePeerAcceptance(peerId),
        confirmUserToAccept: (peerId) => this.confirmUserToAccept(peerId),
    });

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
                this.logTransportError(ex);
            }
            this._room = undefined;
            this._env.events.emitEvent(EVENT_P2P_DISCONNECTED);
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
            this.logTransportError(ex);
        }
    }

    /** Release subscriptions whose lifetime is the host object rather than one transport join. */
    dispose(): void {
        this._hostLifetimeEnded = true;
        this._platformUnloadCleanup?.();
        this._platformUnloadCleanup = undefined;
        this._sessionPeerHandlers = undefined;
    }

    async dispatchConnectionStatus() {
        if (this._hostLifetimeEnded) return;
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
        if (this._hostLifetimeEnded) return;
        this._env.events.emitEvent(EVENT_SERVER_STATUS, {
            isConnected: this.isServing,
            knownAdvertisements: ads,
            serverPeerId: this.serverPeerId,
            roomId: this._activeRoomId,
            diag: this._diagStats,
        });
    }

    constructor(env: ReplicatorHostEnv, _serverPeerId = selfId, options: P2PServerOptions = {}) {
        this._env = env;
        this._serverPeerId = _serverPeerId;
        this.createRoom = options.createRoom ?? joinRoom;
        this._platformUnloadCleanup = this._env.events.onEvent(EVENT_PLATFORM_UNLOADED, () => {
            void this.shutdown();
        });
        // The existing namespace contains boolean peer decisions; the host store also serves other data.
        this.acceptedPeers = new StoredMapLike<boolean>(
            this._env.simpleStore as SimpleStore<boolean>,
            "p2p-device-decisions"
        );
    }

    /** Attach callbacks owned by the current room session and return their disposer. */
    setSessionPeerHandlers(handlers: P2PSessionPeerHandlers): () => void {
        this._sessionPeerHandlers = handlers;
        return () => {
            if (this._sessionPeerHandlers === handlers) {
                this._sessionPeerHandlers = undefined;
            }
        };
    }
    /** Persist or retain a session decision, then await the existing status notification. */
    async makeDecision(decision: AcceptanceDecision) {
        await this.peerAdmission.makeDecision(decision);
    }

    /** Revoke both decision scopes before awaiting the existing status notification. */
    async revokeDecision(decision: RevokeAcceptanceDecision) {
        await this.peerAdmission.revokeDecision(decision);
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

    /** Latest admission and enablement policy for this room. */
    get currentSettings() {
        return resolveCurrentP2PSettings(this._env);
    }

    get isEnabled() {
        return this.currentSettings.P2P_Enabled;
    }

    get deviceInfo(): FullFilledDeviceInfo {
        return {
            currentPeerId: this._serverPeerId,
            name: this._env.deviceName,
            platform: this._env.platform,
            version: "0.0.0",
        };
    }

    _sendAdvertisement?: (data: Advertisement, peerId?: string) => Promise<void>;
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
        if (this._hostLifetimeEnded) return;
        if (!this.isEnabled) return;
        Logger(`Advertisement from ${peerId}`, LOG_LEVEL_VERBOSE);
        if (peerId === this.serverPeerId) return;
        if (data.peerId === this.serverPeerId) return;
        if (data.peerId !== peerId) return;
        const isNewPeer = !this._knownAdvertisements.has(peerId);
        this._knownAdvertisements.set(peerId, data);
        if (isNewPeer)
            reportP2PDiagnostic(this._env.reportDiagnostic, { category: "peer", code: "peer-advertised", peerId });
        void this.dispatchConnectionStatus();
        void Promise.resolve()
            .then(() => this._sessionPeerHandlers?.onAdvertisement(data))
            .catch((error: unknown) => Logger(error, LOG_LEVEL_VERBOSE));
        void this._env.events.emitEvent(EVENT_ADVERTISEMENT_RECEIVED, data);
    }

    acceptedPeers: StoredMapLike<boolean>;

    temporaryAcceptedPeers = new Map<string, boolean>();

    /** Share a peer's in-flight prompt while preserving the overridable prompt entry point. */
    confirmUserToAccept(peerId: string) {
        return this.peerAdmission.confirmUserToAccept(peerId);
    }

    /** Apply one dialogue result without awaiting the original background writes or status work. */
    _confirmUserToAccept(peerId: string) {
        return this.peerAdmission.promptPeerAcceptance(peerId);
    }
    _acceptablePeers = new Computed({
        evaluation: (settings: P2PSyncSetting) => {
            return parsePeerPatterns(`${settings?.P2P_AutoAcceptingPeers ?? ""}`);
        },
    });
    _shouldDenyPeers = new Computed({
        evaluation: (settings: P2PSyncSetting) => {
            return parsePeerPatterns(`${settings?.P2P_AutoDenyingPeers ?? ""}`);
        },
    });

    /**
     * Evaluate peer admission without opening a dialogue or changing a stored
     * decision. Unattended automation uses this boundary before starting RPC.
     */
    async evaluatePeerAcceptance(peerId: string): Promise<P2PPeerAcceptance> {
        return await this.peerAdmission.evaluatePeerAcceptance(peerId);
    }

    /** Keep automatic-decision caching and interactive admission at their existing public boundary. */
    async isAcceptablePeer(peerId: string) {
        return await this.peerAdmission.isAcceptablePeer(peerId);
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
        if (this._hostLifetimeEnded) return;
        if (!this._room) {
            Logger(`Received peer join event from ${peerId}, but no active room. Ignoring.`, LOG_LEVEL_VERBOSE);
            //
            return;
        }
        Logger(`Peer joined: ${peerId}`, LOG_LEVEL_VERBOSE);
        this.sendAdvertisement(peerId);
    }
    private _onPeerLeave(peerId: string) {
        if (this._hostLifetimeEnded) return;
        Logger(`Peer left: ${peerId}`, LOG_LEVEL_VERBOSE);
        reportP2PDiagnostic(this._env.reportDiagnostic, { category: "peer", code: "peer-left", peerId });
        this._knownAdvertisements.delete(peerId);
        void Promise.resolve()
            .then(() => this._sessionPeerHandlers?.onPeerLeft(peerId))
            .catch((error: unknown) => Logger(error, LOG_LEVEL_VERBOSE));
        void this._env.events.emitEvent(EVENT_DEVICE_LEAVED, peerId);
        void this.dispatchConnectionStatus();
    }

    onAfterJoinRoom() {
        Logger(`Initializing...`, LOG_LEVEL_VERBOSE);
        const room = this.room;
        if (!room) throw new Error("This server has been already disconnected");
        const rpcAction = room.makeAction<RpcWireMessage>("rpc2");
        const transport: TransportAdapter = {
            send: (message, peerId) => {
                return rpcAction.send(message, { target: peerId });
            },
            onMessage: (handler) => {
                rpcAction.onMessage = (data, { peerId }) => {
                    handler(data, peerId);
                };
                return () => {
                    rpcAction.onMessage = null;
                };
            },
            onPeerJoin: (handler) => {
                return subscribeTrysteroPeerEvents(room, {
                    onJoin: (peerId) => {
                        this._onPeerJoin(peerId);
                        handler(peerId);
                    },
                });
            },
            onPeerLeave: (handler) => {
                return subscribeTrysteroPeerEvents(room, {
                    onLeave: (peerId) => {
                        this._onPeerLeave(peerId);
                        handler(peerId);
                    },
                });
            },
        };
        this._rpcRoom?.close();
        this._rpcRoom = new RpcRoom({
            ...resolveTrysteroRpcOptions(this.settings),
            transport,
            canAcceptRequest: async (peerId, method) => {
                if (method === toRpcMethodName("!reqAuth")) return true;
                return (await this.isAcceptablePeer(peerId)) === true;
            },
            onProtocolWarning: (message, peerId) => {
                Logger(`RPC Protocol warning${peerId ? ` from ${peerId}` : ""}: ${message}`, LOG_LEVEL_VERBOSE);
            },
        });
        const advertisementAction = room.makeAction<Advertisement>("ad");

        this._sendAdvertisement = (data, peerId) =>
            advertisementAction.send(data, peerId ? { target: peerId } : undefined);
        advertisementAction.onMessage = (data, { peerId }) => {
            void this.onAdvertisement(data, peerId);
        };

        this._env.events.emitEvent(EVENT_P2P_CONNECTED);
        void this.dispatchConnectionStatus();
    }

    async startService(bindings: BindableObject[] = [], beforeAdvertisement?: () => void) {
        if (!this.isEnabled) {
            Logger(this._env.translate("P2P.NotEnabled"), LOG_LEVEL_NOTICE);
            return;
        }
        const servingDB = createHostingDB(this._env);
        this._bindingObjects = [...bindings, servingDB];
        this._bindingObjects.forEach((b) => {
            this.serveObject(b);
        });
        // Allow a caller to replace an ordinary binding with a specialised
        // handler before peers are told that this room is ready.
        beforeAdvertisement?.();
        await Promise.resolve(this.sendAdvertisement());
    }

    async start(bindings: BindableObject[] = [], beforeAdvertisement?: () => void) {
        await this.shutdown();
        if (!this.settings.P2P_Enabled) {
            Logger(this._env.translate("P2P.NotEnabled"), LOG_LEVEL_NOTICE);
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
        const room = this.createRoom(options, roomId, {
            handshakeTimeoutMs: 30000,
            onJoinError: (error) => {
                if (!this._hostLifetimeEnded)
                    reportP2PDiagnostic(this._env.reportDiagnostic, {
                        category: "relay",
                        code: "room-join-error",
                        reason: "transport-error",
                    });
                Logger("Some peer Failed to join Trystero room");
                this.logTransportError(error);
            },
        });
        await this.setRoom(room);
        this._activeRoomId = roomId;
        this.onAfterJoinRoom();
        void this.dispatchConnectionStatus();
        await this.startService(bindings, beforeAdvertisement);
    }

    private logTransportError(error: unknown): void {
        if (this.settings.P2P_iceServers !== undefined) {
            Logger("Managed P2P transport error details were omitted.", LOG_LEVEL_VERBOSE);
            return;
        }
        Logger(error, LOG_LEVEL_VERBOSE);
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

    /** Serve one function whose finite work can observe caller cancellation. */
    serveCancellationAwareFunction<T extends JsonLike[], U>(
        type: string,
        func: (context: RpcRequestContext, peerId: string, ...args: T) => U | Promise<U>
    ) {
        this._rpcRoom?.registerCancellable<T, U>(
            toRpcMethodName(type),
            async (context, peerId, ...args) => await Promise.resolve(func(context, peerId, ...args))
        );
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
                {
                    type: data.type,
                    seq: data.seq,
                    direction: DIRECTION_RESPONSE,
                    data: undefined,
                    // This deprecated path predates RpcRoom, but it has the same
                    // JSON boundary and therefore must not send a native Error.
                    error: asRpcErrorShape(e),
                },
                peerId
            );
        }
    }
    async close() {
        this.assignedFunctions.clear();
        this.clients.forEach((client) => client.close());
        this.clients.clear();
        this._rpcRoom?.close();
        this._rpcRoom = undefined;
        // Trystero owns the underlying WebRTC peer and may share it across rooms.
        // Leaving the room detaches this room's RPC and advertisement bindings safely.
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
