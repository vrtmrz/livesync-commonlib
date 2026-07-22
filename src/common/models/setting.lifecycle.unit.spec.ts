import { describe, expect, it } from "vitest";
import {
    CURRENT_SETTING_VERSION,
    DEFAULT_SETTINGS,
    NEW_VAULT_SETTINGS,
    PREFERRED_JOURNAL_SYNC,
    PREFERRED_SETTING_CLOUDANT,
    PREFERRED_SETTING_SELF_HOSTED,
    SETTINGS_SCHEMA_DEFAULTS,
    TweakValuesShouldMatchedTemplate,
    TweakValuesRecommendedTemplate,
    createNewVaultSettings,
} from "../types";
import { IncompatibleChangesInSpecificPattern } from "./tweak.definition";
import { prepareSettingsForLoad, SettingsMigrationReviewCodes } from "./setting.lifecycle";
import type { ObsidianLiveSyncSettings } from "./setting.type";

describe("prepareSettingsForLoad", () => {
    it("uses an independent copy of the new-Vault defaults for a blank store", () => {
        const prepared = prepareSettingsForLoad(undefined);

        expect(prepared.isNewVault).toBe(true);
        expect(prepared.changed).toBe(false);
        expect(prepared.settings).toEqual(NEW_VAULT_SETTINGS);
        expect(prepared.settings).not.toBe(NEW_VAULT_SETTINGS);
        expect(prepared.settings.remoteConfigurations).not.toBe(NEW_VAULT_SETTINGS.remoteConfigurations);
    });

    it("creates independently mutable new-Vault settings", () => {
        const first = createNewVaultSettings();
        const second = createNewVaultSettings();

        first.remoteConfigurations.example = {
            id: "example",
            name: "Example",
            uri: "sls+http://localhost/",
            isEncrypted: false,
        };

        expect(second.remoteConfigurations).toEqual({});
        expect(NEW_VAULT_SETTINGS.remoteConfigurations).toEqual({});
    });

    it("completes legacy settings while preserving explicit synchronisation choices", () => {
        const legacy: Partial<ObsidianLiveSyncSettings> = {
            liveSync: true,
            syncOnSave: false,
            syncOnEditorSave: true,
            syncOnStart: false,
            syncOnFileOpen: true,
            syncAfterMerge: false,
            periodicReplication: true,
        };

        const prepared = prepareSettingsForLoad(legacy);

        expect(prepared.sourceVersion).toBe(0);
        expect(prepared.targetVersion).toBe(CURRENT_SETTING_VERSION);
        expect(prepared.changed).toBe(true);
        expect(prepared.settings).toMatchObject(legacy);
        expect(prepared.settings.lessInformationInLog).toBe(SETTINGS_SCHEMA_DEFAULTS.lessInformationInLog);
    });

    it("is idempotent after the current schema has been applied", () => {
        const first = prepareSettingsForLoad({
            liveSync: true,
            handleFilenameCaseSensitive: false,
        });
        const second = prepareSettingsForLoad(first.settings);

        expect(second.sourceVersion).toBe(CURRENT_SETTING_VERSION);
        expect(second.targetVersion).toBe(CURRENT_SETTING_VERSION);
        expect(second.changed).toBe(false);
        expect(second.requiresSyncReview).toBe(false);
        expect(second.settings).toEqual(first.settings);
    });

    it("reports a legacy pending update as requiring synchronisation review", () => {
        const prepared = prepareSettingsForLoad({
            versionUpFlash: "Review this update before synchronising.",
        });

        expect(prepared.requiresSyncReview).toBe(true);
        expect(prepared.reviewReasons).toContainEqual({
            code: SettingsMigrationReviewCodes.LegacyUpdatePending,
            fromVersion: 0,
            toVersion: CURRENT_SETTING_VERSION,
        });
    });

    it("does not downgrade settings written by a newer schema", () => {
        const futureVersion = CURRENT_SETTING_VERSION + 1;
        const prepared = prepareSettingsForLoad({
            settingVersion: futureVersion,
            liveSync: true,
        });

        expect(prepared.targetVersion).toBe(futureVersion);
        expect(prepared.settings.settingVersion).toBe(futureVersion);
        expect(prepared.settings.liveSync).toBe(true);
        expect(prepared.changed).toBe(false);
        expect(prepared.isFromFutureSchema).toBe(true);
        expect(prepared.reviewReasons[0]?.code).toBe(SettingsMigrationReviewCodes.FutureSchema);
    });

    it("retains DEFAULT_SETTINGS as the conservative fallback compatibility name", () => {
        expect(DEFAULT_SETTINGS).toBe(SETTINGS_SCHEMA_DEFAULTS);
        expect(NEW_VAULT_SETTINGS).not.toBe(SETTINGS_SCHEMA_DEFAULTS);
        expect(SETTINGS_SCHEMA_DEFAULTS.doNotUseFixedRevisionForChunks).toBe(true);
        expect(NEW_VAULT_SETTINGS.doNotUseFixedRevisionForChunks).toBe(true);
        expect(SETTINGS_SCHEMA_DEFAULTS.usePluginSyncV2).toBe(false);
        expect(NEW_VAULT_SETTINGS.usePluginSyncV2).toBe(true);
        expect(SETTINGS_SCHEMA_DEFAULTS.handleFilenameCaseSensitive).toBeUndefined();
        expect(NEW_VAULT_SETTINGS.handleFilenameCaseSensitive).toBe(false);
    });

    it("keeps the new-Vault differences from stored-setting fallbacks explicit and bounded", () => {
        const differingKeys = Object.keys(SETTINGS_SCHEMA_DEFAULTS)
            .filter(
                (key) =>
                    JSON.stringify(SETTINGS_SCHEMA_DEFAULTS[key as keyof ObsidianLiveSyncSettings]) !==
                    JSON.stringify(NEW_VAULT_SETTINGS[key as keyof ObsidianLiveSyncSettings])
            )
            .sort();
        const deliberatelyUnsetKeys = Object.keys(NEW_VAULT_SETTINGS)
            .filter((key) => NEW_VAULT_SETTINGS[key as keyof ObsidianLiveSyncSettings] === undefined)
            .sort();

        expect(differingKeys).toEqual(["handleFilenameCaseSensitive", "usePluginSyncV2"]);
        expect(deliberatelyUnsetKeys).toEqual(["autoAcceptCompatibleTweak", "isConfigured", "tweakModified"]);
    });

    it("keeps remote-specific recommendations separate from the new-Vault base", () => {
        expect(PREFERRED_SETTING_CLOUDANT).toMatchObject({
            customChunkSize: 0,
            concurrencyOfReadChunksOnline: 100,
            minimumIntervalOfReadChunksOnline: 333,
        });
        expect(PREFERRED_SETTING_SELF_HOSTED).toMatchObject({
            customChunkSize: 60,
            concurrencyOfReadChunksOnline: 30,
            minimumIntervalOfReadChunksOnline: 25,
        });
        expect(PREFERRED_JOURNAL_SYNC).toMatchObject({
            customChunkSize: 10,
            concurrencyOfReadChunksOnline: 30,
            minimumIntervalOfReadChunksOnline: 25,
        });
    });

    it("does not expose the invariant chunk-revision policy as a tweak", () => {
        expect(TweakValuesShouldMatchedTemplate.doNotUseFixedRevisionForChunks).toBeUndefined();
        expect(TweakValuesRecommendedTemplate.doNotUseFixedRevisionForChunks).toBeUndefined();
        expect(
            IncompatibleChangesInSpecificPattern.filter(
                ({ key }) => key === "doNotUseFixedRevisionForChunks"
            )
        ).toEqual([]);
    });

    it("preserves the legacy case-insensitive behaviour when an existing Vault has no stored decision", () => {
        const prepared = prepareSettingsForLoad({
            settingVersion: CURRENT_SETTING_VERSION,
            liveSync: true,
        });

        expect(prepared.changed).toBe(true);
        expect(prepared.requiresSyncReview).toBe(false);
        expect(prepared.reviewReasons).toEqual([]);
        expect(prepared.settings.handleFilenameCaseSensitive).toBe(false);
    });

    it("preserves the legacy configured-state inference for a non-empty default-equivalent store", () => {
        const prepared = prepareSettingsForLoad({
            settingVersion: CURRENT_SETTING_VERSION,
            liveSync: SETTINGS_SCHEMA_DEFAULTS.liveSync,
        });

        expect(prepared.changed).toBe(true);
        expect(prepared.settings.isConfigured).toBe(false);
    });

    it("infers a missing legacy configured state only from a non-default stored value", () => {
        const prepared = prepareSettingsForLoad({
            settingVersion: CURRENT_SETTING_VERSION,
            liveSync: true,
        });

        expect(prepared.settings.isConfigured).toBe(true);
    });

    it.each([false, true])("preserves an explicit configured state of %s", (isConfigured) => {
        const prepared = prepareSettingsForLoad({
            settingVersion: CURRENT_SETTING_VERSION,
            isConfigured,
            liveSync: !isConfigured,
        });

        expect(prepared.settings.isConfigured).toBe(isConfigured);
    });

    it.each([false, true])(
        "preserves an explicit filename-case decision of %s without requesting another review",
        (handleFilenameCaseSensitive) => {
            const prepared = prepareSettingsForLoad({
                settingVersion: CURRENT_SETTING_VERSION,
                liveSync: true,
                handleFilenameCaseSensitive,
            });

            expect(prepared.requiresSyncReview).toBe(false);
            expect(prepared.settings.handleFilenameCaseSensitive).toBe(handleFilenameCaseSensitive);
        }
    );
});
