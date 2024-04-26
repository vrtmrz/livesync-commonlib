export type CheckPointInfo = {
    lastLocalSeq: number | string;
    knownIDs: string[];
    receivedFiles: string[];
    sentFiles: string[];
}
export const CheckPointInfoDefault: CheckPointInfo = {
    lastLocalSeq: 0,
    knownIDs: [],
    receivedFiles: [],
    sentFiles: [],
}

export interface SimpleStore<T> {
    get(key: string): Promise<T | undefined>;
    set(key: string, value: T): Promise<void>;
    delete(key: string): Promise<void>;
    keys(from: string | undefined, to: string | undefined, count?: number): Promise<string[]>;
}
