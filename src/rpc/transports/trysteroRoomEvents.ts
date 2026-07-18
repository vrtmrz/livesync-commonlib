import type { Room } from "@trystero-p2p/nostr";

type PeerHandler = (peerId: string) => void;

type RoomEventSubscribers = {
    join: Set<PeerHandler>;
    leave: Set<PeerHandler>;
};

const subscribersByRoom = new WeakMap<Room, RoomEventSubscribers>();

function getSubscribers(room: Room): RoomEventSubscribers {
    const existing = subscribersByRoom.get(room);
    if (existing) return existing;

    const subscribers: RoomEventSubscribers = {
        join: new Set(),
        leave: new Set(),
    };
    subscribersByRoom.set(room, subscribers);
    room.onPeerJoin = (peerId) => {
        for (const handler of [...subscribers.join]) handler(peerId);
    };
    room.onPeerLeave = (peerId) => {
        for (const handler of [...subscribers.leave]) handler(peerId);
    };
    return subscribers;
}

/**
 * Subscribe multiple consumers to Trystero's single peer-event callback slots.
 *
 * Trystero 0.25 exposes `onPeerJoin` and `onPeerLeave` as nullable callback
 * properties. This adapter preserves the library's multi-subscriber transport
 * contract and returns a disposer for each subscription.
 */
export function subscribeTrysteroPeerEvents(
    room: Room,
    handlers: { onJoin?: PeerHandler; onLeave?: PeerHandler }
): () => void {
    const subscribers = getSubscribers(room);
    if (handlers.onJoin) subscribers.join.add(handlers.onJoin);
    if (handlers.onLeave) subscribers.leave.add(handlers.onLeave);

    return () => {
        if (handlers.onJoin) subscribers.join.delete(handlers.onJoin);
        if (handlers.onLeave) subscribers.leave.delete(handlers.onLeave);
        if (subscribers.join.size === 0 && subscribers.leave.size === 0) {
            room.onPeerJoin = null;
            room.onPeerLeave = null;
            subscribersByRoom.delete(room);
        }
    };
}
