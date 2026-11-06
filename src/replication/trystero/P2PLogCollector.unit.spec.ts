import { describe, expect, it } from "vitest";
import { createLiveSyncEventHub } from "@lib/hub/hub";
import { P2PLogCollector } from "./P2PLogCollector";
import {
    EVENT_ADVERTISEMENT_RECEIVED,
    EVENT_DEVICE_LEAVED,
    EVENT_P2P_CONNECTED,
    EVENT_P2P_DISCONNECTED,
    EVENT_P2P_REPLICATOR_PROGRESS,
} from "./TrysteroReplicatorP2PServer";

describe("P2P structured progress collection", () => {
    it("retains sequence rendering and exposes sorted independent statistics snapshots", () => {
        const events = createLiveSyncEventHub();
        const collector = new P2PLogCollector(events);
        events.emitEvent(EVENT_P2P_REPLICATOR_PROGRESS, {
            peerId: "b",
            peerName: "Device B",
            fetching: { current: 80, max: 120, isActive: true, statistics: { documents: 2, checkedChanges: 5 } },
        } as any);
        events.emitEvent(EVENT_P2P_REPLICATOR_PROGRESS, {
            peerId: "a",
            peerName: "Device A",
            sending: { current: 20, max: 20, isActive: true },
        });
        expect(collector.p2pReplicationLine.value).toBe("⚡ Device A ↑ 20 ↓ 0 \n⚡ Device B ↑ 0 ↓ 80 (120) ");
        const first = collector.p2pReplicationStats.value;
        expect(first.map((peer) => peer.peerId)).toEqual(["a", "b"]);
        expect(first[0].sending.statistics).toBeUndefined();
        expect(first[1].fetching.statistics).toEqual({ documents: 2, checkedChanges: 5 });
        events.emitEvent(EVENT_P2P_REPLICATOR_PROGRESS, {
            peerId: "b",
            peerName: "Device B",
            fetching: { current: 0, max: 0, isActive: false },
        });
        expect(first[1].fetching.isActive).toBe(true);
        expect(collector.p2pReplicationStats.value[1].fetching).toEqual({
            current: 80,
            max: 120,
            isActive: false,
            statistics: { documents: 2, checkedChanges: 5 },
        });
        events.emitEvent(EVENT_P2P_REPLICATOR_PROGRESS, {
            peerId: "b",
            peerName: "Device B",
            fetching: { current: 1, max: 2, isActive: true },
        });
        expect(collector.p2pReplicationStats.value[1].fetching.statistics).toBeUndefined();
        collector.dispose();
    });

    it.each([EVENT_P2P_CONNECTED, EVENT_P2P_DISCONNECTED, EVENT_DEVICE_LEAVED] as const)(
        "clears the snapshot on %s and detaches only its own handlers",
        (event) => {
            const events = createLiveSyncEventHub();
            const collector = new P2PLogCollector(events);
            const other = new P2PLogCollector(events);
            const report = { peerId: "a", peerName: "A", fetching: { current: 0, max: 0, isActive: true } };
            events.emitEvent(EVENT_P2P_REPLICATOR_PROGRESS, report);
            if (event === EVENT_DEVICE_LEAVED) events.emitEvent(event, "a");
            else events.emitEvent(event);
            expect(collector.p2pReplicationStats.value).toEqual([]);
            collector.dispose();
            events.emitEvent(EVENT_P2P_REPLICATOR_PROGRESS, report);
            expect(collector.p2pReplicationStats.value).toEqual([]);
            expect(other.p2pReplicationStats.value).toHaveLength(1);
            other.dispose();
        }
    );

    it("retains both directions across a repeated advertisement and later single-direction progress", () => {
        const events = createLiveSyncEventHub();
        const collector = new P2PLogCollector(events);
        events.emitEvent(EVENT_P2P_REPLICATOR_PROGRESS, {
            peerId: "peer",
            peerName: "Device",
            fetching: { current: 10, max: 15, isActive: true, statistics: { documents: 2, checkedChanges: 5 } },
        });
        events.emitEvent(EVENT_P2P_REPLICATOR_PROGRESS, {
            peerId: "peer",
            peerName: "Device",
            sending: { current: 20, max: 25, isActive: false, statistics: { documents: 3, checkedChanges: 6 } },
        });
        events.emitEvent(EVENT_ADVERTISEMENT_RECEIVED, { peerId: "peer", name: "Renamed", platform: "test" });
        expect(collector.p2pReplicationLine.value).toBe("💤 Renamed ↑ 0 ↓ 0 ");
        expect(collector.p2pReplicationResult.get("peer")?.fetching).toEqual({ current: 0, max: 0, isActive: false });
        expect(collector.p2pReplicationStats.value[0]).toMatchObject({
            peerName: "Renamed",
            fetching: { current: 10, max: 15, isActive: true, statistics: { documents: 2, checkedChanges: 5 } },
            sending: { current: 20, max: 25, isActive: false, statistics: { documents: 3, checkedChanges: 6 } },
        });
        events.emitEvent(EVENT_P2P_REPLICATOR_PROGRESS, {
            peerId: "peer",
            peerName: "Renamed",
            sending: { current: 30, max: 35, isActive: true, statistics: { documents: 4, checkedChanges: 7 } },
        });
        events.emitEvent(EVENT_P2P_REPLICATOR_PROGRESS, {
            peerId: "peer",
            peerName: "Renamed",
            fetching: { current: 0, max: 0, isActive: false },
        });
        expect(collector.p2pReplicationStats.value[0]).toMatchObject({
            fetching: { current: 10, max: 15, isActive: false, statistics: { documents: 2, checkedChanges: 5 } },
            sending: { current: 30, max: 35, isActive: true, statistics: { documents: 4, checkedChanges: 7 } },
        });
        collector.dispose();
    });
});
