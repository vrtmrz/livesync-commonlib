// WakeLock Module

import { compatGlobal } from "@lib/common/coreEnvFunctions";
import { LOG_LEVEL_VERBOSE, Logger } from "octagonal-wheels/common/logger";

const globalWakeLock = ("navigator" in compatGlobal) && ("wakeLock" in compatGlobal.navigator) ? compatGlobal.navigator.wakeLock : undefined;

/**
 * Run callback with screen wake lock held.
 * @param callback Callback to run with wake lock held
 * @returns Result of callback
 */
export async function withWakeLock<T>(callback: () => Promise<T>): Promise<T> {
    if (!globalWakeLock) {
        return callback();
    }

    let lock: WakeLockSentinel | undefined = undefined;

    // AbortController is used to manage event listeners and state for releasing them all at once
    const abortController = new AbortController();
    const { signal } = abortController;

    const requestLock = async () => {
        if (signal.aborted) return; // If processing has already finished, do nothing

        try {
            const newLock = await globalWakeLock.request("screen");
            if (signal.aborted) {
                // If it was aborted while we were waiting, release it immediately!
                await newLock.release();
                return;
            }
            lock = newLock;
            Logger(`Wake lock acquired`, LOG_LEVEL_VERBOSE);

            // By passing signal, it will be automatically released when abort() is called
            lock.addEventListener("release", () => {
                Logger(`Wake lock released by system`, LOG_LEVEL_VERBOSE);
                lock = undefined;
            }, { signal });
            return lock;

        } catch (e) {
            Logger(`Failed to acquire wake lock`, LOG_LEVEL_VERBOSE);
            Logger(e, LOG_LEVEL_VERBOSE);
        }
    };

    const handleVisibilityChange = () => {
        // Re-acquire when the screen becomes active again
        if (compatGlobal.document.visibilityState === "visible" && !lock) {
            Logger(`Document became visible, re-acquiring wake lock`, LOG_LEVEL_VERBOSE);
            requestLock();
        }
    };

    // 1. First lock acquisition
    lock = await requestLock();

    // 2. Monitor screen visibility changes (automatically released when aborted)
    if (typeof compatGlobal.document !== "undefined") {
        compatGlobal.document.addEventListener("visibilitychange", handleVisibilityChange, { signal });
    }

    try {
        // 3. Execute main process
        return await callback();
    } finally {
        // 4. Cleanup process
        // Release all listeners (visibilitychange, release) at once!
        abortController.abort();

        // Release lock manually
        if (lock) {
            try {
                await lock.release();
                Logger(`Wake lock released manually`, LOG_LEVEL_VERBOSE);
            } catch (e) {
                Logger(`Failed to release wake lock`, LOG_LEVEL_VERBOSE);
            }
        }
    }
}