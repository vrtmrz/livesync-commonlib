export type CheckPointInfo = {
    lastLocalSeq: number | string;
    journalEpoch: string;
    knownIDs: Set<string>;
    sentIDs: Set<string>;
    receivedFiles: Set<string>;
    sentFiles: Set<string>;
};
export const CheckPointInfoDefault: CheckPointInfo = {
    lastLocalSeq: 0,
    journalEpoch: "",
    knownIDs: new Set<string>(),
    sentIDs: new Set<string>(),
    receivedFiles: new Set<string>(),
    sentFiles: new Set<string>(),
};

/** Processing stages at which one identified Journal can stop receipt. */
export type JournalReceiveFailureStage =
    | "download"
    | "decrypt"
    | "inflate"
    | "decode"
    | "parse"
    | "chunk-write"
    | "metadata-write";

/**
 * The exact failure presented for a single explicit skip operation.
 * Pass the returned object unchanged; copies and snapshots from earlier attempts
 * are rejected. This state is local to the active Journal client and is not saved.
 */
export interface StoppedJournal {
    /** Object key of the Journal which stopped receipt. */
    readonly key: string;
    /** Stage at which receipt stopped. */
    readonly stage: JournalReceiveFailureStage;
}
