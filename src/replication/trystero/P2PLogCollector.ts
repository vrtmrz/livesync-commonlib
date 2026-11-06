import { EVENT_PLATFORM_UNLOADED } from "@lib/events/coreEvents";
import type { LiveSyncEventHub } from "@lib/hub/hub";
import { reactiveSource, type ReactiveValue } from "octagonal-wheels/dataobject/reactive_v2";
import type { P2PReplicationProgress, P2PReplicationReport } from "./TrysteroReplicator";
import {
    EVENT_ADVERTISEMENT_RECEIVED,
    EVENT_P2P_CONNECTED,
    EVENT_P2P_DISCONNECTED,
    EVENT_DEVICE_LEAVED,
    EVENT_P2P_REPLICATOR_PROGRESS,
} from "./TrysteroReplicatorP2PServer";

function initialProgress(peerId: string, peerName: string): P2PReplicationProgress {
    return {
        peerId,
        peerName,
        fetching: { current: 0, max: 0, isActive: false },
        sending: { current: 0, max: 0, isActive: false },
    };
}

function applyReport(previous: P2PReplicationProgress, report: P2PReplicationReport): void {
    if ("fetching" in report) {
        if (report.fetching.isActive || report.fetching.statistics) previous.fetching = report.fetching;
        else previous.fetching.isActive = false;
    }
    if ("sending" in report) {
        if (report.sending.isActive || report.sending.statistics) previous.sending = report.sending;
        else previous.sending.isActive = false;
    }
}

export class P2PLogCollector {
    private readonly eventController = new AbortController();
    private readonly statisticsSource = reactiveSource<readonly P2PReplicationProgress[]>(Object.freeze([]));
    readonly p2pReplicationStats: ReactiveValue<readonly P2PReplicationProgress[]> = this.statisticsSource;

    constructor(events: LiveSyncEventHub) {
        const options = { signal: this.eventController.signal };
        events.onEvent(
            EVENT_ADVERTISEMENT_RECEIVED,
            (data) => {
                this.p2pReplicationResult.set(data.peerId, initialProgress(data.peerId, data.name));
                this.updateP2PReplicationLine();
                const statistics = this.statisticsFor(data.peerId, data.name);
                statistics.peerName = data.name;
                this.publishStatistics(statistics);
            },
            options
        );
        events.onEvent(
            EVENT_P2P_CONNECTED,
            () => {
                this.p2pReplicationResult.clear();
                this.updateP2PReplicationLine();
                this.statisticsSource.value = Object.freeze([]);
            },
            options
        );
        events.onEvent(
            EVENT_P2P_DISCONNECTED,
            () => {
                this.p2pReplicationResult.clear();
                this.updateP2PReplicationLine();
                this.statisticsSource.value = Object.freeze([]);
            },
            options
        );
        events.onEvent(
            EVENT_DEVICE_LEAVED,
            (peerId) => {
                this.p2pReplicationResult.delete(peerId);
                this.updateP2PReplicationLine();
                this.statisticsSource.value = Object.freeze(
                    this.statisticsSource.value.filter((peer) => peer.peerId !== peerId)
                );
            },
            options
        );
        events.onEvent(
            EVENT_P2P_REPLICATOR_PROGRESS,
            (data) => {
                const previous =
                    this.p2pReplicationResult.get(data.peerId) ?? initialProgress(data.peerId, data.peerName);
                applyReport(previous, data);
                this.p2pReplicationResult.set(data.peerId, previous);
                this.updateP2PReplicationLine();
                const statistics = this.statisticsFor(data.peerId, data.peerName);
                applyReport(statistics, data);
                this.publishStatistics(statistics);
            },
            options
        );
        events.onEvent(EVENT_PLATFORM_UNLOADED, () => this.dispose(), options);
    }

    private statisticsFor(peerId: string, peerName: string): P2PReplicationProgress {
        const previous = this.statisticsSource.value.find((peer) => peer.peerId === peerId);
        return previous
            ? {
                  ...previous,
                  fetching: { ...previous.fetching },
                  sending: { ...previous.sending },
              }
            : initialProgress(peerId, peerName);
    }

    private publishStatistics(progress: P2PReplicationProgress): void {
        const snapshotDirection = (direction: P2PReplicationProgress["fetching"]) =>
            Object.freeze({
                ...direction,
                ...(direction.statistics ? { statistics: Object.freeze({ ...direction.statistics }) } : {}),
            });
        const snapshot = Object.freeze({
            ...progress,
            fetching: snapshotDirection(progress.fetching),
            sending: snapshotDirection(progress.sending),
        });
        this.statisticsSource.value = Object.freeze(
            [...this.statisticsSource.value.filter((peer) => peer.peerId !== progress.peerId), snapshot].sort((a, b) =>
                a.peerId.localeCompare(b.peerId)
            )
        );
    }

    /** Release this collector's event registrations without affecting another consumer. */
    dispose(): void {
        this.eventController.abort();
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
