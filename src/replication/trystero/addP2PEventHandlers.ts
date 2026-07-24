// P2P replicator helper functions
import { EVENT_DATABASE_REBUILT, EVENT_PLATFORM_UNLOADED, EVENT_SETTING_SAVED } from "@lib/events/coreEvents";
import type { LiveSyncEventHub } from "@lib/hub/hub";
import type { P2PSyncSetting } from "@lib/common/types";
import type { LiveSyncTrysteroReplicator } from "./LiveSyncTrysteroReplicator";
import { EVENT_ADVERTISEMENT_RECEIVED, EVENT_DEVICE_LEAVED, EVENT_REQUEST_STATUS } from "./TrysteroReplicatorP2PServer";
import type { Advertisement } from "./types";

/**
 * Minimal interface that a P2P replicator instance should satisfy for addP2PEventHandlers to work.
 */
export interface P2PReplicatorLike {
    onNewPeer(peer: Advertisement): Promise<void> | void;
    onPeerLeaved(peerId: string): void;
    requestStatus(): void;
    open(): Promise<void>;
    close(): Promise<void>;
    /** Indicates whether the room is currently active. */
    readonly isServing?: boolean;
    /** Legacy: host object that may carry isServing (LiveSyncTrysteroReplicator). */
    readonly server?: { isServing?: boolean };
}

/** Resolves the replicator which currently owns P2P state. */
export type P2PReplicatorProvider = () => P2PReplicatorLike;

/**
 * Add event handlers for P2P replication related events.
 * @param source A fixed compatibility instance or a provider for a replaceable replicator.
 */
export function addP2PEventHandlers(source: P2PReplicatorLike | P2PReplicatorProvider, events: LiveSyncEventHub) {
    const current = (): P2PReplicatorLike => (typeof source === "function" ? source() : source);
    events.onEvent(EVENT_ADVERTISEMENT_RECEIVED, (peer) => {
        void current().onNewPeer(peer);
    });
    // I know that the correct spell is "left"... Miserable
    events.onEvent(EVENT_DEVICE_LEAVED, (peerId) => {
        current().onPeerLeaved(peerId);
    });
    events.onEvent(EVENT_REQUEST_STATUS, () => {
        current().requestStatus();
    });
    events.onEvent(EVENT_DATABASE_REBUILT, async () => {
        await current().open();
    });
    events.onEvent(EVENT_PLATFORM_UNLOADED, () => {
        void current().close();
    });
    events.onEvent(EVENT_SETTING_SAVED, async (settings: P2PSyncSetting) => {
        const instance = current();
        if (settings.P2P_Enabled && settings.P2P_AutoStart) {
            await instance.open();
            return;
        }
        // close() also cancels an open operation which has not started serving yet.
        await instance.close();
    });
}

/**
 * open P2P replicator if not opened yet.
 * @param instance
 */
export async function openP2PReplicator(instance: P2PReplicatorLike) {
    const isOpen = instance.isServing ?? instance.server?.isServing ?? false;
    if (!isOpen) {
        await instance.open();
    }
}

/**
 * close P2P replicator
 * @param instance
 */
export async function closeP2PReplicator(instance: P2PReplicatorLike) {
    await instance.close();
}

// Backward-compatible overload: keep accepting LiveSyncTrysteroReplicator directly.
export type { LiveSyncTrysteroReplicator };
