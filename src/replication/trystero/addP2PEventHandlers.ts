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
    /** True when peer callbacks are already fenced by the active room session. */
    readonly handlesPeerEventsWithinSession?: boolean;
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

/** Stable service lifecycle used by maintained host compositions. */
export interface P2PServiceEventTarget {
    requestStatus(): void;
    openAfterDatabaseRebuild(): Promise<void>;
    closeForLifecycle(): Promise<void>;
    reconcileAutoStart(settings: P2PSyncSetting): Promise<void>;
}

/** Resolves the replicator which currently owns P2P state. */
export type P2PEventTarget = P2PReplicatorLike | P2PServiceEventTarget;
export type P2PReplicatorProvider = () => P2PEventTarget;

function isServiceEventTarget(target: P2PEventTarget): target is P2PServiceEventTarget {
    return "reconcileAutoStart" in target;
}

/**
 * Add event handlers for P2P replication related events.
 * @param source A fixed compatibility instance or a provider for a replaceable replicator.
 */
export function addP2PEventHandlers(source: P2PEventTarget | P2PReplicatorProvider, events: LiveSyncEventHub) {
    const current = (): P2PEventTarget => (typeof source === "function" ? source() : source);
    events.onEvent(EVENT_ADVERTISEMENT_RECEIVED, (peer) => {
        const target = current();
        if ("onNewPeer" in target && target.handlesPeerEventsWithinSession !== true) void target.onNewPeer(peer);
    });
    // I know that the correct spell is "left"... Miserable
    events.onEvent(EVENT_DEVICE_LEAVED, (peerId) => {
        const target = current();
        if ("onPeerLeaved" in target && target.handlesPeerEventsWithinSession !== true) target.onPeerLeaved(peerId);
    });
    events.onEvent(EVENT_REQUEST_STATUS, () => {
        current().requestStatus();
    });
    events.onEvent(EVENT_DATABASE_REBUILT, async () => {
        const target = current();
        await (isServiceEventTarget(target) ? target.openAfterDatabaseRebuild() : target.open());
    });
    events.onEvent(EVENT_PLATFORM_UNLOADED, () => {
        const target = current();
        void (isServiceEventTarget(target) ? target.closeForLifecycle() : target.close());
    });
    events.onEvent(EVENT_SETTING_SAVED, async (settings: P2PSyncSetting) => {
        const target = current();
        if (isServiceEventTarget(target)) {
            await target.reconcileAutoStart(settings);
            return;
        }
        if (settings.P2P_Enabled && settings.P2P_AutoStart) {
            await target.open();
            return;
        }
        // close() also cancels an open operation which has not started serving yet.
        await target.close();
    });
}

// Backward-compatible overload: keep accepting LiveSyncTrysteroReplicator directly.
export type { LiveSyncTrysteroReplicator };
