// P2P replicator helper functions
import { eventHub, EVENT_DATABASE_REBUILT, EVENT_PLATFORM_UNLOADED, EVENT_SETTING_SAVED } from "@/common/events";
import type { P2PSyncSetting } from "../../common/types";
import type { LiveSyncTrysteroReplicator } from "./LiveSyncTrysteroReplicator";
import { EVENT_ADVERTISEMENT_RECEIVED, EVENT_DEVICE_LEAVED, EVENT_REQUEST_STATUS } from "./TrysteroReplicatorP2PServer";

/**
 * Add event handlers for P2P replication related events.
 * @param instance LiveSyncTrysteroReplicator instance
 */
export function addP2PEventHandlers(instance: LiveSyncTrysteroReplicator) {
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
    eventHub.onEvent(EVENT_SETTING_SAVED, async (_settings: P2PSyncSetting) => {
        await instance.open();
    });
}

/**
 * open P2P replicator if not opened yet.
 * @param instance
 */
export async function openP2PReplicator(instance: LiveSyncTrysteroReplicator) {
    if (!instance.server?.isServing) {
        await instance.open();
    }
}

/**
 * close P2P replicator
 * @param instance
 */
export async function closeP2PReplicator(instance: LiveSyncTrysteroReplicator) {
    await instance.close();
}
