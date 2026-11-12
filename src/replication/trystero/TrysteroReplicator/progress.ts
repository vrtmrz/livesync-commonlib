import type { ProgressInfo, ReplicationStatistics } from "@lib/pouchdb/ReplicatorShim";
import { Logger, LOG_LEVEL_VERBOSE } from "octagonal-wheels/common/logger";
import { bindContext } from "octagonal-wheels/context";
import {
    projectAcknowledgedAttempt,
    projectDirectionProgress,
    type AcknowledgedProgressAttempt,
    type ProgressAcknowledgement,
} from "../p2pReplicationProgress";

/** Sequence progress retained for compatibility, with independently observed work counts. */
export type P2PReplicationDirectionProgress = {
    max: number;
    current: number;
    isActive: boolean;
    statistics?: ReplicationStatistics;
};

export type P2PReplicationProgress = {
    peerId: string;
    peerName: string;
    fetching: P2PReplicationDirectionProgress;
    sending: P2PReplicationDirectionProgress;
};
export type P2PReplicationReport = {
    peerId: string;
    peerName: string;
} & ({ fetching: P2PReplicationDirectionProgress } | { sending: P2PReplicationDirectionProgress });

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

type ReplicationProgressContext = {
    dependencies: ReplicationProgressDependencies;
    acknowledgedAttempts: Map<string, AcknowledgedProgressAttempt>;
};

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
function onReplicationProgress(context: ReplicationProgressContext, peerId: string, info?: ProgressInfo): boolean {
    const { dependencies } = context;
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
function onProgressAcknowledged(
    context: ReplicationProgressContext,
    peerId: string,
    info?: ProgressInfo | null,
    acknowledgement?: ProgressAcknowledgement
): boolean {
    const { dependencies, acknowledgedAttempts } = context;
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
function acknowledgeProgress(
    context: ReplicationProgressContext,
    remotePeerId: string,
    info?: ProgressInfo,
    acknowledgement?: ProgressAcknowledgement
): void {
    const { dependencies } = context;
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
function beginAttempt(_context: ReplicationProgressContext): ProgressAcknowledgement {
    return { attempt: ++nextProgressAttempt };
}

/** Forget only the departed peer's ordering state. */
function peerLeft(context: ReplicationProgressContext, peerId: string): void {
    context.acknowledgedAttempts.delete(peerId);
}

/** Forget all room-local acknowledgement state without resetting attempt order. */
function clear(context: ReplicationProgressContext): void {
    context.acknowledgedAttempts.clear();
}

/**
 * Create the room-local coordinator for progress projection and acknowledgement
 * ordering. Construction is inert: it allocates only the bounded peer-state map.
 */
export function createReplicationProgress(dependencies: ReplicationProgressDependencies) {
    const context: ReplicationProgressContext = {
        dependencies,
        acknowledgedAttempts: new Map(),
    };
    return {
        onReplicationProgress: bindContext(context, onReplicationProgress),
        onProgressAcknowledged: bindContext(context, onProgressAcknowledged),
        acknowledgeProgress: bindContext(context, acknowledgeProgress),
        beginAttempt: bindContext(context, beginAttempt),
        peerLeft: bindContext(context, peerLeft),
        clear: bindContext(context, clear),
    };
}
