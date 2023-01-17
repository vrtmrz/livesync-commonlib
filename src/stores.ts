import { getGlobalStore, getGlobalStreamStore } from "./store";
import { LOG_LEVEL } from "./types";

export type LockStats = {
    pending: string[],
    running: string[],
    count: number;
}
export const lockStore = getGlobalStore<LockStats>("locks", { pending: [], running: [], count: 0 });

export const waitingData = getGlobalStore("processingLast", 0);
export type LogEntry = {
    message: string | Error,
    level?: LOG_LEVEL,
    key?: string;
}

export const logStore = getGlobalStreamStore("logs", [] as LogEntry[]);
export const logMessageStore = getGlobalStore("logMessage", [] as string[]);