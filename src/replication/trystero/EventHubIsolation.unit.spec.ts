import { describe, expect, it, vi } from "vitest";

import { createLiveSyncEventHub } from "@lib/hub/hub";
import { addP2PEventHandlers, type P2PReplicatorLike } from "./addP2PEventHandlers";
import { P2PLogCollector } from "./P2PLogCollector";
import {
    EVENT_ADVERTISEMENT_RECEIVED,
    EVENT_P2P_REPLICATOR_PROGRESS,
} from "./TrysteroReplicatorP2PServer";

describe("P2P event hub isolation", () => {
    it("registers lifecycle handlers on the supplied event hub", () => {
        const events = createLiveSyncEventHub();
        const instance: P2PReplicatorLike = {
            onNewPeer: vi.fn(),
            onPeerLeaved: vi.fn(),
            requestStatus: vi.fn(),
            open: vi.fn(async () => undefined),
            close: vi.fn(async () => undefined),
        };

        addP2PEventHandlers(instance, events);
        events.emitEvent(EVENT_ADVERTISEMENT_RECEIVED, {
            peerId: "peer-a",
            name: "Device A",
            platform: "test",
        });

        expect(instance.onNewPeer).toHaveBeenCalledWith({
            peerId: "peer-a",
            name: "Device A",
            platform: "test",
        });
    });

    it("collects progress from the supplied event hub only", () => {
        const firstEvents = createLiveSyncEventHub();
        const secondEvents = createLiveSyncEventHub();
        const first = new P2PLogCollector(firstEvents);
        const second = new P2PLogCollector(secondEvents);

        firstEvents.emitEvent(EVENT_P2P_REPLICATOR_PROGRESS, {
            peerId: "peer-a",
            peerName: "Device A",
            fetching: { current: 1, max: 2, isActive: true },
        });

        expect(first.p2pReplicationResult.has("peer-a")).toBe(true);
        expect(second.p2pReplicationResult.has("peer-a")).toBe(false);
    });
});
