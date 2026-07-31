export type CheckPointInfo = {
    lastLocalSeq: number | string;
    journalEpoch: string;
    knownIDs: Set<string>;
    sentIDs: Set<string>;
    receivedFiles: Set<string>;
    sentFiles: Set<string>;
};

export function createCheckPointInfoDefault(): CheckPointInfo {
    return {
        lastLocalSeq: 0,
        journalEpoch: "",
        knownIDs: new Set<string>(),
        sentIDs: new Set<string>(),
        receivedFiles: new Set<string>(),
        sentFiles: new Set<string>(),
    };
}

export const CheckPointInfoDefault: CheckPointInfo = createCheckPointInfoDefault();
