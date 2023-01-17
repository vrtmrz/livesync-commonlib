import { LogEntry, logStore } from "./stores";
import { LOG_LEVEL } from "./types";

export function Logger(message: any, level?: LOG_LEVEL, key?: string): void {
    const entry = { message, level, key } as LogEntry;
    logStore.push(entry)
}
logStore.intercept(e => e.slice(Math.min(e.length - 200, 0)));