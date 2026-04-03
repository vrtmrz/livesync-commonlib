import { LOG_LEVEL_NOTICE } from "../common/logger";
import { ConnectionStringParser } from "../common/ConnectionString";
import type { ObsidianLiveSyncSettings, RemoteConfiguration, RemoteDBSettings } from "../common/models/setting.type";
import { REMOTE_COUCHDB, REMOTE_MINIO, REMOTE_P2P } from "../common/models/setting.const";
import type { NecessaryServices } from "../interfaces/ServiceModule";
import { createInstanceLogFunction } from "../services/lib/logUtils";

export type RemoteConfigHost = NecessaryServices<
    "setting" | "UI" | "replication" | "control" | "appLifecycle" | "API",
    never
>;

/**
 * SF:RemoteConfig - Service Feature for Remote Configuration Management
 */

/**
 * Migrates existing flat settings to the new multiple remote configurations list.
 */
export async function migrateToMultipleRemoteConfigurations(host: RemoteConfigHost): Promise<boolean> {
    const log = createInstanceLogFunction("SF:RemoteConfig", host.services.API);
    const settings = host.services.setting.currentSettings();
    const hasText = (value: unknown): value is string => typeof value === "string" && value.trim() !== "";

    if (!settings.remoteConfigurations) {
        settings.remoteConfigurations = {};
    }

    if (Object.keys(settings.remoteConfigurations).length === 0) {
        const hasCouchDB = hasText(settings.couchDB_URI);
        const hasS3 = hasText(settings.endpoint);
        const hasP2P = hasText(settings.P2P_roomID);

        if (!hasCouchDB && !hasS3 && !hasP2P) {
            return false;
        }

        log("Migrating existing remote configuration to sls+ format...");

        const candidates: Array<{ id: string; name: string; type: "couchdb" | "s3" | "p2p"; enabled: boolean }> = [
            { id: "legacy-couchdb", name: "CouchDB Remote", type: "couchdb", enabled: hasCouchDB },
            { id: "legacy-s3", name: "S3 Remote", type: "s3", enabled: hasS3 },
            { id: "legacy-p2p", name: "P2P Remote", type: "p2p", enabled: hasP2P },
        ];

        for (const candidate of candidates) {
            if (!candidate.enabled) continue;
            try {
                const uri = ConnectionStringParser.serialize({
                    type: candidate.type,
                    settings: settings as RemoteDBSettings,
                });
                settings.remoteConfigurations[candidate.id] = {
                    id: candidate.id,
                    name: candidate.name,
                    uri,
                    isEncrypted: false,
                };
            } catch (e) {
                log(`Failed to migrate ${candidate.type} configuration: ${e}`);
            }
        }

        const createdIds = Object.keys(settings.remoteConfigurations);
        if (createdIds.length === 0) {
            return false;
        }

        const preferredId =
            settings.remoteType === REMOTE_MINIO
                ? "legacy-s3"
                : settings.remoteType === REMOTE_P2P
                  ? "legacy-p2p"
                  : "legacy-couchdb";
        settings.activeConfigurationId = settings.remoteConfigurations[preferredId] ? preferredId : createdIds[0];

        await host.services.setting.saveSettingData();
        log(`Successfully migrated ${createdIds.length} remote configuration(s).`);
        return true;
    }
    return false;
}

/**
 * Logic to switch the active configuration.
 */
export function activateRemoteConfiguration(
    settings: ObsidianLiveSyncSettings,
    id: string
): ObsidianLiveSyncSettings | false {
    const config = settings.remoteConfigurations?.[id];
    if (!config) return false;

    settings.activeConfigurationId = id;

    try {
        const parsed = ConnectionStringParser.parse(config.uri);
        // Apply to legacy fields
        if (parsed.type === "couchdb") {
            settings.remoteType = REMOTE_COUCHDB;
            Object.assign(settings, parsed.settings);
        } else if (parsed.type === "s3") {
            settings.remoteType = REMOTE_MINIO;
            Object.assign(settings, parsed.settings);
        } else if (parsed.type === "p2p") {
            settings.remoteType = REMOTE_P2P;
            Object.assign(settings, parsed.settings);
        }
        return settings;
    } catch {
        return false;
    }
}

/**
 * Command: Switch Active Remote
 */
export async function commandSwitchActiveRemote(host: RemoteConfigHost): Promise<void> {
    const settings = host.services.setting.currentSettings();
    const configs = settings.remoteConfigurations;
    if (!configs || Object.keys(configs).length === 0) {
        host.services.API.addLog("No remote configurations found.", LOG_LEVEL_NOTICE, "remote-config");
        return;
    }

    const options = Object.values(configs).map((c: RemoteConfiguration) => ({
        label: `${c.name} (${c.id === settings.activeConfigurationId ? "Active" : "Inactive"})`,
        value: c.id,
    }));

    const selectedLabel = await host.services.UI.confirm.askSelectString(
        "Select a remote configuration to activate",
        options.map((o: { label: string }) => o.label)
    );

    if (selectedLabel) {
        const actualId = options.find((o: { label: string; value: string }) => o.label === selectedLabel)?.value;
        if (actualId) {
            let updated = false;
            await host.services.setting.updateSettings((currentSettings) => {
                const activated = activateRemoteConfiguration(currentSettings, actualId);
                if (activated) {
                    updated = true;
                    return activated;
                }
                return currentSettings;
            });
            if (updated) {
                host.services.API.addLog(`Switched to remote: ${selectedLabel}`, LOG_LEVEL_NOTICE, "remote-config");
                // control.applySettings may not necessarily trigger replication immediately.
                await host.services.control.applySettings();
                await host.services.setting.saveSettingData();
            }
        }
    }
}

/**
 * Command: Replicate with specific remote
 */
export async function commandReplicateWithSpecificRemote(host: RemoteConfigHost): Promise<void> {
    const settings = host.services.setting.currentSettings();
    const configs = settings.remoteConfigurations;
    if (!configs || Object.keys(configs).length === 0) {
        host.services.API.addLog("No remote configurations found.", LOG_LEVEL_NOTICE, "remote-config");
        return;
    }

    const selectedName = await host.services.UI.confirm.askSelectString(
        "Select a remote to replicate with",
        Object.values(configs).map((c: RemoteConfiguration) => c.name)
    );

    if (selectedName) {
        const config = Object.values(configs).find((c: RemoteConfiguration) => c.name === selectedName);
        if (config) {
            try {
                let updated = false;
                await host.services.setting.updateSettings((currentSettings) => {
                    const activated = activateRemoteConfiguration(currentSettings, config.id);
                    if (activated) {
                        updated = true;
                        return activated;
                    }
                    return currentSettings;
                });
                if (updated) {
                    host.services.API.addLog(
                        `Switched to remote: ${selectedName} and starting replication...`,
                        LOG_LEVEL_NOTICE,
                        "remote-config"
                    );
                    await host.services.control.applySettings();
                    await host.services.setting.saveSettingData();
                    await host.services.replication.replicate(true);
                }
            } catch (e) {
                host.services.API.addLog(`Failed to parse remote: ${e}`, LOG_LEVEL_NOTICE, "remote-config");
            }
        }
    }
}

/**
 * Migration feature to be used during initialisation.
 */
export function useRemoteConfigurationMigration(host: RemoteConfigHost) {
    host.services.appLifecycle.onSettingLoaded.addHandler(async () => {
        try {
            await migrateToMultipleRemoteConfigurations(host);
        } catch (e) {
            host.services.API.addLog(`Migration failed: ${e}`, LOG_LEVEL_NOTICE, "remote-config");
        }
        return true;
    });
}

/**
 * Hook to set up remote configuration features (Commands).
 */
export function useRemoteConfiguration(host: RemoteConfigHost) {
    // Register commands
    host.services.API.addCommand({
        id: "livesync-switch-remote",
        name: "Switch Active Remote",
        callback: () => commandSwitchActiveRemote(host),
    });

    host.services.API.addCommand({
        id: "livesync-replicate-with-specific",
        name: "Replicate with specific remote",
        callback: () => commandReplicateWithSpecificRemote(host),
    });

    return true;
}
