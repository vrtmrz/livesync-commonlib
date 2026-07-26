import type PouchDB from "pouchdb-core";
import { joinRoom, selfId, type Room } from "@trystero-p2p/nostr";
import { RpcRoom } from "@lib/rpc/RpcRoom";
import { exposeDB } from "@lib/rpc/pouchdb/RpcPouchDBServer";
import { RpcPouchDBProxy } from "@lib/rpc/pouchdb/RpcPouchDBProxy";
import type { RpcRoomOptions, RpcWireMessage, TransportAdapter } from "@lib/rpc/types";
//TODO: following imports should be moved to a separated module, to make this module as a library.
import type { P2PConnectionInfo } from "@lib/common/models/setting.type";
import { ConnectionStringParser } from "@lib/common/ConnectionString";
import { compatGlobal } from "@lib/common/coreEnvFunctions";
import { generateJoinRoomOptions } from "./trysteroUtils";
import { subscribeTrysteroPeerEvents } from "./trysteroRoomEvents";

/** Action name used on the Trystero room for the RPC channel. */
const RPC_ACTION_NAME = "rpc2";
/** Action name used on the Trystero room for the advertisement channel. */
const AD_ACTION_NAME = "ad";

// ---------------------------------------------------------------------------
// Advertisement types
// ---------------------------------------------------------------------------

/**
 * Lightweight presence record broadcast by each peer when it joins the room.
 * The `peerId` field MUST match the Trystero sender ID to prevent spoofing.
 */
export type TrysteroAdvertisement = {
    /** The Trystero `selfId` of the sending peer. */
    peerId: string;
    /** Human-readable device / vault name. */
    name: string;
    /** Optional platform tag (e.g. `"desktop"`, `"mobile"`). */
    platform: string;
};

/** The handle returned by {@link attachAdvertisement}. */
export type AdvertisementHandle = {
    /**
     * All currently known peers, keyed by `peerId`.
     * Updated in real-time as advertisements arrive or peers leave.
     */
    readonly peers: ReadonlyMap<string, TrysteroAdvertisement>;
    /**
     * (Re-)broadcast your own advertisement.
     * Pass a `toPeerId` to send only to that peer; omit to broadcast to all.
     */
    sendAdvertisement(toPeerId?: string): Promise<void>;
    /** Stop listening for advertisements and clear the peer map. */
    stop(): void;
};

/**
 * Attach advertisement-based peer discovery to an already-joined Trystero room.
 *
 * - Sends your advertisement to every peer that joins after this call.
 * - Stores incoming advertisements in `handle.peers`.
 * - Removes entries when peers leave.
 *
 * @param room         An active Trystero room.
 * @param localPeerId  Your own Trystero `selfId`.
 * @param name         Human-readable name broadcast to other peers.
 * @param platform     Optional platform string (default `"unknown"`).
 */
export function attachAdvertisement(
    room: Room,
    localPeerId: string,
    name: string,
    platform = "unknown"
): AdvertisementHandle {
    const peerMap = new Map<string, TrysteroAdvertisement>();
    const localAd: TrysteroAdvertisement = { peerId: localPeerId, name, platform };

    const advertisementAction = room.makeAction<TrysteroAdvertisement>(AD_ACTION_NAME);

    const sendAdvertisement = (toPeerId?: string): Promise<void> =>
        advertisementAction.send(localAd, toPeerId ? { target: toPeerId } : undefined);

    const disposePeerEvents = subscribeTrysteroPeerEvents(room, {
        // When a new peer joins, introduce ourselves to them specifically.
        onJoin: (peerId) => {
            void sendAdvertisement(peerId);
        },
        // Remove stale entries when a peer disconnects.
        onLeave: (peerId) => {
            peerMap.delete(peerId);
        },
    });

    // Record incoming advertisements; reject spoofed ones where peerId ≠ sender.
    advertisementAction.onMessage = (data, { peerId }) => {
        if (data.peerId === localPeerId) return;
        if (data.peerId !== peerId) return;
        peerMap.set(peerId, data);
    };

    return {
        get peers(): ReadonlyMap<string, TrysteroAdvertisement> {
            return peerMap;
        },
        sendAdvertisement,
        stop() {
            disposePeerEvents();
            advertisementAction.onMessage = null;
            peerMap.clear();
        },
    };
}

// ---------------------------------------------------------------------------
// RpcRoom creation options passable from the caller
// ---------------------------------------------------------------------------

/**
 * Options forwarded to the `RpcRoom` constructor when creating a room through
 * the high-level helpers (`serveTrysteroDB`, `connectTrysteroDBClient`, or by
 * calling `joinTrysteroRoom` and then constructing `RpcRoom` manually).
 *
 * Trystero internally chunks at ~16 348 bytes (16 KiB minus a 36-byte header).
 * Setting `maxWirePayloadBytes` above that threshold causes double-chunking.
 * The Trystero-appropriate default is therefore **15 360 bytes** (15 KiB),
 * which leaves ~1 KiB of headroom for the JSON wrapper overhead.
 *
 * Trystero uses WebRTC SCTP data channels which guarantee delivery and order,
 * so missing-chunk retransmission virtually never triggers.  `chunkMissingRetryMs`
 * can safely be lowered from the generic default of 350 ms to **150 ms**.
 */
export type TrysteroRoomOptions = Pick<RpcRoomOptions, "canAcceptRequest" | "onProtocolWarning"> & {
    maxWirePayloadBytes?: number;
    chunkMissingRetryMs?: number;
};

/** Trystero-appropriate defaults for `RpcRoom`. */
export const TRYSTERO_RPC_DEFAULTS = {
    /** Stay below Trystero's internal ~16 348-byte chunk boundary. */
    maxWirePayloadBytes: 15 * 1024,
    /** SCTP guarantees delivery; retransmission is a last-resort safety net. */
    chunkMissingRetryMs: 150,
} as const;

// ---------------------------------------------------------------------------
// Low-level: wrap an already-joined Trystero Room
// ---------------------------------------------------------------------------

/**
 * Wrap an already-joined Trystero `Room` as a `TransportAdapter` for `RpcRoom`.
 *
 * A dedicated Trystero action channel named `"rpc2"` is created on the room.
 * Note: Trystero does not expose per-handler unsubscription for `onPeerJoin`
 * / `onPeerLeave`, so the returned cleanup stubs are no-ops.  Close the
 * Trystero room via `leave()` when done.
 *
 * @param room  An active Trystero `Room` returned by `joinRoom()`.
 * @returns     A `TransportAdapter` that can be passed to `new RpcRoom(...)`.
 */
export function wrapTrysteroRoom(room: Room): TransportAdapter {
    const rpcAction = room.makeAction<RpcWireMessage>(RPC_ACTION_NAME);

    return {
        send(message: RpcWireMessage, peerId: string) {
            return rpcAction.send(message, { target: peerId });
        },

        onMessage(handler) {
            rpcAction.onMessage = (data, { peerId }) => handler(data, peerId);
            return () => {
                rpcAction.onMessage = null;
            };
        },

        onPeerJoin(handler) {
            return subscribeTrysteroPeerEvents(room, { onJoin: handler });
        },

        onPeerLeave(handler) {
            return subscribeTrysteroPeerEvents(room, { onLeave: handler });
        },
    };
}

// ---------------------------------------------------------------------------
// Mid-level: join a room from settings / URL
// ---------------------------------------------------------------------------

/** The result of joining a Trystero room. */
export type TrysteroRoomHandle = {
    /** `TransportAdapter` ready to pass to `new RpcRoom(...)`. */
    transport: TransportAdapter;
    /** This peer's own ID (Trystero `selfId`). */
    peerId: string;
    /** Leave the Trystero room and release resources. */
    leave: () => Promise<void>;
    /**
     * Attach advertisement-based peer discovery to this room.
     * Call once after joining; returns a handle to read and re-broadcast.
     */
    advertise: (name: string, platform?: string) => AdvertisementHandle;
    /**
     * Returns the current WebRTC peer connections keyed by peer ID.
     * Equivalent to the Trystero `room.getPeers()` call.
     * Treat these as diagnostic handles. Their lifecycle belongs to Trystero;
     * call {@link TrysteroRoomHandle.leave} instead of closing them directly.
     */
    getPeers: () => Record<string, RTCPeerConnection>;
    /**
     * The underlying Trystero `Room` instance.
     * Use when you need raw access to Trystero APIs such as `makeAction`,
     * `onPeerJoin`, or `onPeerLeave` beyond what the helpers expose.
     */
    room: Room;
};

/**
 * Join a Trystero room from a {@link P2PConnectionInfo} and return a
 * `TransportAdapter` together with this peer's own ID.
 *
 * The raw passphrase is hashed with `mixedHash` before being passed to
 * Trystero, matching the convention used by `TrysteroReplicatorP2PServer`.
 */
export function joinTrysteroRoom(settings: P2PConnectionInfo): TrysteroRoomHandle {
    const options = generateJoinRoomOptions(settings);

    const room = joinRoom(options, settings.P2P_roomID, {
        handshakeTimeoutMs: 30000,
        onJoinError(error) {
            console.error("Failed to join Trystero room:", error);
        },
    });
    const currentPeerId = selfId;

    return {
        transport: wrapTrysteroRoom(room),
        peerId: currentPeerId,
        leave: () => room.leave(),
        advertise: (name: string, platform = "unknown") => attachAdvertisement(room, currentPeerId, name, platform),
        getPeers: () => room.getPeers(),
        room,
    };
}

/**
 * Join a Trystero room from a `sls+p2p://` connection string and return a
 * `TransportAdapter` together with this peer's own ID.
 *
 * The URL must be parseable by {@link ConnectionStringParser.parse} as type
 * `"p2p"`, i.e. it must start with `sls+p2p://`.
 *
 * @example
 * ```ts
 * const handle = joinTrysteroRoomFromUrl(
 *     "sls+p2p://my-room?relays=wss://relay.example.com&appId=my-app"
 * );
 * const rpcRoom = new RpcRoom({ transport: handle.transport });
 * ```
 */
export function joinTrysteroRoomFromUrl(url: string): TrysteroRoomHandle {
    const result = ConnectionStringParser.parse(url);
    if (result.type !== "p2p") {
        throw new Error(`Expected a sls+p2p:// connection string, but got type: "${result.type}"`);
    }
    return joinTrysteroRoom(result.settings);
}

// ---------------------------------------------------------------------------
// High-level: server / client helpers
// ---------------------------------------------------------------------------

/** The result of starting a DB server over Trystero. */
export type TrysteroDBServerHandle = {
    /** This peer's own ID.  Share it with clients so they can call `session()`. */
    peerId: string;
    /** The `RpcRoom` that hosts the DB methods. */
    rpcRoom: RpcRoom;
    /** Stop serving and leave the room. */
    close: () => Promise<void>;
    /**
     * Attach advertisement-based peer discovery so that clients can find this
     * server without needing the peerId passed out-of-band.
     */
    advertise: (name: string, platform?: string) => AdvertisementHandle;
};

/**
 * **Server side.**  Join a Trystero room and expose `db` as a set of RPC
 * methods.  The caller's `peerId` is returned so that it can be shared with
 * clients (e.g. via a separate signalling channel or advertisement).
 *
 * @param settings  P2P connection settings (from `P2PConnectionInfo` or parsed
 *                  from a `sls+p2p://` URL via {@link ConnectionStringParser}).
 * @param db        The PouchDB database to expose.
 * @param ns        Method namespace (default `"pdb"`).
 *
 * @example
 * ```ts
 * const server = serveTrysteroDB(settings, db);
 * console.log("server peer ID:", server.peerId);
 * // Share server.peerId with the client out-of-band.
 * ```
 */
export function serveTrysteroDB(
    settings: P2PConnectionInfo,
    db: PouchDB.Database<object>,
    ns = "pdb",
    options?: TrysteroRoomOptions
): TrysteroDBServerHandle {
    const roomHandle = joinTrysteroRoom(settings);
    const rpcRoom = new RpcRoom({ ...TRYSTERO_RPC_DEFAULTS, transport: roomHandle.transport, ...options });
    exposeDB(rpcRoom, db, ns);

    return {
        peerId: roomHandle.peerId,
        rpcRoom,
        close: async () => {
            rpcRoom.close();
            await roomHandle.leave();
        },
        advertise: roomHandle.advertise,
    };
}

/** The result of connecting to a DB server over Trystero. */
export type TrysteroDBClientHandle = {
    /** Proxy object usable with `PouchDB.replicate()` or `replicateShim()`. */
    proxy: RpcPouchDBProxy;
    /** The `RpcRoom` used to communicate with the server. */
    rpcRoom: RpcRoom;
    /** Disconnect and leave the room. */
    close: () => Promise<void>;
    /**
     * Attach advertisement-based peer discovery so this client can locate the
     * server peer without needing its peerId passed statically.
     */
    advertise: (name: string, platform?: string) => AdvertisementHandle;
};

/**
 * **Client side.**  Join a Trystero room and create an {@link RpcPouchDBProxy}
 * pointing at `serverPeerId`.  The proxy can be passed directly to
 * `PouchDB.replicate()` or `replicateShim()`.
 *
 * @param settings      P2P connection settings.
 * @param serverPeerId  The `peerId` of the server peer (returned by
 *                      {@link serveTrysteroDB}).
 * @param dbName        Logical name for the remote database.
 * @param ns            Method namespace, must match the server's `ns`
 *                      (default `"pdb"`).
 *
 * @example
 * ```ts
 * const client = connectTrysteroDBClient(settings, serverPeerId, "my-db");
 * await PouchDB.replicate(client.proxy, localDb, { live: false });
 * await client.close();
 * ```
 */
export function connectTrysteroDBClient(
    settings: P2PConnectionInfo,
    serverPeerId: string,
    dbName: string,
    ns = "pdb",
    options?: TrysteroRoomOptions
): TrysteroDBClientHandle {
    const roomHandle = joinTrysteroRoom(settings);
    const rpcRoom = new RpcRoom({ ...TRYSTERO_RPC_DEFAULTS, transport: roomHandle.transport, ...options });
    const proxy = new RpcPouchDBProxy(rpcRoom.session(serverPeerId), dbName, ns);

    return {
        proxy,
        rpcRoom,
        close: async () => {
            rpcRoom.close();
            await roomHandle.leave();
        },
        advertise: roomHandle.advertise,
    };
}

// ---------------------------------------------------------------------------
// Convenience: collect peer advertisements for a fixed duration
// ---------------------------------------------------------------------------

/**
 * Join a Trystero room, advertise as `name`, wait `timeoutMs`, collect all
 * received peer advertisements, then leave the room and return the results.
 *
 * Useful for CLI-style peer discovery where you need a one-shot list of
 * present peers before deciding how to connect.
 *
 * @param settings   P2P connection settings.
 * @param name       Your local device / vault name advertised to others.
 * @param timeoutMs  How long to listen before returning (milliseconds).
 * @param platform   Optional platform tag (default `"unknown"`).
 *
 * @example
 * ```ts
 * const peers = await collectTrysteroAdvertisements(settings, "my-vault", 5000);
 * console.log(peers.map(p => `${p.name} (${p.peerId})`));
 * ```
 */
export async function collectTrysteroAdvertisements(
    settings: P2PConnectionInfo,
    name: string,
    timeoutMs: number,
    platform = "unknown"
): Promise<TrysteroAdvertisement[]> {
    const roomHandle = joinTrysteroRoom(settings);
    const adHandle = roomHandle.advertise(name, platform);
    // Broadcast our presence immediately so others know we are here too.
    await adHandle.sendAdvertisement();
    await new Promise<void>((resolve) => compatGlobal.setTimeout(resolve, timeoutMs));
    const peers = [...adHandle.peers.values()];
    adHandle.stop();
    await roomHandle.leave();
    return peers;
}
