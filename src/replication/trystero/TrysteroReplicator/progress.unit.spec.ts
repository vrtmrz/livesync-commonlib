import { describe, expect, it, vi } from "vitest";
import type { ProgressInfo } from "@lib/pouchdb/ReplicatorShim";
import {
    createReplicationProgress,
    type P2PReplicationReport,
    type ProgressAcknowledgementTarget,
    type ReplicationProgressDependencies,
} from "./progress";
import type { ProgressAcknowledgement } from "../p2pReplicationProgress";

type AcknowledgementSend = ProgressAcknowledgementTarget["send"];

function progress(checkedChanges: number, lastSeq = checkedChanges): ProgressInfo {
    return {
        lastSeq,
        maxSeqInBatch: lastSeq + 2,
        statistics: { documents: checkedChanges, checkedChanges },
    };
}

function createHarness() {
    let disposed = false;
    let target: ProgressAcknowledgementTarget | undefined;
    const isDisposed = vi.fn(() => disposed);
    const peerName = vi.fn((peerId: string) => "Peer " + peerId);
    const emitProgress = vi.fn<(report: P2PReplicationReport) => void>();
    const captureAcknowledgementTarget = vi.fn((_peerId: string) => target);
    const dependencies: ReplicationProgressDependencies = {
        isDisposed,
        peerName,
        emitProgress,
        captureAcknowledgementTarget,
    };
    const coordinator = createReplicationProgress(dependencies);

    return {
        coordinator,
        dependencies,
        emitProgress,
        peerName,
        captureAcknowledgementTarget,
        setDisposed: (value: boolean) => {
            disposed = value;
        },
        setTarget: (send: AcknowledgementSend | undefined) => {
            target = send ? { send } : undefined;
        },
    };
}

describe("P2P replication progress coordinator", () => {
    it("allocates monotonically increasing attempt numbers across instances and clear", () => {
        const first = createHarness();
        const firstAttempt = first.coordinator.beginAttempt();
        first.coordinator.clear();

        const second = createHarness();
        const secondAttempt = second.coordinator.beginAttempt();

        expect(secondAttempt.attempt).toBe(firstAttempt.attempt + 1);
    });

    it("keeps fetching and sending reports distinct and snapshots statistics", () => {
        const h = createHarness();
        const input = progress(4, 7);

        expect(h.coordinator.onReplicationProgress("fetch-peer", input)).toBe(true);
        const fetchingReport = h.emitProgress.mock.calls[0][0];
        expect(fetchingReport).toEqual({
            peerId: "fetch-peer",
            peerName: "Peer fetch-peer",
            fetching: {
                max: 9,
                current: 7,
                isActive: true,
                statistics: { documents: 4, checkedChanges: 4 },
            },
        });

        expect(
            h.coordinator.onProgressAcknowledged("send-peer", input, {
                attempt: 3,
            })
        ).toBe(true);
        const sendingReport = h.emitProgress.mock.calls[1][0];
        expect(sendingReport).toHaveProperty("sending");
        expect(sendingReport).not.toHaveProperty("fetching");
        if (!("sending" in sendingReport)) {
            throw new Error("Expected a sending progress report");
        }
        expect(sendingReport.sending.isActive).toBe(true);
        expect(sendingReport.sending.statistics).not.toBe(input.statistics);

        if (input.statistics) {
            input.statistics.checkedChanges = 40;
        }
        expect(sendingReport.sending.statistics?.checkedChanges).toBe(4);
    });

    it("rejects stale, reordered, regressed, and ended progress while retaining final statistics", () => {
        const h = createHarness();
        const acknowledgement = { attempt: 8 };
        expect(h.coordinator.onProgressAcknowledged("peer", progress(3), acknowledgement)).toBe(true);

        expect(h.coordinator.onProgressAcknowledged("peer", progress(99), { attempt: 7 })).toBe(false);
        expect(h.coordinator.onProgressAcknowledged("peer", progress(2), acknowledgement)).toBe(false);
        expect(h.coordinator.onProgressAcknowledged("peer", progress(5), acknowledgement)).toBe(true);

        const finalProgress = progress(5, 11);
        expect(
            h.coordinator.onProgressAcknowledged("peer", undefined, {
                ...acknowledgement,
                finalProgress,
            })
        ).toBe(true);
        const finalReport = h.emitProgress.mock.calls.at(-1)?.[0];
        expect(finalReport).toHaveProperty("sending");
        if (!finalReport || !("sending" in finalReport)) {
            throw new Error("Expected a final sending progress report");
        }
        expect(finalReport.sending).toMatchObject({
            max: 13,
            current: 11,
            isActive: false,
            statistics: { documents: 5, checkedChanges: 5 },
        });

        expect(h.coordinator.onProgressAcknowledged("peer", progress(6), acknowledgement)).toBe(false);
        expect(h.emitProgress).toHaveBeenCalledTimes(3);
    });

    it("allows a lower attempt after peer departure or a full clear", () => {
        const h = createHarness();
        expect(h.coordinator.onProgressAcknowledged("peer", progress(10), { attempt: 10 })).toBe(true);

        h.coordinator.peerLeft("peer");
        expect(h.coordinator.onProgressAcknowledged("peer", progress(1), { attempt: 1 })).toBe(true);

        h.coordinator.clear();
        expect(h.coordinator.onProgressAcknowledged("peer", progress(0), { attempt: 0 })).toBe(true);
    });

    it("skips event work and transport capture after disposal", () => {
        const h = createHarness();
        h.setDisposed(true);

        expect(h.coordinator.onReplicationProgress("peer", progress(1))).toBe(false);
        expect(h.coordinator.onProgressAcknowledged("peer", progress(1), { attempt: 1 })).toBe(false);
        expect(h.coordinator.acknowledgeProgress("peer", progress(1), { attempt: 1 })).toBeUndefined();
        expect(h.emitProgress).not.toHaveBeenCalled();
        expect(h.captureAcknowledgementTarget).not.toHaveBeenCalled();
    });

    it("falls back to the peer ID when the room has no usable advertised name", () => {
        const h = createHarness();
        h.peerName.mockReturnValueOnce(undefined).mockReturnValueOnce("");

        h.coordinator.onReplicationProgress("peer", progress(1));
        h.coordinator.onProgressAcknowledged("peer", progress(1));

        expect(h.emitProgress.mock.calls.map(([report]) => report.peerName)).toEqual(["peer", "peer"]);
    });

    it("returns before a captured acknowledgement send settles", async () => {
        const h = createHarness();
        let finish!: () => void;
        const pending = new Promise<unknown>((resolve) => {
            finish = () => resolve(undefined);
        });
        const send = vi.fn<AcknowledgementSend>(() => pending);
        h.setTarget(send);

        const result = h.coordinator.acknowledgeProgress("peer", progress(1), { attempt: 1 });

        expect(result).toBeUndefined();
        expect(send).toHaveBeenCalledExactlyOnceWith(progress(1), { attempt: 1 });
        finish();
        await pending;
    });

    it("contains synchronous and asynchronous target-send failures", async () => {
        const h = createHarness();
        const synchronousFailure = new Error("synchronous send failure");
        const synchronousSend = vi.fn<AcknowledgementSend>(() => {
            throw synchronousFailure;
        });
        h.setTarget(synchronousSend);

        expect(() => h.coordinator.acknowledgeProgress("peer")).not.toThrow();
        expect(synchronousSend).toHaveBeenCalledOnce();

        const asynchronousFailure = new Error("asynchronous send failure");
        const asynchronousSend = vi.fn<AcknowledgementSend>(() => Promise.reject(asynchronousFailure));
        h.setTarget(asynchronousSend);

        expect(() => h.coordinator.acknowledgeProgress("peer")).not.toThrow();
        await Promise.resolve();
        expect(asynchronousSend).toHaveBeenCalledOnce();
    });

    it("returns without sending when the current room has no acknowledgement target", () => {
        const h = createHarness();

        expect(h.coordinator.acknowledgeProgress("peer", progress(1))).toBeUndefined();
        expect(h.captureAcknowledgementTarget).toHaveBeenCalledExactlyOnceWith("peer");
    });
});
