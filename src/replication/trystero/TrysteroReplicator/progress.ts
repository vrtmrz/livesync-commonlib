import type { ProgressInfo } from "@lib/pouchdb/ReplicatorShim";
import { Logger, LOG_LEVEL_VERBOSE } from "octagonal-wheels/common/logger";
import { bindContext } from "octagonal-wheels/context";
import { projectAcknowledgedAttempt, projectDirectionProgress } from "../p2pReplicationProgress";

import type { P2PReplicationReport, AcknowledgedProgressAttempt, ProgressAcknowledgement } from "../replicationTypes";
export type {
    P2PReplicationDirectionProgress,
    P2PReplicationProgress,
    P2PReplicationReport,
} from "../replicationTypes";

/** A target captured from the current room and used for one progress acknowledgement. */
export type ProgressAcknowledgementTarget = {
    send(info?: ProgressInfo, acknowledgement?: ProgressAcknowledgement): Promise<unknown>;
};

/** Host capabilities needed to report and acknowledge replication progress. */
export type ReplicationProgressDependencies = {
    isDisposed: () => boolean;
    peerName: (peerId: string) => string | undefined;
    emitProgress: (report: P2PReplicationReport) => void;
    captureAcknowledgementTarget: (peerId: string) => ProgressAcknowledgementTarget | undefined;
};

type AcknowledgedAttempts = Map<string, AcknowledgedProgressAttempt>;

type OnReplicationProgressDeps = Pick<ReplicationProgressDependencies, "isDisposed" | "peerName" | "emitProgress">;

type OnProgressAcknowledgedContext = {
    dependencies: Pick<ReplicationProgressDependencies, "isDisposed" | "peerName" | "emitProgress">;
    acknowledgedAttempts: AcknowledgedAttempts;
};

type AcknowledgeProgressDeps = Pick<ReplicationProgressDependencies, "isDisposed" | "captureAcknowledgementTarget">;

/**
 * Trystero's default peer ID lives for this module realm. Keep attempts ordered
 * across room replacement, without adding persistent state or a clock dependency.
 */
let nextProgressAttempt = 0;

/**
 * Emit the local side of replication progress without creating or waiting for a
 * transport acknowledgement. The fetching report carries the current PouchDB
 * progress snapshot and preserves its statistics as an independent copy.
 */
export function onReplicationProgress(
    dependencies: OnReplicationProgressDeps,
    peerId: string,
    info?: ProgressInfo
): boolean {
    if (dependencies.isDisposed()) {
        return false;
    }
    const peerName = dependencies.peerName(peerId) || peerId;
    dependencies.emitProgress({
        peerId,
        peerName,
        fetching: projectDirectionProgress(info),
    });
    return true;
}

/**
 * Accept a remote progress acknowledgement only when its attempt and checked
 * change count are not stale. Final progress supplies the last statistics after
 * transfer completion, while the emitted sending direction remains inactive.
 */
export function onProgressAcknowledged(
    { dependencies, acknowledgedAttempts }: OnProgressAcknowledgedContext,
    peerId: string,
    info?: ProgressInfo | null,
    acknowledgement?: ProgressAcknowledgement
): boolean {
    if (dependencies.isDisposed()) {
        return false;
    }
    if (acknowledgement) {
        const next = projectAcknowledgedAttempt(acknowledgedAttempts.get(peerId), info, acknowledgement);
        if (!next) {
            return false;
        }
        acknowledgedAttempts.set(peerId, next);
    }
    const peerName = dependencies.peerName(peerId) || peerId;
    const sending = projectDirectionProgress(info ?? acknowledgement?.finalProgress);
    sending.isActive = info != null;
    dependencies.emitProgress({
        peerId,
        peerName,
        sending,
    });
    return true;
}

/**
 * Report progress without awaiting the reporting RPC's response. Capture the
 * current room after checking disposal and observe send failures in the background.
 * This reporting RPC is separate from the response-free change notification.
 */
export function acknowledgeProgress(
    dependencies: AcknowledgeProgressDeps,
    remotePeerId: string,
    info?: ProgressInfo,
    acknowledgement?: ProgressAcknowledgement
): void {
    if (dependencies.isDisposed()) {
        return;
    }
    try {
        const target = dependencies.captureAcknowledgementTarget(remotePeerId);
        if (!target) {
            return;
        }
        void target.send(info, acknowledgement).catch((error) => {
            Logger("Error while acknowledging the progress", LOG_LEVEL_VERBOSE);
            Logger(error, LOG_LEVEL_VERBOSE);
        });
    } catch (error) {
        Logger("Error while acknowledging the progress", LOG_LEVEL_VERBOSE);
        Logger(error, LOG_LEVEL_VERBOSE);
    }
}

/** Start a new room-independent attempt number in this module realm. */
export function beginAttempt(): ProgressAcknowledgement {
    return { attempt: ++nextProgressAttempt };
}

/** Forget only the departed peer's ordering state. */
export function peerLeft(acknowledgedAttempts: AcknowledgedAttempts, peerId: string): void {
    acknowledgedAttempts.delete(peerId);
}

/** Forget all room-local acknowledgement state without resetting attempt order. */
export function clear(acknowledgedAttempts: AcknowledgedAttempts): void {
    acknowledgedAttempts.clear();
}

/**
 * Create the room-local coordinator for progress projection and acknowledgement
 * ordering. Construction is inert: it allocates only the bounded peer-state map.
 */
export function createReplicationProgress(dependencies: ReplicationProgressDependencies) {
    const acknowledgedAttempts: AcknowledgedAttempts = new Map();
    return {
        onReplicationProgress: bindContext(dependencies, onReplicationProgress),
        onProgressAcknowledged: bindContext({ dependencies, acknowledgedAttempts }, onProgressAcknowledged),
        acknowledgeProgress: bindContext(dependencies, acknowledgeProgress),
        beginAttempt,
        peerLeft: bindContext(acknowledgedAttempts, peerLeft),
        clear: bindContext(acknowledgedAttempts, clear),
    };
}
