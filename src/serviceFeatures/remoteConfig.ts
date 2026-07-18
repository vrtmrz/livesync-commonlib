import { LOG_LEVEL_NOTICE, LOG_LEVEL_VERBOSE, type LOG_LEVEL } from "@lib/common/logger";
import { ConnectionStringParser, type RemoteConfigurationResult } from "@lib/common/ConnectionString";
import type { ObsidianLiveSyncSettings, RemoteConfiguration, RemoteDBSettings } from "@lib/common/models/setting.type";
import { REMOTE_COUCHDB, REMOTE_MINIO, REMOTE_P2P } from "@lib/common/models/setting.const";
import type { NecessaryServices } from "@lib/interfaces/ServiceModule";
import { createInstanceLogFunction } from "@lib/services/lib/logUtils";

export type RemoteConfigHost = NecessaryServices<
    "setting" | "UI" | "replication" | "control" | "appLifecycle" | "API",
    never
>;

export function migrateLegacyRemoteConfigurationsInPlace(
    settings: ObsidianLiveSyncSettings,
    log?: (message: string, level?: LOG_LEVEL) => void
): boolean {
    const hasText = (value: unknown): value is string => typeof value === "string" && value.trim() !== "";

    if (!settings.remoteConfigurations) {
        settings.remoteConfigurations = {};
    }

    if (Object.keys(settings.remoteConfigurations).length !== 0) {
        return false;
    }

    const hasCouchDB = hasText(settings.couchDB_URI);
    const hasS3 = hasText(settings.endpoint);
    const hasP2P = hasText(settings.P2P_roomID);

    if (!hasCouchDB && !hasS3 && !hasP2P) {
        return false;
    }

    log?.("Migrating existing remote configuration to sls+ format...");

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
            log?.(`Failed to migrate ${candidate.type} configuration!`);
            log?.(e as string, LOG_LEVEL_VERBOSE);
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
    return true;
}

/**
 * Generate a unique ID for a new remote configuration.
 * @returns A unique string identifier.
 */
export function createRemoteConfigurationId(): string {
    return `remote-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export type SerializableRemoteConfigurationType = Exclude<RemoteConfigurationResult["type"], "webdav">;

export interface UpsertRemoteConfigurationOptions {
    /**
     * Reuse this identifier to update a known profile. Omit it to allocate a new opaque identifier.
     */
    id?: string;
    /**
     * User-visible name. Omit it to derive a descriptive name from the connection settings.
     */
    name?: string;
    /**
     * Select this profile as the main remote and project it onto the compatibility fields.
     */
    activate?: boolean;
    /**
     * Select this profile for P2P features without changing the main remote selection.
     */
    activateForP2P?: boolean;
}

function toRemoteConfigurationResult(
    type: SerializableRemoteConfigurationType,
    settings: ObsidianLiveSyncSettings
): RemoteConfigurationResult {
    if (type === "couchdb") {
        return { type, settings };
    }
    if (type === "s3") {
        return { type, settings };
    }
    return { type, settings };
}

/**
 * Suggest a concise display name from a serialisable remote configuration.
 *
 * The name is presentation only. Callers must continue to use the profile ID for identity and
 * `activeConfigurationId` for the selected main remote.
 */
export function suggestRemoteConfigurationName(configuration: RemoteConfigurationResult): string {
    if (configuration.type === "couchdb") {
        try {
            const host = new URL(configuration.settings.couchDB_URI).host;
            return host ? `CouchDB ${host}` : "CouchDB remote";
        } catch {
            return "CouchDB remote";
        }
    }
    if (configuration.type === "s3") {
        const bucket = configuration.settings.bucket.trim();
        if (bucket) {
            return `S3 ${bucket}`;
        }
        try {
            const host = new URL(configuration.settings.endpoint).host;
            return host ? `S3 ${host}` : "Object Storage remote";
        } catch {
            return "Object Storage remote";
        }
    }
    if (configuration.type === "p2p") {
        const room = configuration.settings.P2P_roomID.trim();
        return room ? `P2P ${room}` : "P2P remote";
    }
    return "Remote configuration";
}

function allocateRemoteConfigurationId(configurations: Record<string, RemoteConfiguration>): string {
    let id = createRemoteConfigurationId();
    while (configurations[id]) {
        id = createRemoteConfigurationId();
    }
    return id;
}

function allocateRemoteConfigurationName(
    configurations: Record<string, RemoteConfiguration>,
    baseName: string,
    updatingId?: string
): string {
    const usedNames = new Set(
        Object.values(configurations)
            .filter((configuration) => configuration.id !== updatingId)
            .map((configuration) => configuration.name)
    );
    if (!usedNames.has(baseName)) {
        return baseName;
    }
    let suffix = 2;
    while (usedNames.has(`${baseName} (${suffix})`)) {
        suffix += 1;
    }
    return `${baseName} (${suffix})`;
}

/**
 * Create or update a multiple-remote profile from the corresponding compatibility fields.
 *
 * This mutates `settings`. Passing an existing `id` intentionally replaces that profile; omitting
 * it always allocates a new opaque ID and preserves all existing profiles. Generated display names
 * are made unique for readability, but names never act as identifiers. The stored connection URI is
 * plaintext at this boundary; `SettingService` applies configured at-rest encryption when saving it.
 */
export function upsertRemoteConfigurationInPlace(
    settings: ObsidianLiveSyncSettings,
    type: SerializableRemoteConfigurationType,
    options: UpsertRemoteConfigurationOptions = {}
): RemoteConfiguration {
    if (options.activateForP2P && type !== "p2p") {
        throw new Error("Only a P2P remote configuration can be selected for P2P features.");
    }
    const configurations = settings.remoteConfigurations ?? {};
    const requestedId = options.id?.trim();
    const id = requestedId || allocateRemoteConfigurationId(configurations);
    const existing = configurations[id];
    const serialisable = toRemoteConfigurationResult(type, settings);
    const suggestedName = suggestRemoteConfigurationName(serialisable);
    const requestedName = options.name?.trim();
    const name =
        requestedName || existing?.name || allocateRemoteConfigurationName(configurations, suggestedName, existing?.id);

    const configuration: RemoteConfiguration = {
        id,
        name,
        uri: ConnectionStringParser.serialize(serialisable),
        isEncrypted: false,
    };
    settings.remoteConfigurations ??= configurations;
    configurations[id] = configuration;

    if (options.activate) {
        if (!activateRemoteConfiguration(settings, id)) {
            throw new Error(`Failed to activate remote configuration '${id}'.`);
        }
    }
    if (options.activateForP2P) {
        if (!activateP2PRemoteConfiguration(settings, id)) {
            throw new Error(`Failed to activate P2P remote configuration '${id}'.`);
        }
    }
    return configuration;
}

/**
 * Keep compatibility for users who were already using P2P as their main active remote.
 */
export function migrateP2PActiveRemoteConfigurationIdInPlace(settings: ObsidianLiveSyncSettings): boolean {
    if ((settings.P2P_ActiveRemoteConfigurationId ?? "").trim() !== "") {
        return false;
    }
    const activeId = settings.activeConfigurationId;
    if (!activeId) {
        return false;
    }
    const config = settings.remoteConfigurations?.[activeId];
    if (!config) {
        return false;
    }
    if (settings.remoteType !== REMOTE_P2P) {
        return false;
    }
    try {
        const parsed = ConnectionStringParser.parse(config.uri);
        if (parsed.type !== "p2p") {
            return false;
        }
    } catch {
        return false;
    }
    settings.P2P_ActiveRemoteConfigurationId = activeId;
    return true;
}

/**
 * SF:RemoteConfig - Service Feature for Remote Configuration Management
 */

/**
 * Migrates existing flat settings to the new multiple remote configurations list.
 */
export async function migrateToMultipleRemoteConfigurations(host: RemoteConfigHost): Promise<boolean> {
    const log = createInstanceLogFunction("SF:RemoteConfig", host.services.API);
    const settings = host.services.setting.currentSettings();
    if (migrateLegacyRemoteConfigurationsInPlace(settings, log)) {
        await host.services.setting.saveSettingData();
        log(`Successfully migrated ${Object.keys(settings.remoteConfigurations).length} remote configuration(s).`);
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
 * Apply a dedicated P2P remote configuration onto runtime P2P-related fields,
 * while keeping the current `remoteType` unchanged.
 */
export function activateP2PRemoteConfiguration(
    settings: ObsidianLiveSyncSettings,
    id: string
): ObsidianLiveSyncSettings | false {
    const config = settings.remoteConfigurations?.[id];
    if (!config) return false;

    try {
        const parsed = ConnectionStringParser.parse(config.uri);
        if (parsed.type !== "p2p") {
            return false;
        }
        const currentRemoteType = settings.remoteType;
        settings.P2P_ActiveRemoteConfigurationId = id;
        Object.assign(settings, parsed.settings);
        settings.remoteType = currentRemoteType;
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
                host.services.API.addLog(
                    `Failed to parse remote! Detailed information is available in verbose logs.`,
                    LOG_LEVEL_NOTICE,
                    "remote-config"
                );
                host.services.API.addLog(e, LOG_LEVEL_VERBOSE, "remote-config");
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
            host.services.API.addLog(
                `Migration failed! Detailed information is available in verbose logs.`,
                LOG_LEVEL_NOTICE,
                "remote-config"
            );
            host.services.API.addLog(e, LOG_LEVEL_VERBOSE, "remote-config");
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
