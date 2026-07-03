import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "./types";
import {
    AllSettingDefault,
    AllExplicitSettingCommitGroups,
    AllSettingDefinitions,
    getExplicitSettingCommitGroup,
    getSettingDefinition,
    OnDialogSettingsDefault,
} from "./settingConstants";
import { createSettingDefinitions, getPersistedSettingDefinition, persistedSettingDefinitions } from "./types";

describe("setting definition repository", () => {
    it("defines every persisted setting key", () => {
        const definedKeys = new Set<string>(persistedSettingDefinitions.map((definition) => definition.key));
        for (const key of Object.keys(DEFAULT_SETTINGS)) {
            expect(definedKeys.has(key)).toBe(true);
        }
    });

    it("defines every all-settings key used by the settings dialogue", () => {
        const definedKeys = new Set<string>(AllSettingDefinitions.map((definition) => definition.key));
        for (const key of Object.keys(AllSettingDefault)) {
            expect(definedKeys.has(key)).toBe(true);
        }
    });

    it("infers basic value kinds from defaults and hidden metadata", () => {
        expect(getPersistedSettingDefinition("liveSync")?.kind).toBe("boolean");
        expect(getPersistedSettingDefinition("savingDelay")?.kind).toBe("number");
        expect(getSettingDefinition("couchDB_URI")?.kind).toBe("text");
        expect(getSettingDefinition("couchDB_PASSWORD")?.kind).toBe("password");
        expect(getSettingDefinition("chunkSplitterVersion")?.kind).toBe("select");
        expect(getSettingDefinition("E2EEAlgorithm")?.kind).toBe("select");
        expect(getSettingDefinition("hashAlg")?.kind).toBe("select");
        expect(getSettingDefinition("preset")?.kind).toBe("select");
        expect(getSettingDefinition("syncMode")?.kind).toBe("select");
        expect(getSettingDefinition("autoAcceptCompatibleTweak")?.kind).toBe("boolean");
        expect(getSettingDefinition("ignoreFiles")?.kind).toBe("textarea");
        expect(getSettingDefinition("configPassphrase")?.kind).toBe("password");
        expect(getSettingDefinition("configPassphraseStore")?.kind).toBe("select");
    });

    it("keeps literal text as translation keys during migration", () => {
        const definition = getSettingDefinition("encrypt");
        expect(definition?.labelKey).toBe("End-to-End Encryption");
        expect(definition?.label).toBe(definition?.labelKey);
        expect(definition?.descriptionKey).toBe(
            "Encrypt contents on the remote database. If you use the plugin's synchronization feature, enabling this is recommended."
        );
        expect(definition?.description).toBe(definition?.descriptionKey);
    });

    it("does not mark missing UI metadata as internal by itself", () => {
        expect(getPersistedSettingDefinition("liveSync")?.internal).toBe(false);
        expect(getSettingDefinition("encrypt")?.internal).toBe(false);
    });

    it("marks explicitly internal and obsolete definitions as internal", () => {
        const definitions = createSettingDefinitions(
            {
                visible: true,
                internal: true,
                obsolete: true,
            },
            {
                internal: {
                    name: "Internal",
                    internal: true,
                },
                obsolete: {
                    name: "Obsolete",
                    obsolete: true,
                },
            }
        );
        expect(definitions.find((definition) => definition.key === "visible")?.internal).toBe(false);
        expect(definitions.find((definition) => definition.key === "internal")?.internal).toBe(true);
        expect(definitions.find((definition) => definition.key === "obsolete")?.internal).toBe(true);
    });

    it("classifies dialogue-only settings by storage domain", () => {
        for (const key of Object.keys(OnDialogSettingsDefault)) {
            expect(getSettingDefinition(key as keyof typeof OnDialogSettingsDefault)).toBeDefined();
        }
        expect(getSettingDefinition("configPassphrase")?.storage).toBe("local");
        expect(getSettingDefinition("deviceAndVaultName")?.storage).toBe("local");
        expect(getSettingDefinition("syncMode")?.storage).toBe("derived");
        expect(getSettingDefinition("preset")?.storage).toBe("ephemeral");
    });

    it("defines explicit commit groups for settings applied together", () => {
        const passphrase = getSettingDefinition("configPassphrase");
        const store = getSettingDefinition("configPassphraseStore");
        const settingSyncFile = getSettingDefinition("settingSyncFile");
        const databaseSuffix = getSettingDefinition("additionalSuffixOfDatabaseName");
        const reflectEventRemediation = getSettingDefinition("maxMTimeForReflectEvents");
        expect(passphrase?.commit).toEqual({
            mode: "explicit",
            group: "configuration-encryption",
            applyKeys: ["configPassphrase", "configPassphraseStore"],
        });
        expect(store?.commit).toEqual(passphrase?.commit);
        expect(settingSyncFile?.commit).toEqual({
            mode: "explicit",
            group: "setting-sync-file",
            applyKeys: ["settingSyncFile"],
        });
        expect(databaseSuffix?.commit).toEqual({
            mode: "explicit",
            group: "database-suffix",
            applyKeys: ["additionalSuffixOfDatabaseName"],
        });
        expect(databaseSuffix?.affects).toEqual(["reopens-local-database"]);
        expect(reflectEventRemediation?.commit).toEqual({
            mode: "explicit",
            group: "remediation-reflect-events",
            applyKeys: ["maxMTimeForReflectEvents"],
        });
    });

    it("resolves explicit commit groups for apply button renderers", () => {
        expect(new Set(AllExplicitSettingCommitGroups.map((commitGroup) => commitGroup.group))).toEqual(
            new Set(["configuration-encryption", "setting-sync-file", "database-suffix", "remediation-reflect-events"])
        );
        const configurationEncryption = getExplicitSettingCommitGroup("configuration-encryption");
        expect(configurationEncryption?.group).toBe("configuration-encryption");
        expect(new Set(configurationEncryption?.keys)).toEqual(new Set(["configPassphrase", "configPassphraseStore"]));
        expect(configurationEncryption?.applyKeys).toEqual(["configPassphrase", "configPassphraseStore"]);
        expect(getExplicitSettingCommitGroup("setting-sync-file")?.applyKeys).toEqual(["settingSyncFile"]);
        expect(getExplicitSettingCommitGroup("database-suffix")?.applyKeys).toEqual(["additionalSuffixOfDatabaseName"]);
        expect(getExplicitSettingCommitGroup("remediation-reflect-events")?.applyKeys).toEqual([
            "maxMTimeForReflectEvents",
        ]);
    });
});
