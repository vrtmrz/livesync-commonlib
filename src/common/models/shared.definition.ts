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

/** The transfer stage; entering continuous replication does not imply Vault reflection is complete. */
export type CouchDBReplicationPhase = "idle" | "one-shot" | "catch-up" | "continuous";

export type ReplicationCheckpointProgress = {
    /** Changes-feed entries presented for revision comparison, including repeated entries on retries. */
    readonly checkedChanges: number;
    /** Batches which reached PouchDB's checkpoint notification, including batches without transfers. */
    readonly completedBatches: number;
    /** Opaque processed position, not a remaining-document count or proof of durable checkpoint storage. */
    readonly lastSeq?: string | number;
    /** Revision comparison is progressing; this does not establish that network transfer has not begun. */
    readonly checking: boolean;
};

/** Counters reset for each underlying PouchDB attempt, including the transition from catch-up to continuous. */
export type CouchDBReplicationProgress = {
    readonly phase: CouchDBReplicationPhase;
    readonly pull?: ReplicationCheckpointProgress;
    readonly push?: ReplicationCheckpointProgress;
};

/**
 * Raw statistics accepted by the publication boundary. The optional timestamp
 * is retained for compatibility and replaced when a value is published.
 */
export type ReplicationStatics = {
    sent: number;
    arrived: number;
    maxPullSeq: number;
    maxPushSeq: number;
    lastSyncPullSeq: number;
    lastSyncPushSeq: number;
    syncStatus: DatabaseConnectingStatus;
    statsUpdatedAt?: number | null;
    /** Present only when the provider supplies CouchDB checkpoint observations. */
    couchDB?: CouchDBReplicationProgress;
};

/** Statistics as observed after publication; the timestamp is always present. */
export type PublishedReplicationStatics = Readonly<
    Omit<ReplicationStatics, "statsUpdatedAt"> & {
        statsUpdatedAt: number | null;
    }
>;

export const DEFAULT_REPLICATION_STATICS: PublishedReplicationStatics = Object.freeze({
    sent: 0,
    arrived: 0,
    maxPullSeq: 0,
    maxPushSeq: 0,
    lastSyncPullSeq: 0,
    lastSyncPushSeq: 0,
    syncStatus: DatabaseConnectingStatuses.NOT_CONNECTED,
    statsUpdatedAt: null,
});
