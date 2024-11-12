export type CheckPointInfo = {
    lastLocalSeq: number | string;
    knownIDs: Set<string>;
    sentIDs: Set<string>;
    receivedFiles: Set<string>;
    sentFiles: Set<string>;
};
export const CheckPointInfoDefault: CheckPointInfo = {
    lastLocalSeq: 0,
    knownIDs: new Set<string>(),
    sentIDs: new Set<string>(),
    receivedFiles: new Set<string>(),
    sentFiles: new Set<string>(),
};
