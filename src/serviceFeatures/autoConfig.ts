import { LOG_LEVEL_INFO, LOG_LEVEL_NOTICE, LOG_LEVEL_VERBOSE } from "@lib/common/types";
import { extractObject, isObjectDifferent } from "@lib/common/utils";
import { createInstanceLogFunction, type LogFunction } from "@lib/services/lib/logUtils";
import type { NecessaryServices } from "@lib/interfaces/ServiceModule";
import { EVENT_AUTO_CONFIG_KEYS_CHANGED, EVENT_SETTINGS_IMPORTED } from "@lib/events/coreEvents";
import { eventHub } from "@lib/hub/hub";
import { AutoConfigEfficiencyTemplate } from "@lib/common/models/tweak.definition";
import {
    TWEAK_OVERWRITE_STRATEGY_ACCEPT_REMOTE,
    TWEAK_OVERWRITE_STRATEGY_ASK,
    TWEAK_OVERWRITE_STRATEGY_OVERWRITE_REMOTE,
} from "@lib/common/models/setting.type";

type AutoConfigHost = NecessaryServices<"API" | "setting" | "replicator" | "replication" | "appLifecycle", never>;

/**
 * Check if `handleFilenameCaseSensitive` matches between local and remote PREFERRED.
 * Returns false (blocks replication) with a Notice if they differ.
 */
async function checkCaseSensitivityMismatch(host: AutoConfigHost, log: LogFunction): Promise<boolean> {
    const settings = host.services.setting.currentSettings();
    const replicator = host.services.replicator.getActiveReplicator();
    if (!replicator) return true;

    const remotePREFERRED = await replicator.getRemotePreferredTweakValues(settings);
    if (!remotePREFERRED) return true; // No PREFERRED yet — let autoConfig write it

    if (settings.handleFilenameCaseSensitive !== remotePREFERRED.handleFilenameCaseSensitive) {
        log(
            `Synchronisation blocked: The "handleFilenameCaseSensitive" setting on this device (${settings.handleFilenameCaseSensitive}) does not match the remote preferred setting (${remotePREFERRED.handleFilenameCaseSensitive}). Please check Settings → Advanced → Filename case sensitivity.`,
            LOG_LEVEL_NOTICE
        );
        return false;
    }
    return true;
}

/**
 * Core reconciliation logic for efficiency-affecting tweak settings.
 *
 * Decision tree:
 * - No remote PREFERRED → write local as master (all flag values)
 * - No diff → clear flag silently
 * - flag=0/undef + diff → accept remote
 * - flag=127 + diff → overwrite remote unconditionally
 * - flag=1 + diff → ask user (showMessage=false → keep flag, skip dialog)
 */
export async function checkAndReconcileEfficiencySettings(
    host: AutoConfigHost,
    log: LogFunction,
    showMessage: boolean
): Promise<boolean> {
    const settings = host.services.setting.currentSettings();
    const flag = settings.tweakOverwriteStrategy;

    const localEfficiency = extractObject(AutoConfigEfficiencyTemplate, settings);

    const replicator = host.services.replicator.getActiveReplicator();
    if (!replicator) {
        log("No active replicator found. Skipping efficiency settings reconciliation.", LOG_LEVEL_INFO);
        return true;
    }

    const remotePREFERRED = await replicator.getRemotePreferredTweakValues(settings);

    if (!remotePREFERRED) {
        // No PREFERRED on remote → write local as master
        log(
            "No preferred settings found on the remote. Registering this device's efficiency settings as the preferred.",
            LOG_LEVEL_NOTICE
        );
        await replicator.setPreferredRemoteTweakSettings(settings);
        if (flag !== TWEAK_OVERWRITE_STRATEGY_ACCEPT_REMOTE) {
            await host.services.setting.applyPartial(
                { tweakOverwriteStrategy: TWEAK_OVERWRITE_STRATEGY_ACCEPT_REMOTE },
                true
            );
        }
        return true;
    }

    const remoteEfficiency = extractObject(AutoConfigEfficiencyTemplate, remotePREFERRED);
    const hasDiff = isObjectDifferent(localEfficiency, remoteEfficiency);

    if (!hasDiff) {
        // In sync — clear flag silently
        if (flag !== TWEAK_OVERWRITE_STRATEGY_ACCEPT_REMOTE && flag !== undefined) {
            await host.services.setting.applyPartial(
                { tweakOverwriteStrategy: TWEAK_OVERWRITE_STRATEGY_ACCEPT_REMOTE },
                true
            );
        }
        log("Efficiency settings are in sync with the remote.", LOG_LEVEL_VERBOSE);
        return true;
    }

    // Settings differ
    if (flag === TWEAK_OVERWRITE_STRATEGY_OVERWRITE_REMOTE) {
        // Unconditional overwrite
        log("Overwriting remote efficiency settings with this device's settings.", LOG_LEVEL_NOTICE);
        await replicator.setPreferredRemoteTweakSettings(settings);
        await host.services.setting.applyPartial(
            { tweakOverwriteStrategy: TWEAK_OVERWRITE_STRATEGY_ACCEPT_REMOTE },
            true
        );
        return true;
    }

    if (flag === TWEAK_OVERWRITE_STRATEGY_ACCEPT_REMOTE || flag === undefined) {
        // Accept remote
        log(
            "Remote efficiency settings have been applied to this device. Performance may be slightly less efficient.",
            LOG_LEVEL_NOTICE
        );
        await host.services.setting.applyPartial(
            { ...remoteEfficiency, tweakOverwriteStrategy: TWEAK_OVERWRITE_STRATEGY_ACCEPT_REMOTE },
            true
        );
        return true;
    }

    if (flag === TWEAK_OVERWRITE_STRATEGY_ASK) {
        if (!showMessage) {
            // Quiet mode — keep flag, reconcile later
            log(
                "Efficiency settings reconciliation is pending. It will be checked on the next synchronisation.",
                LOG_LEVEL_INFO
            );
            return true;
        }

        const CHOICE_USE_LOCAL = "Update remote with this device's settings";
        const CHOICE_USE_REMOTE = "Accept remote settings";
        const answer = await host.services.API.confirm.askSelectStringDialogue(
            "The chunk efficiency settings on this device differ from the remote preferred settings. Which should take priority?",
            [CHOICE_USE_LOCAL, CHOICE_USE_REMOTE],
            {
                defaultAction: CHOICE_USE_REMOTE,
                title: "Chunk Settings Reconciliation",
                timeout: 40,
            }
        );

        if (answer === CHOICE_USE_LOCAL) {
            await replicator.setPreferredRemoteTweakSettings(settings);
            await host.services.setting.applyPartial(
                { tweakOverwriteStrategy: TWEAK_OVERWRITE_STRATEGY_ACCEPT_REMOTE },
                true
            );
            log("Remote efficiency settings have been updated with this device's settings.", LOG_LEVEL_NOTICE);
        } else if (answer === CHOICE_USE_REMOTE) {
            await host.services.setting.applyPartial(
                { ...remoteEfficiency, tweakOverwriteStrategy: TWEAK_OVERWRITE_STRATEGY_ACCEPT_REMOTE },
                true
            );
            log("Remote efficiency settings have been applied to this device.", LOG_LEVEL_NOTICE);
        } else {
            // Timeout or cancelled (offline)
            log(
                "Could not communicate with the remote. The settings will be reconciled on the next connection.",
                LOG_LEVEL_NOTICE
            );
            // Keep flag=1
        }
        return true;
    }

    return true;
}

/**
 * Show a 3-choice dialog after settings are imported from a QR code or URI.
 * Sets `tweakOverwriteStrategy` according to the user's choice.
 */
export async function askImportedSettingsStrategy(host: AutoConfigHost, log: LogFunction): Promise<void> {
    const CHOICE_LOCAL_MASTER = "Overwrite remote with these settings";
    const CHOICE_CHECK = "Check consistency with remote";
    const CHOICE_REMOTE_WINS = "Accept remote settings";

    const answer = await host.services.API.confirm.askSelectStringDialogue(
        "How should the chunk efficiency settings be reconciled with the remote after importing these settings?",
        [CHOICE_LOCAL_MASTER, CHOICE_CHECK, CHOICE_REMOTE_WINS],
        {
            defaultAction: CHOICE_CHECK,
            title: "Reconciliation Policy After Settings Import",
            timeout: 60,
        }
    );

    if (answer === CHOICE_LOCAL_MASTER) {
        await host.services.setting.applyPartial(
            { tweakOverwriteStrategy: TWEAK_OVERWRITE_STRATEGY_OVERWRITE_REMOTE },
            true
        );
        log(
            "Remote settings will be overwritten with this device's settings on the next synchronisation.",
            LOG_LEVEL_NOTICE
        );
    } else if (answer === CHOICE_CHECK) {
        await host.services.setting.applyPartial({ tweakOverwriteStrategy: TWEAK_OVERWRITE_STRATEGY_ASK }, true);
        log("Efficiency settings will be checked against the remote on the next synchronisation.", LOG_LEVEL_NOTICE);
    } else {
        // CHOICE_REMOTE_WINS or timeout
        await host.services.setting.applyPartial(
            { tweakOverwriteStrategy: TWEAK_OVERWRITE_STRATEGY_ACCEPT_REMOTE },
            true
        );
        log("Remote efficiency settings will be accepted on the next synchronisation.", LOG_LEVEL_NOTICE);
    }
}

/**
 * Register auto-configuration handlers for efficiency-affecting tweak settings.
 *
 * - Registers a `onBeforeReplicate` handler (priority 110) that reconciles efficiency settings.
 * - Listens to `EVENT_AUTO_CONFIG_KEYS_CHANGED` to set flag=1 when the user changes efficiency keys.
 * - Listens to `EVENT_SETTINGS_IMPORTED` to show a 3-choice dialog after QR/URI import.
 */
export function useAutoConfig(host: AutoConfigHost) {
    const log = createInstanceLogFunction("SFAutoConfig", host.services.API);

    host.services.appLifecycle.onInitialise.addHandler(() => {
        // --- onBeforeReplicate handler ---
        host.services.replication.onBeforeReplicate.addHandler(async (showMessage: boolean) => {
            // 1. Fatal block: handleFilenameCaseSensitive mismatch
            if (!(await checkCaseSensitivityMismatch(host, log))) {
                return false;
            }
            // 2. Efficiency key reconciliation
            return checkAndReconcileEfficiencySettings(host, log, showMessage);
        }, 110);

        // --- Efficiency key change listener ---
        eventHub.onEvent(EVENT_AUTO_CONFIG_KEYS_CHANGED, async (keys) => {
            log(
                `Efficiency settings changed: ${keys.join(", ")}. They will be reconciled with the remote on the next synchronisation.`,
                LOG_LEVEL_INFO
            );
            await host.services.setting.applyPartial({ tweakOverwriteStrategy: TWEAK_OVERWRITE_STRATEGY_ASK }, true);
        });

        // --- Settings imported listener (QR/URI import) ---
        eventHub.onEvent(EVENT_SETTINGS_IMPORTED, () => {
            // Show 3-choice dialog asynchronously (do not block the import flow)
            void askImportedSettingsStrategy(host, log);
        });

        return Promise.resolve(true);
    });
}
