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
