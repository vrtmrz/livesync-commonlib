import { LOG_LEVEL } from "./types";
export const LEVEL_DEBUG = LOG_LEVEL.DEBUG;
export const LEVEL_INFO = LOG_LEVEL.INFO;
export const LEVEL_NOTICE = LOG_LEVEL.NOTICE;
export const LEVEL_URGENT = LOG_LEVEL.URGENT;
export const LEVEL_VERBOSE = LOG_LEVEL.VERBOSE;

export type LoggerFunction = typeof defaultLogger;

export const defaultLoggerEnv = {
    minLogLevel: LOG_LEVEL.INFO
}
const defaultLogger = function defaultLogger(message: any, level: LOG_LEVEL = LEVEL_INFO, key?: string) {
    if (level < defaultLoggerEnv.minLogLevel) {
        return;
    }
    const now = new Date();
    const timestamp = now.toLocaleString();
    const messageContent = typeof message == "string" ? message : message instanceof Error ? `${message.name}:${message.message}` : JSON.stringify(message, null, 2);
    if (message instanceof Error) {
        // debugger;
        console.dir(message.stack);
    }
    const newMessage = `${timestamp}\t${level}\t${messageContent}`;
    console.log(newMessage);
};

let _logger: LoggerFunction = defaultLogger;

export function setGlobalLogFunction(logger: LoggerFunction) {
    _logger = logger;
}
export function Logger(message: any, level?: LOG_LEVEL, key?: string): void {
    _logger(message, level, key);
}
