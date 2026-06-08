import { eventHub } from "@/common/events";
import { reactiveSource } from "octagonal-wheels/dataobject/reactive_v2";
import type { P2PReplicationProgress } from "./TrysteroReplicator";
import {
    EVENT_ADVERTISEMENT_RECEIVED,
    EVENT_P2P_CONNECTED,
    EVENT_P2P_DISCONNECTED,
    EVENT_DEVICE_LEAVED,
    EVENT_P2P_REPLICATOR_PROGRESS,
} from "./TrysteroReplicatorP2PServer";

export class P2PLogCollector {
    constructor() {
        eventHub.onEvent(EVENT_ADVERTISEMENT_RECEIVED, (data) => {
            this.p2pReplicationResult.set(data.peerId, {
                peerId: data.peerId,
                peerName: data.name,
                fetching: {
                    current: 0,
                    max: 0,
                    isActive: false,
                },
                sending: {
                    current: 0,
                    max: 0,
                    isActive: false,
                },
            });
            this.updateP2PReplicationLine();
        });
        eventHub.onEvent(EVENT_P2P_CONNECTED, () => {
            this.p2pReplicationResult.clear();
            this.updateP2PReplicationLine();
        });
        eventHub.onEvent(EVENT_P2P_DISCONNECTED, () => {
            this.p2pReplicationResult.clear();
            this.updateP2PReplicationLine();
        });
        eventHub.onEvent(EVENT_DEVICE_LEAVED, (peerId) => {
            this.p2pReplicationResult.delete(peerId);
            this.updateP2PReplicationLine();
        });
        eventHub.onEvent(EVENT_P2P_REPLICATOR_PROGRESS, (data) => {
            const prev = this.p2pReplicationResult.get(data.peerId) || {
                peerId: data.peerId,
                peerName: data.peerName,
                fetching: {
                    current: 0,
                    max: 0,
                    isActive: false,
                },
                sending: {
                    current: 0,
                    max: 0,
                    isActive: false,
                },
            };
            if ("fetching" in data) {
                if (data.fetching.isActive) {
                    prev.fetching = data.fetching;
                } else {
                    prev.fetching.isActive = false;
                }
            }
            if ("sending" in data) {
                if (data.sending.isActive) {
                    prev.sending = data.sending;
                } else {
                    prev.sending.isActive = false;
                }
            }
            this.p2pReplicationResult.set(data.peerId, prev);
            this.updateP2PReplicationLine();
        });
    }
    p2pReplicationResult = new Map<string, P2PReplicationProgress>();
    updateP2PReplicationLine() {
        const p2pReplicationResultX = [...this.p2pReplicationResult.values()].sort((a, b) =>
            a.peerId.localeCompare(b.peerId)
        );
        const renderProgress = (current: number, max: number) => {
            if (current == max) return `${current}`;
            return `${current} (${max})`;
        };
        const line = p2pReplicationResultX
            .map(
                (e) =>
                    `${e.fetching.isActive || e.sending.isActive ? "⚡" : "💤"} ${e.peerName} ↑ ${renderProgress(e.sending.current, e.sending.max)} ↓ ${renderProgress(e.fetching.current, e.fetching.max)} `
            )
            .join("\n");
        this.p2pReplicationLine.value = line;
    }
    p2pReplicationLine = reactiveSource("");
}
