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
