import type { ProgressInfo } from "@lib/pouchdb/ReplicatorShim";
import type {
    P2PReplicationDirectionProgress,
    ProgressAcknowledgement,
    AcknowledgedProgressAttempt,
} from "./replicationTypes";
export type { ProgressAcknowledgement, AcknowledgedProgressAttempt } from "./replicationTypes";

export function projectDirectionProgress(info?: ProgressInfo | null): P2PReplicationDirectionProgress {
    return {
        max: info?.maxSeqInBatch ?? 0,
        current: info?.lastSeq ?? 0,
        isActive: info != null,
        ...(info?.statistics ? { statistics: { ...info.statistics } } : {}),
    };
}

/** Return the next attempt snapshot, or reject stale, reordered, or already-ended progress. */
export function projectAcknowledgedAttempt(
    previous: AcknowledgedProgressAttempt | undefined,
    info: ProgressInfo | null | undefined,
    acknowledgement: ProgressAcknowledgement
): AcknowledgedProgressAttempt | undefined {
    if (!previous) {
        return {
            attempt: acknowledgement.attempt,
            isActive: info != null,
            checkedChanges: info?.statistics?.checkedChanges ?? 0,
        };
    }
    if (acknowledgement.attempt < previous.attempt) {
        return undefined;
    }
    if (acknowledgement.attempt === previous.attempt) {
        if (!previous.isActive) {
            return undefined;
        }
        if ((info?.statistics?.checkedChanges ?? previous.checkedChanges) < previous.checkedChanges) {
            return undefined;
        }
    }
    return {
        attempt: acknowledgement.attempt,
        isActive: info != null,
        checkedChanges: info?.statistics?.checkedChanges ?? previous.checkedChanges,
    };
}
