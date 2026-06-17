// P2P replicator helper functions
import { eventHub, EVENT_DATABASE_REBUILT, EVENT_PLATFORM_UNLOADED, EVENT_SETTING_SAVED } from "@/common/events";
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

/**
 * Add event handlers for P2P replication related events.
 * @param instance P2PReplicatorLike instance
 */
export function addP2PEventHandlers(instance: P2PReplicatorLike) {
    eventHub.onEvent(EVENT_ADVERTISEMENT_RECEIVED, (peer) => {
        void instance.onNewPeer(peer);
    });
    // I know that the correct spell is "left"... Miserable
    eventHub.onEvent(EVENT_DEVICE_LEAVED, (peerId) => {
        instance.onPeerLeaved(peerId);
    });
    eventHub.onEvent(EVENT_REQUEST_STATUS, () => {
        instance.requestStatus();
    });
    eventHub.onEvent(EVENT_DATABASE_REBUILT, async () => {
        await instance.open();
    });
    eventHub.onEvent(EVENT_PLATFORM_UNLOADED, () => {
        void instance.close();
    });
    eventHub.onEvent(EVENT_SETTING_SAVED, async (settings: P2PSyncSetting) => {
        const isOpen = instance.isServing ?? instance.server?.isServing ?? false;
        if (settings.P2P_Enabled && settings.P2P_AutoStart) {
            await instance.open();
            return;
        }
        if (isOpen) {
            await instance.close();
        }
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
