import { EVENT_PLATFORM_UNLOADED } from "@lib/events/coreEvents";
import type { LiveSyncEventHub } from "@lib/hub/hub";
import { reactiveSource, type ReactiveValue } from "octagonal-wheels/dataobject/reactive_v2";
import type { P2PReplicationProgress, P2PReplicationReport } from "./TrysteroReplicator";
import type { Advertisement } from "./types";
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
        if (report.fetching.isActive || report.fetching.statistics) {
            previous.fetching = report.fetching;
        } else {
            previous.fetching.isActive = false;
        }
    }
    if ("sending" in report) {
        if (report.sending.isActive || report.sending.statistics) {
            previous.sending = report.sending;
        } else {
            previous.sending.isActive = false;
        }
    }
}

function snapshotProgress(progress: P2PReplicationProgress): P2PReplicationProgress {
    const snapshotDirection = (direction: P2PReplicationProgress["fetching"]) =>
        Object.freeze({
            ...direction,
            ...(direction.statistics ? { statistics: Object.freeze({ ...direction.statistics }) } : {}),
        });
    return Object.freeze({
        ...progress,
        fetching: snapshotDirection(progress.fetching),
        sending: snapshotDirection(progress.sending),
    });
}

function renderProgressLine(progresses: Iterable<P2PReplicationProgress>): string {
    const sortedProgresses = [...progresses].sort((a, b) => a.peerId.localeCompare(b.peerId));
    const renderCount = (current: number, max: number) => {
        if (current == max) {
            return `${current}`;
        }
        return `${current} (${max})`;
    };
    return sortedProgresses
        .map(
            (peer) =>
                `${peer.fetching.isActive || peer.sending.isActive ? "⚡" : "💤"} ${peer.peerName} ↑ ${renderCount(peer.sending.current, peer.sending.max)} ↓ ${renderCount(peer.fetching.current, peer.fetching.max)} `
        )
        .join("\n");
}

export class P2PLogCollector {
    private readonly eventController = new AbortController();
    private readonly statisticsSource = reactiveSource<readonly P2PReplicationProgress[]>(Object.freeze([]));
    readonly p2pReplicationStats: ReactiveValue<readonly P2PReplicationProgress[]> = this.statisticsSource;

    constructor(events: LiveSyncEventHub) {
        const options = { signal: this.eventController.signal };
        events.onEvent(EVENT_ADVERTISEMENT_RECEIVED, (data) => this.handleAdvertisementReceived(data), options);
        events.onEvent(EVENT_P2P_CONNECTED, () => this.resetPeerState(), options);
        events.onEvent(EVENT_P2P_DISCONNECTED, () => this.resetPeerState(), options);
        events.onEvent(EVENT_DEVICE_LEAVED, (peerId) => this.handleDeviceLeaved(peerId), options);
        events.onEvent(EVENT_P2P_REPLICATOR_PROGRESS, (data) => this.handleReplicationProgress(data), options);
        events.onEvent(EVENT_PLATFORM_UNLOADED, () => this.dispose(), options);
    }

    private handleAdvertisementReceived(data: Advertisement): void {
        this.p2pReplicationResult.set(data.peerId, initialProgress(data.peerId, data.name));
        this.updateP2PReplicationLine();
        const statistics = this.statisticsFor(data.peerId, data.name);
        statistics.peerName = data.name;
        this.publishStatistics(statistics);
    }

    private resetPeerState(): void {
        this.p2pReplicationResult.clear();
        this.updateP2PReplicationLine();
        this.statisticsSource.value = Object.freeze([]);
    }

    private handleDeviceLeaved(peerId: string): void {
        this.p2pReplicationResult.delete(peerId);
        this.updateP2PReplicationLine();
        this.statisticsSource.value = Object.freeze(
            this.statisticsSource.value.filter((peer) => peer.peerId !== peerId)
        );
    }

    private handleReplicationProgress(data: P2PReplicationReport): void {
        const previous = this.p2pReplicationResult.get(data.peerId) ?? initialProgress(data.peerId, data.peerName);
        applyReport(previous, data);
        this.p2pReplicationResult.set(data.peerId, previous);
        this.updateP2PReplicationLine();
        const statistics = this.statisticsFor(data.peerId, data.peerName);
        applyReport(statistics, data);
        this.publishStatistics(statistics);
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
        const snapshot = snapshotProgress(progress);
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
        this.p2pReplicationLine.value = renderProgressLine(this.p2pReplicationResult.values());
    }
    p2pReplicationLine = reactiveSource("");
}
