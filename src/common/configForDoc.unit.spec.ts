import { describe, expect, it, vi } from "vitest";

import {
    DEFAULT_SETTINGS,
    E2EEAlgorithms,
    NEW_VAULT_SETTINGS,
    PREFERRED_JOURNAL_SYNC,
    PREFERRED_SETTING_SELF_HOSTED,
    REMOTE_COUCHDB,
    REMOTE_MINIO,
    REMOTE_P2P,
} from "./types";
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

        expect(DoctorRegulation.version).toBe("1.0.33");
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

    it("does not apply the CouchDB chunk-size recommendation to Object Storage", () => {
        const result = checkUnsuitableValues({
            ...DEFAULT_SETTINGS,
            ...PREFERRED_JOURNAL_SYNC,
            remoteType: REMOTE_MINIO,
        });

        expect(result.rules.customChunkSize).toBeUndefined();
    });

    it("applies the chunk-size recommendation to matching CouchDB settings", () => {
        const result = checkUnsuitableValues({
            ...DEFAULT_SETTINGS,
            remoteType: REMOTE_COUCHDB,
            chunkSplitterVersion: "v3-rabin-karp",
            customChunkSize: 20,
            couchDB_URI: "https://couchdb.example.test/database",
        });

        expect(result.rules.customChunkSize).toBeDefined();
    });

    it("does not apply the CouchDB chunk-size recommendation to P2P", () => {
        const result = checkUnsuitableValues({
            ...DEFAULT_SETTINGS,
            remoteType: REMOTE_P2P,
            chunkSplitterVersion: "v3-rabin-karp",
            customChunkSize: 20,
        });

        expect(result.rules.customChunkSize).toBeUndefined();
    });

    it.each([
        {
            remoteType: REMOTE_COUCHDB,
            encrypt: true,
            usePathObfuscation: true,
            E2EEAlgorithm: E2EEAlgorithms.V2,
            encryptInternalMetadata: false,
            recommended: true,
        },
        {
            remoteType: REMOTE_COUCHDB,
            encrypt: true,
            usePathObfuscation: true,
            E2EEAlgorithm: E2EEAlgorithms.V2,
            encryptInternalMetadata: true,
            recommended: false,
        },
        {
            remoteType: REMOTE_COUCHDB,
            encrypt: false,
            usePathObfuscation: true,
            E2EEAlgorithm: E2EEAlgorithms.V2,
            encryptInternalMetadata: false,
            recommended: false,
        },
        {
            remoteType: REMOTE_COUCHDB,
            encrypt: true,
            usePathObfuscation: false,
            E2EEAlgorithm: E2EEAlgorithms.V2,
            encryptInternalMetadata: false,
            recommended: false,
        },
        {
            remoteType: REMOTE_COUCHDB,
            encrypt: true,
            usePathObfuscation: true,
            E2EEAlgorithm: E2EEAlgorithms.V1,
            encryptInternalMetadata: false,
            recommended: false,
        },
        {
            remoteType: REMOTE_MINIO,
            encrypt: true,
            usePathObfuscation: true,
            E2EEAlgorithm: E2EEAlgorithms.V2,
            encryptInternalMetadata: false,
            recommended: false,
        },
        {
            remoteType: REMOTE_P2P,
            encrypt: true,
            usePathObfuscation: true,
            E2EEAlgorithm: E2EEAlgorithms.V2,
            encryptInternalMetadata: false,
            recommended: false,
        },
    ])("recommends internal Metadata encryption only when its prerequisites hold: %j", (condition) => {
        const { recommended, ...settings } = condition;
        const result = checkUnsuitableValues({ ...NEW_VAULT_SETTINGS, ...settings });
        expect(Boolean(result.rules.encryptInternalMetadata)).toBe(recommended);
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

    it("applies an accepted Metadata recommendation without scheduling a rebuild", async () => {
        const settings = {
            ...NEW_VAULT_SETTINGS,
            encrypt: true,
            usePathObfuscation: true,
            encryptInternalMetadata: false,
            customChunkSize: 60,
            doctorProcessedVersion: "1.0.0",
        };
        const confirm = {
            askSelectStringDialogue: vi.fn(async (_message: string, options: string[]) => options[0]),
            askYesNoDialog: vi.fn(),
        };
        const result = await performDoctorConsultation(
            { confirm: confirm as never, translate: ((key: string) => key) as never },
            settings,
            { localRebuild: RebuildOptions.AutomaticAcceptable, remoteRebuild: RebuildOptions.AutomaticAcceptable }
        );
        expect(confirm.askSelectStringDialogue.mock.calls[1][1][0]).toBe(
            "Enable without rebuilding — update every other device first"
        );
        expect(result.settings.encryptInternalMetadata).toBe(true);
        expect(result.settings.doctorProcessedVersion).toBe("1.0.33");
        expect(result.shouldRebuild).toBe(false);
        expect(result.shouldRebuildLocal).toBe(false);
        expect(confirm.askYesNoDialog).not.toHaveBeenCalled();
    });

    it("leaves the new recommendation available after accepting E2EE V2", async () => {
        const settings = {
            ...NEW_VAULT_SETTINGS,
            encrypt: true,
            usePathObfuscation: true,
            E2EEAlgorithm: E2EEAlgorithms.V1,
            encryptInternalMetadata: false,
            customChunkSize: 60,
            doctorProcessedVersion: "1.0.0",
        };
        const confirm = {
            askSelectStringDialogue: vi.fn(async (_message: string, options: string[]) => options[0]),
            askYesNoDialog: vi.fn(),
        };
        const env = { confirm: confirm as never, translate: ((key: string) => key) as never };
        const options = {
            localRebuild: RebuildOptions.AutomaticAcceptable,
            remoteRebuild: RebuildOptions.AutomaticAcceptable,
        };
        const first = await performDoctorConsultation(env, settings, options);
        expect(first.settings.E2EEAlgorithm).toBe(E2EEAlgorithms.V2);
        expect(first.settings.encryptInternalMetadata).toBe(false);
        expect(first.settings.doctorProcessedVersion).toBe("1.0.0");
        const second = await performDoctorConsultation(env, first.settings, options);
        expect(second.settings.encryptInternalMetadata).toBe(true);
    });
});
