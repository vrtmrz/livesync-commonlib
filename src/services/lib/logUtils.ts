import {
    type LOG_LEVEL,
    LOG_LEVEL_INFO,
    LOG_LEVEL_NOTICE,
    LOG_LEVEL_VERBOSE,
    Logger,
} from "octagonal-wheels/common/logger";
import type { IAPIService } from "../base/IService";
export const MARK_LOG_SEPARATOR = "\u{200A}";
export const MARK_LOG_NETWORK_ERROR = "\u{200b}"; // u+200B is a zero-width space, which is used to tag logs as network errors for filtering purposes.

/**
 * Creates a log function that prefixes messages with the service name and uses the provided APIService's addLog method if available.
 * If APIService is not provided, it falls back to using the global Logger function.
 * @param serviceName The name of the service to prefix log messages with.
 * @param APIService An optional APIService instance to use for logging.
 * @returns A log function that can be used to log messages with the specified service name and APIService.
 */
export function createInstanceLogFunction(serviceName: string, APIService?: IAPIService) {
    const logFunc = APIService?.addLog.bind(APIService) ?? Logger;
    return (msg: any, level: LOG_LEVEL = LOG_LEVEL_INFO, key: string = "") => {
        const isError = msg instanceof Error;
        if (isError && level <= LOG_LEVEL_VERBOSE) {
            logFunc(msg, level, key);
            return;
        }
        let formattedMsg: string = typeof msg === "string" ? msg : isError ? msg.message : JSON.stringify(msg);
        // u+200A is a hair space, which is used to create a small gap between the service name and the message.
        if (level < LOG_LEVEL_NOTICE) {
            // If we simply logging the message, add a service name prefix to make it easier to identify which service the log is coming from.
            // On the other hand, if the log level is notice or above, pop-up-notification may not have enough space to show the service name.
            formattedMsg = `[${serviceName}]${MARK_LOG_SEPARATOR} ${formattedMsg}`;
        }

        logFunc(formattedMsg, level, key);
    };
}

export type LogFunction = ReturnType<typeof createInstanceLogFunction>;
