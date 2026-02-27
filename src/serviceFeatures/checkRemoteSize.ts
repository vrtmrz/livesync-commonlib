import { sizeToHumanReadable } from "octagonal-wheels/number";
import { LOG_LEVEL_INFO, LOG_LEVEL_NOTICE, LOG_LEVEL_VERBOSE } from "@lib/common/types";
import { createInstanceLogFunction, type LogFunction } from "@lib/services/lib/logUtils";

import type { NecessaryServices } from "@lib/interfaces/ServiceModule";
import { EVENT_REQUEST_CHECK_REMOTE_SIZE } from "@lib/events/coreEvents";
import { $msg } from "@lib/common/i18n";
import { eventHub } from "@lib/hub/hub";

/**
 * Notify when checking remote storage size is not configured.
 * @returns true if the check is passed or user has configured the notification, false to block subsequent processes. (always true).
 */
export function onNotifyRemoteSizeNotConfiguredFactory(
    host: NecessaryServices<"appLifecycle" | "API" | "setting", any>,
    log: ReturnType<typeof createInstanceLogFunction>
) {
    return async () => {
        log($msg("moduleCheckRemoteSize.logCheckingStorageSizes"), LOG_LEVEL_VERBOSE);
        const settings = host.services.setting.currentSettings();
        if (settings.notifyThresholdOfRemoteStorageSize >= 0) {
            return true;
        }
        const message = $msg("moduleCheckRemoteSize.msgSetDBCapacity");
        const ANSWER_0 = $msg("moduleCheckRemoteSize.optionNoWarn");
        const ANSWER_800 = $msg("moduleCheckRemoteSize.option800MB");
        const ANSWER_2000 = $msg("moduleCheckRemoteSize.option2GB");
        const ASK_ME_NEXT_TIME = $msg("moduleCheckRemoteSize.optionAskMeLater");

        const ret = await host.services.API.confirm.askSelectStringDialogue(
            message,
            [ANSWER_0, ANSWER_800, ANSWER_2000, ASK_ME_NEXT_TIME],
            {
                defaultAction: ASK_ME_NEXT_TIME,
                title: $msg("moduleCheckRemoteSize.titleDatabaseSizeNotify"),
                timeout: 40,
            }
        );
        if (ret == ANSWER_0) {
            await host.services.setting.applyPartial(
                {
                    notifyThresholdOfRemoteStorageSize: 0,
                },
                true
            );
        } else if (ret == ANSWER_800) {
            await host.services.setting.applyPartial(
                {
                    notifyThresholdOfRemoteStorageSize: 800,
                },
                true
            );
        } else if (ret == ANSWER_2000) {
            await host.services.setting.applyPartial(
                {
                    notifyThresholdOfRemoteStorageSize: 2000,
                },
                true
            );
        }
        return true;
    };
}
/**
 * Notify when the remote storage size exceed the threshold.
 * @returns true if the check is passed or user has chosen to ignore the warning, false to block subsequent processes.
 * @param host
 * @param log
 * @returns
 */
export function onNotifyRemoteSizeExceedFactory(
    host: NecessaryServices<"API" | "setting" | "replicator", "rebuilder">,
    log: ReturnType<typeof createInstanceLogFunction>
) {
    return async () => {
        if (host.services.API.isOnline === false) {
            log("Network is offline, skipping remote size exceed check.", LOG_LEVEL_INFO);
            return true;
        }
        const replicator = host.services.replicator.getActiveReplicator();
        const remoteStat = await replicator?.getRemoteStatus(host.services.setting.currentSettings());
        const settings = host.services.setting.currentSettings();
        if (!remoteStat) {
            // If we cannot get the remote status, we should not block subsequent processes.
            log("Failed to get remote status, skipping remote size exceed check.", LOG_LEVEL_INFO);
            return true;
        }
        const estimatedSize = remoteStat.estimatedSize;
        if (estimatedSize) {
            const maxSize = settings.notifyThresholdOfRemoteStorageSize * 1024 * 1024;
            if (estimatedSize <= maxSize) {
                log(
                    $msg("moduleCheckRemoteSize.logCurrentStorageSize", {
                        measuredSize: sizeToHumanReadable(estimatedSize),
                    }),
                    LOG_LEVEL_INFO
                );
                return true;
            }
            const message = $msg("moduleCheckRemoteSize.msgDatabaseGrowing", {
                estimatedSize: sizeToHumanReadable(estimatedSize),
                maxSize: sizeToHumanReadable(maxSize),
            });
            const newMax = ~~(estimatedSize / 1024 / 1024) + 100;
            const ANSWER_ENLARGE_LIMIT = $msg("moduleCheckRemoteSize.optionIncreaseLimit", {
                newMax: newMax.toString(),
            });
            const ANSWER_REBUILD = $msg("moduleCheckRemoteSize.optionRebuildAll");
            const ANSWER_IGNORE = $msg("moduleCheckRemoteSize.optionDismiss");
            const ret = await host.services.API.confirm.askSelectStringDialogue(
                message,
                [ANSWER_ENLARGE_LIMIT, ANSWER_REBUILD, ANSWER_IGNORE],
                {
                    defaultAction: ANSWER_IGNORE,
                    title: $msg("moduleCheckRemoteSize.titleDatabaseSizeLimitExceeded"),
                    timeout: 60,
                }
            );
            if (ret == ANSWER_REBUILD) {
                const ret = await host.services.API.confirm.askYesNoDialog(
                    $msg("moduleCheckRemoteSize.msgConfirmRebuild"),
                    { defaultOption: "No" }
                );
                if (ret == "yes") {
                    await host.services.setting.applyPartial(
                        {
                            notifyThresholdOfRemoteStorageSize: -1,
                        },
                        true
                    );
                    await host.serviceModules.rebuilder.scheduleRebuild();
                    //
                    return false;
                }
                return true;
            }
            if (ret == ANSWER_ENLARGE_LIMIT) {
                const newThreshold = ~~(estimatedSize / 1024 / 1024) + 100;
                log(
                    $msg("moduleCheckRemoteSize.logThresholdEnlarged", {
                        size: newThreshold.toString(),
                    }),
                    LOG_LEVEL_NOTICE
                );
                await host.services.setting.applyPartial(
                    {
                        notifyThresholdOfRemoteStorageSize: newThreshold,
                    },
                    true
                );
                return true;
            }
            // Dismiss or Close the dialog
            log(
                $msg("moduleCheckRemoteSize.logExceededWarning", {
                    measuredSize: sizeToHumanReadable(estimatedSize),
                    notifySize: sizeToHumanReadable(settings.notifyThresholdOfRemoteStorageSize * 1024 * 1024),
                }),
                LOG_LEVEL_INFO
            );
        }
        return true;
    };
}

/**
 * Scan the remote storage size and notify if it is not configured or exceed the threshold.
 * @param host The necessary services required for the operation.
 * @param log The logging function to use for logging messages.
 * @param resetThreshold Whether to reset the notification threshold before scanning. This is useful when you want to force the notification to show up again.
 * @returns A promise that resolves to true if all checks pass or user has configured the notification.
 */
export async function scanAllStat(
    host: NecessaryServices<"API" | "setting" | "replicator" | "appLifecycle", "rebuilder">,
    log: LogFunction,
    resetThreshold = false
) {
    if (resetThreshold) {
        await host.services.setting.applyPartial(
            {
                notifyThresholdOfRemoteStorageSize: -1,
            },
            true
        );
    }
    const onNotifyNotConfigured = onNotifyRemoteSizeNotConfiguredFactory(host, log);
    const onNotifyExceed = onNotifyRemoteSizeExceedFactory(host, log);
    return (await onNotifyNotConfigured()) && (await onNotifyExceed());
}

/**
 * Associate the remote storage size check feature with the app lifecycle events.
 * @param host
 */
export function useCheckRemoteSize(
    host: NecessaryServices<"API" | "setting" | "replicator" | "appLifecycle", "rebuilder">
) {
    const log = createInstanceLogFunction("SFCheckRemoteSize", host.services.API);
    host.services.appLifecycle.onScanningStartupIssues.addHandler(() => scanAllStat(host, log, false));
    host.services.appLifecycle.onInitialise.addHandler(() => {
        host.services.API.addCommand({
            id: "livesync-reset-remote-size-threshold-and-check",
            name: "Reset notification threshold and check the remote database usage",
            callback: async () => {
                await scanAllStat(host, log, true);
            },
        });
        eventHub.onEvent(EVENT_REQUEST_CHECK_REMOTE_SIZE, () => scanAllStat(host, log, true));
        return Promise.resolve(true);
    });
}
