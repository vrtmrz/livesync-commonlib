import { describe, expect, it, vi } from "vitest";

import { DEFAULT_SETTINGS, NEW_VAULT_SETTINGS, PREFERRED_SETTING_SELF_HOSTED } from "./types";
import { configurationNames, LEVEL_ADVANCED } from "./models/shared.definition.configNames";
import { checkUnsuitableValues, DoctorRegulation, performDoctorConsultation, RebuildOptions } from "./configForDoc";

describe("Doctor translation boundary", () => {
    it("classifies Data Compression as advanced rather than experimental", () => {
        expect(configurationNames.enableCompression).toMatchObject({
            name: "Data Compression",
            level: LEVEL_ADVANCED,
        });
        expect(configurationNames.enableCompression?.status).toBeUndefined();
    });

    it("accepts Data Compression as a supported opt-in setting", () => {
        const result = checkUnsuitableValues({
            ...DEFAULT_SETTINGS,
            enableCompression: true,
        });

        expect(DoctorRegulation.version).toBe("1.0.0");
        expect(result.rules.enableCompression).toBeUndefined();
    });

    it("accepts the content-derived revision policy used by new Vaults", () => {
        const result = checkUnsuitableValues(NEW_VAULT_SETTINGS);

        expect(DoctorRegulation.rules.doNotUseFixedRevisionForChunks).toBeUndefined();
        expect(result.rules.doNotUseFixedRevisionForChunks).toBeUndefined();
    });

    it("does not contradict the self-hosted preferred chunk size", () => {
        const result = checkUnsuitableValues({
            ...DEFAULT_SETTINGS,
            ...PREFERRED_SETTING_SELF_HOSTED,
            couchDB_URI: "https://couchdb.example.test/database",
        });

        expect(result.rules.customChunkSize).toBeUndefined();
    });

    it("uses the translator supplied by the host", async () => {
        const translate = vi.fn((key: string) => `translated:${key}`);
        const settings = {
            ...DEFAULT_SETTINGS,
            customChunkSize: 60,
            handleFilenameCaseSensitive: false,
            usePluginSyncV2: true,
        };

        const result = await performDoctorConsultation(
            {
                confirm: {} as never,
                translate,
            },
            settings,
            {
                localRebuild: RebuildOptions.ConfirmIfRequired,
                remoteRebuild: RebuildOptions.ConfirmIfRequired,
                forceRescan: true,
            }
        );

        expect(result.isModified).toBe(false);
        expect(translate).toHaveBeenCalledWith("Doctor.Message.NoIssues");
    });
});
