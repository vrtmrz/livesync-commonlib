import { createNewVaultSettings, SETTINGS_SCHEMA_DEFAULTS } from "./setting.const.defaults";
import {
    CURRENT_SETTING_VERSION,
    SETTING_VERSION_INITIAL,
    SETTING_VERSION_SUPPORT_CASE_INSENSITIVE,
} from "./setting.const";
import type { ObsidianLiveSyncSettings } from "./setting.type";

export const SettingsMigrationReviewCodes = {
    LegacyUpdatePending: "legacy-update-review-pending",
    FutureSchema: "settings-schema-newer-than-runtime",
    /** @deprecated Missing legacy values are now normalised to false and do not emit this reason. */
    FilenameCaseSensitivityUnresolved: "filename-case-sensitivity-unresolved",
} as const;

export type SettingsMigrationReviewCode =
    (typeof SettingsMigrationReviewCodes)[keyof typeof SettingsMigrationReviewCodes];

export interface SettingsMigrationReviewReason {
    code: SettingsMigrationReviewCode;
    fromVersion: number;
    toVersion: number;
}

export interface SettingsMigrationState {
    sourceVersion: number;
    targetVersion: number;
    isNewVault: boolean;
    isFromFutureSchema: boolean;
    changed: boolean;
    requiresSyncReview: boolean;
    reviewReasons: readonly SettingsMigrationReviewReason[];
}

export interface PreparedSettings extends SettingsMigrationState {
    settings: ObsidianLiveSyncSettings;
}

interface SettingsMigration {
    toVersion: number;
    apply(settings: Partial<ObsidianLiveSyncSettings>): Partial<ObsidianLiveSyncSettings>;
    reviewReason?(
        settings: Partial<ObsidianLiveSyncSettings>,
        fromVersion: number
    ): SettingsMigrationReviewReason | undefined;
}

const SETTINGS_MIGRATIONS: readonly SettingsMigration[] = [
    {
        toVersion: SETTING_VERSION_SUPPORT_CASE_INSENSITIVE,
        apply: (settings) => settings,
        reviewReason: (settings, fromVersion) =>
            settings.versionUpFlash
                ? {
                      code: SettingsMigrationReviewCodes.LegacyUpdatePending,
                      fromVersion,
                      toVersion: SETTING_VERSION_SUPPORT_CASE_INSENSITIVE,
                  }
                : undefined,
    },
];

function cloneSettings(
    source: Partial<ObsidianLiveSyncSettings>,
    fallbacks: ObsidianLiveSyncSettings
): ObsidianLiveSyncSettings {
    return {
        ...fallbacks,
        ...source,
        remoteConfigurations: Object.fromEntries(
            Object.entries(source.remoteConfigurations ?? fallbacks.remoteConfigurations).map(([id, config]) => [
                id,
                { ...config },
            ])
        ),
        pluginSyncExtendedSetting: {
            ...fallbacks.pluginSyncExtendedSetting,
            ...source.pluginSyncExtendedSetting,
        },
    };
}

function storedSettingVersion(settings: Partial<ObsidianLiveSyncSettings>): number {
    const version = settings.settingVersion;
    return typeof version === "number" && Number.isSafeInteger(version) && version >= SETTING_VERSION_INITIAL
        ? version
        : SETTING_VERSION_INITIAL;
}

function isBlankSettings(settings: Partial<ObsidianLiveSyncSettings> | undefined): boolean {
    return settings === undefined || Object.keys(settings).length === 0;
}

function inferLegacyConfiguredState(settings: Partial<ObsidianLiveSyncSettings>): boolean {
    // This is the exact pre-1.0 inference: a missing flag meant configured
    // only when completing the stored document changed a legacy default.
    const completed = { ...SETTINGS_SCHEMA_DEFAULTS, ...settings };
    return JSON.stringify(completed) !== JSON.stringify(SETTINGS_SCHEMA_DEFAULTS);
}

/**
 * Completes and migrates raw settings before services consume them.
 *
 * Stored settings use conservative schema fallbacks. A blank store uses the
 * independently maintained new-Vault defaults. Explicit stored values always
 * take precedence over both sets of defaults.
 */
export function prepareSettingsForLoad(
    storedSettings: Partial<ObsidianLiveSyncSettings> | undefined
): PreparedSettings {
    if (isBlankSettings(storedSettings)) {
        return {
            settings: createNewVaultSettings(),
            sourceVersion: CURRENT_SETTING_VERSION,
            targetVersion: CURRENT_SETTING_VERSION,
            isNewVault: true,
            isFromFutureSchema: false,
            changed: false,
            requiresSyncReview: false,
            reviewReasons: [],
        };
    }

    const source = { ...storedSettings };
    const sourceVersion = storedSettingVersion(source);
    if (sourceVersion > CURRENT_SETTING_VERSION) {
        const reviewReasons: readonly SettingsMigrationReviewReason[] = [
            {
                code: SettingsMigrationReviewCodes.FutureSchema,
                fromVersion: sourceVersion,
                toVersion: CURRENT_SETTING_VERSION,
            },
        ];
        return {
            settings: cloneSettings(source, SETTINGS_SCHEMA_DEFAULTS),
            sourceVersion,
            targetVersion: sourceVersion,
            isNewVault: false,
            isFromFutureSchema: true,
            changed: false,
            requiresSyncReview: true,
            reviewReasons,
        };
    }

    let migrated: Partial<ObsidianLiveSyncSettings> = source;
    let targetVersion = sourceVersion;
    const reviewReasons: SettingsMigrationReviewReason[] = [];
    for (const migration of SETTINGS_MIGRATIONS) {
        if (targetVersion >= migration.toVersion) continue;
        const reason = migration.reviewReason?.(migrated, targetVersion);
        if (reason) reviewReasons.push(reason);
        migrated = migration.apply(migrated);
        targetVersion = migration.toVersion;
        migrated.settingVersion = targetVersion;
    }

    if (targetVersion !== CURRENT_SETTING_VERSION) {
        throw new Error(
            `No setting migration reaches schema ${CURRENT_SETTING_VERSION} from schema ${sourceVersion}.`
        );
    }

    // Keep the configured-state inference used before 1.0. A non-empty
    // default-equivalent document is still unconfigured; treating every
    // non-empty store as configured would make that state irreversible once
    // this migration is saved.
    const normalisedConfiguredState = migrated.isConfigured === undefined;
    if (normalisedConfiguredState) {
        migrated = { ...migrated, isConfigured: inferLegacyConfiguredState(source) };
    }

    // Every pre-1.0 path consumer treated an absent value as false. Persist
    // that effective legacy behaviour explicitly so the migration does not
    // invent a case-sensitive policy or require an unnecessary rebuild.
    const normalisedFilenameCase = typeof migrated.handleFilenameCaseSensitive !== "boolean";
    if (normalisedFilenameCase) migrated = { ...migrated, handleFilenameCaseSensitive: false };

    return {
        settings: cloneSettings(migrated, SETTINGS_SCHEMA_DEFAULTS),
        sourceVersion,
        targetVersion,
        isNewVault: false,
        isFromFutureSchema: false,
        changed: sourceVersion !== targetVersion || normalisedConfiguredState || normalisedFilenameCase,
        requiresSyncReview: reviewReasons.length > 0,
        reviewReasons,
    };
}
