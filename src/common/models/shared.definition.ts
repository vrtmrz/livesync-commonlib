export const DatabaseConnectingStatuses = {
    STARTED: "STARTED",
    NOT_CONNECTED: "NOT_CONNECTED",
    PAUSED: "PAUSED",
    CONNECTED: "CONNECTED",
    COMPLETED: "COMPLETED",
    CLOSED: "CLOSED",
    ERRORED: "ERRORED",
    JOURNAL_SEND: "JOURNAL_SEND",
    JOURNAL_RECEIVE: "JOURNAL_RECEIVE",
} as const;
export type DatabaseConnectingStatus = (typeof DatabaseConnectingStatuses)[keyof typeof DatabaseConnectingStatuses];

export type ReplicationStatics = {
    sent: number;
    arrived: number;
    maxPullSeq: number;
    maxPushSeq: number;
    lastSyncPullSeq: number;
    lastSyncPushSeq: number;
    syncStatus: DatabaseConnectingStatus;
};

export const DEFAULT_REPLICATION_STATICS: ReplicationStatics = {
    sent: 0,
    arrived: 0,
    maxPullSeq: 0,
    maxPushSeq: 0,
    lastSyncPullSeq: 0,
    lastSyncPushSeq: 0,
    syncStatus: DatabaseConnectingStatuses.CLOSED,
};
