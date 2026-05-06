import { LOG_LEVEL_INFO, LOG_LEVEL_NOTICE } from "octagonal-wheels/common/logger";
import { type NecessaryServices } from "../interfaces/ServiceModule";
import type { SharedConfigDocument } from "../common/models/sharedConfig.type";
import {
    AutoConfigSyncableKeys,
    type AutoConfigSyncableKey,
    type ObsidianLiveSyncSettings,
} from "../common/models/setting.type";
import { SHARED_CONFIG_DOCID } from "../common/models/db.const";
import { createInstanceLogFunction, type LogFunction } from "../services/lib/logUtils";
import { $msg } from "../common/i18n";

/**
 * Extracts the target settings from the current settings.
 */
export function extractSharedSettings(
    settings: ObsidianLiveSyncSettings
): Pick<ObsidianLiveSyncSettings, AutoConfigSyncableKey> {
    const shared: Partial<Pick<ObsidianLiveSyncSettings, AutoConfigSyncableKey>> = {};
    for (const key of AutoConfigSyncableKeys) {
        shared[key] = settings[key] as any;
    }
    return shared as Pick<ObsidianLiveSyncSettings, AutoConfigSyncableKey>;
}

/**
 * Checks if the local settings differ from the remote settings.
 */
export function hasSharedSettingsDifferences(
    localSettings: Pick<ObsidianLiveSyncSettings, AutoConfigSyncableKey>,
    remoteSettings: Pick<ObsidianLiveSyncSettings, AutoConfigSyncableKey>
): boolean {
    for (const key of AutoConfigSyncableKeys) {
        if (localSettings[key] !== remoteSettings[key]) {
            return true;
        }
    }
    return false;
}

/**
 * Fetches the shared configuration from the specific logic database.
 */
export async function fetchSharedConfig(
    dbService: NecessaryServices<"database", never>["services"]["database"],
    log?: LogFunction
): Promise<SharedConfigDocument | null> {
    try {
        const db = dbService.localDatabase;
        if (!db) {
            return null;
        }
        const doc = await db.getDB().get<SharedConfigDocument>(SHARED_CONFIG_DOCID);
        if (doc && doc.type === "shared_config") {
            return doc;
        }
        return null;
    } catch (ex: any) {
        if (ex.status !== 404) {
            log?.(`Failed to fetch shared configuration: ${ex.message}`, LOG_LEVEL_INFO);
        }
        return null;
    }
}

/**
 * Writes the current settings to the shared configuration on the local database (which syncs to couchdb).
 */
export async function writeSharedConfig(
    dbService: NecessaryServices<"database", never>["services"]["database"],
    settings: Pick<ObsidianLiveSyncSettings, AutoConfigSyncableKey>,
    log?: LogFunction
): Promise<boolean> {
    try {
        const db = dbService.localDatabase;
        if (!db) {
            log?.("Database not ready.", LOG_LEVEL_NOTICE);
            return false;
        }

        const currentSharedConfig = await fetchSharedConfig(dbService, log);

        const newDoc: SharedConfigDocument = {
            _id: SHARED_CONFIG_DOCID,
            _rev: currentSharedConfig?._rev,
            version: Date.now(),
            type: "shared_config",
            settings,
        };

        await db.putRaw(newDoc as any);
        log?.("Shared configuration saved to database.", LOG_LEVEL_NOTICE);
        return true;
    } catch (ex: any) {
        log?.(`Failed to write shared configuration: ${ex.message}`, LOG_LEVEL_NOTICE);
        return false;
    }
}

/**
 * Applies the auto configuration if needed.
 * Disables DB, saves settings and re-opens DB if modifications were applied.
 */
export async function applyAutoConfigurationIfNeeded(
    host: NecessaryServices<"setting" | "database", never>,
    log?: LogFunction
): Promise<boolean> {
    if (!host.services.setting.settings.useAutoConfig) {
        return false;
    }

    const sharedConfig = await fetchSharedConfig(host.services.database, log);
    if (!sharedConfig) {
        return false;
    }

    const localShared = extractSharedSettings(host.services.setting.settings);
    if (hasSharedSettingsDifferences(localShared, sharedConfig.settings)) {
        // Apply settings
        const settings = host.services.setting.settings;
        for (const key of AutoConfigSyncableKeys) {
            (settings as any)[key] = sharedConfig.settings[key];
        }
        await host.services.setting.saveSettings();
        log?.("Shared configuration applied from remote database.", LOG_LEVEL_NOTICE);

        // Wait for DB ready and restart required features
        await host.services.database.reopenDatabase();
        return true;
    }
    return false;
}

/**
 * Enables Auto Configuration with an initialization flow from the UI.
 */
export async function enableAutoConfigurationInteractive(
    host: NecessaryServices<"setting" | "database" | "UI", never>,
    log?: LogFunction
): Promise<boolean> {
    const sharedConfig = await fetchSharedConfig(host.services.database, log);
    const localShared = extractSharedSettings(host.services.setting.settings);

    if (sharedConfig) {
        // Remote config exists
        if (hasSharedSettingsDifferences(localShared, sharedConfig.settings)) {
            // Different! Ask user.
            const overridesLocal = await host.services.UI.confirm.askYesNoDialog(
                $msg("SharedConfig.promptRemoteFoundTitle"),
                $msg("SharedConfig.promptRemoteFoundDesc")
            );
            if (overridesLocal === "yes") {
                host.services.setting.settings.useAutoConfig = true;
                // Apply
                for (const key of AutoConfigSyncableKeys) {
                    (host.services.setting.settings as any)[key] = sharedConfig.settings[key];
                }
                await host.services.setting.saveSettings();
                log?.("Auto Configuration Enabled. Applied Remote settings.", LOG_LEVEL_NOTICE);
                await host.services.database.reopenDatabase();
                return true;
            } else {
                return false;
            }
        } else {
            // Same, just enable
            host.services.setting.settings.useAutoConfig = true;
            await host.services.setting.saveSettings();
            return true;
        }
    } else {
        // No remote config found. Ask to initialize.
        const uploadLocal = await host.services.UI.confirm.askYesNoDialog(
            $msg("SharedConfig.promptNoRemoteTitle"),
            $msg("SharedConfig.promptNoRemoteDesc")
        );
        if (uploadLocal === "yes") {
            host.services.setting.settings.useAutoConfig = true;
            await host.services.setting.saveSettings();
            await writeSharedConfig(host.services.database, localShared, log);
            log?.("Auto Configuration Enabled. Local settings uploaded as master.", LOG_LEVEL_NOTICE);
            return true;
        } else {
            return false;
        }
    }
}

/**
 * Service hook generator for the Shared Config feature.
 * Automatically wires up into DB Sync and Settings Save events.
 */
export function useSharedConfigFeature(host: NecessaryServices<"setting" | "database" | "replication", never>): void {
    const log = createInstanceLogFunction("SharedConfigFeature", host.services.setting);

    host.services.setting.onSettingSaved.addHandler(async () => {
        if (!host.services.setting.settings.useAutoConfig) {
            return;
        }

        const currentSharedConfig = await fetchSharedConfig(host.services.database, log);
        const localShared = extractSharedSettings(host.services.setting.settings);

        if (!currentSharedConfig || hasSharedSettingsDifferences(localShared, currentSharedConfig.settings)) {
            log("Settings changed. Uploading new efficiency settings to the remote database.", LOG_LEVEL_INFO);
            await writeSharedConfig(host.services.database, localShared, log);
        }
    });

    host.services.replication.onBeforeReplicate.addHandler(async (_showMessage: boolean) => {
        if (!host.services.setting.settings.useAutoConfig) {
            return true;
        }
        const applied = await applyAutoConfigurationIfNeeded(host, log);
        if (applied) {
            log(
                "Settings were updated from the remote database. Replication will commence on the next cycle.",
                LOG_LEVEL_NOTICE
            );
            return false; // Stop current replication since DB is reopening
        }
        return true;
    });
}

/**
 * Triggers the Auto Configuration flow from UI components.
 */
export async function triggerEnableAutoConfiguration(
    host: NecessaryServices<"setting" | "database" | "UI", never>
): Promise<boolean> {
    return await enableAutoConfigurationInteractive(
        host,
        createInstanceLogFunction("SharedConfigUI", host.services.setting)
    );
}
