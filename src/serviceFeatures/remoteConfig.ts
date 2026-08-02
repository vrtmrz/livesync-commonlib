import { LOG_LEVEL_NOTICE, LOG_LEVEL_VERBOSE, type LOG_LEVEL } from "@lib/common/logger";
import { ConnectionStringParser, type RemoteConfigurationResult } from "@lib/common/ConnectionString";
import type { ObsidianLiveSyncSettings, RemoteConfiguration } from "@lib/common/models/setting.type";
import { REMOTE_P2P } from "@lib/common/models/setting.const";
import { resolveJournalProtocolOptionsV1 } from "@lib/common/models/journalProtocol.ts";
import {
    defaultRemoteProviderRegistry,
    type BuiltInRemoteConfiguration,
} from "@lib/common/remoteProviders/defaultRemoteProviderRegistry.ts";
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
    if (!settings.remoteConfigurations) {
        settings.remoteConfigurations = {};
    }

    if (Object.keys(settings.remoteConfigurations).length !== 0) {
        return false;
    }

    const candidates = defaultRemoteProviderRegistry
        .providerSummaries()
        .filter((provider) => defaultRemoteProviderRegistry.hasConfiguration(provider.type, settings));
    if (candidates.length === 0) return false;

    log?.("Migrating existing remote configuration to sls+ format...");

    for (const candidate of candidates) {
        try {
            const configuration = defaultRemoteProviderRegistry.configurationFromSettings(candidate.type, settings);
            const uri = defaultRemoteProviderRegistry.serialise(configuration);
            settings.remoteConfigurations[candidate.legacyProfileId] = {
                id: candidate.legacyProfileId,
                name: candidate.legacyProfileName,
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

    const preferredType = defaultRemoteProviderRegistry.typeForRemoteType(settings.remoteType);
    const preferredId = candidates.find((candidate) => candidate.type === preferredType)?.legacyProfileId;
    settings.activeConfigurationId =
        preferredId && settings.remoteConfigurations[preferredId] ? preferredId : createdIds[0];
    return true;
}

/**
 * Generate a unique ID for a new remote configuration.
 * @returns A unique string identifier.
 */
export function createRemoteConfigurationId(): string {
    return `remote-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export type SerializableRemoteConfigurationType = BuiltInRemoteConfiguration["type"];

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
): BuiltInRemoteConfiguration {
    return defaultRemoteProviderRegistry.configurationFromSettings(type, settings);
}

/**
 * Suggest a concise display name from a serialisable remote configuration.
 *
 * The name is presentation only. Callers must continue to use the profile ID for identity and
 * `activeConfigurationId` for the selected main remote.
 */
export function suggestRemoteConfigurationName(configuration: RemoteConfigurationResult): string {
    return defaultRemoteProviderRegistry.suggestName(configuration as BuiltInRemoteConfiguration);
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
    if (options.activateForP2P && !defaultRemoteProviderRegistry.supportsActivationRole(type, "p2p")) {
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
 * Pins an accepted Adaptive repository to the active runtime settings and saved connection.
 *
 * The repository ID is public identity metadata. Persisting it in both projections lets a later
 * Setup URI carry an expectation learned through an earlier trust-on-first-use attachment.
 */
export function pinActiveAdaptiveJournalRepositoryIdInPlace(
    settings: ObsidianLiveSyncSettings,
    repositoryId: string
): boolean {
    const selected = resolveJournalProtocolOptionsV1({
        expectedRepositoryId: repositoryId,
        journalFormat: "adaptive-v1",
        packReadPolicy: "whole-pack",
    }).expectedRepositoryId;
    const projected = resolveJournalProtocolOptionsV1(settings);
    if (projected.journalFormat !== "adaptive-v1") {
        throw new Error("Cannot pin an Adaptive repository ID to an Opaque Journal connection");
    }
    if (projected.expectedRepositoryId && projected.expectedRepositoryId !== selected) {
        throw new Error("The active settings already pin a different Adaptive repository ID");
    }

    let changed = projected.expectedRepositoryId !== selected;
    settings.expectedRepositoryId = selected;

    const activeId = settings.activeConfigurationId?.trim();
    if (!activeId) return changed;
    const configuration = settings.remoteConfigurations?.[activeId];
    if (!configuration) {
        throw new Error(`The active remote configuration '${activeId}' is missing`);
    }
    const parsed = ConnectionStringParser.parse(configuration.uri);
    if (parsed.type === "couchdb" || parsed.type === "p2p") {
        throw new Error("The active remote configuration is not Journal storage");
    }
    const profileProtocol = resolveJournalProtocolOptionsV1(parsed.settings);
    if (profileProtocol.journalFormat !== "adaptive-v1") {
        throw new Error("The active remote configuration does not select Adaptive Journal");
    }
    if (profileProtocol.expectedRepositoryId && profileProtocol.expectedRepositoryId !== selected) {
        throw new Error("The active remote configuration already pins a different Adaptive repository ID");
    }
    if (profileProtocol.expectedRepositoryId !== selected) {
        parsed.settings.expectedRepositoryId = selected;
        configuration.uri = ConnectionStringParser.serialize(parsed);
        configuration.isEncrypted = false;
        changed = true;
    }
    return changed;
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
        const parsed = defaultRemoteProviderRegistry.parse(config.uri);
        if (!defaultRemoteProviderRegistry.supportsActivationRole(parsed.type, "p2p")) {
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
        const parsed = defaultRemoteProviderRegistry.parse(config.uri);
        defaultRemoteProviderRegistry.applyConfiguration(settings, parsed);
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
        const parsed = defaultRemoteProviderRegistry.parse(config.uri);
        if (!defaultRemoteProviderRegistry.supportsActivationRole(parsed.type, "p2p")) {
            return false;
        }
        settings.P2P_ActiveRemoteConfigurationId = id;
        defaultRemoteProviderRegistry.applyConfiguration(settings, parsed, "p2p");
        return settings;
    } catch {
        return false;
    }
}

/**
 * Command: Switch active connection
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
 * Command: Sync with a saved connection
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
        name: "Switch active connection",
        callback: () => commandSwitchActiveRemote(host),
    });

    host.services.API.addCommand({
        id: "livesync-replicate-with-specific",
        name: "Sync with a saved connection",
        callback: () => commandReplicateWithSpecificRemote(host),
    });

    return true;
}
