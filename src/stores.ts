import { QueueProcessor } from "./processor.ts";
import { reactiveSource } from "./reactive.ts";
import { LOG_LEVEL } from "./types.ts";

export type LockStats = {
    pending: string[],
    running: string[],
    count: number;
}
export const lockStats = reactiveSource({ pending: [], running: [], count: 0 })
export const collectingChunks = reactiveSource(0);
export const pluginScanningCount = reactiveSource(0);
export const hiddenFilesProcessingCount = reactiveSource(0);
export const hiddenFilesEventCount = reactiveSource(0);
export type LogEntry = {
    message: string | Error,
    level?: LOG_LEVEL,
    key?: string;
}

export const logStore = new QueueProcessor((e: LogEntry[]) => {
    return e;
}, { batchSize: 1, suspended: false, keepResultUntilDownstreamConnected: true });

export const logMessages = reactiveSource<string[]>([]);