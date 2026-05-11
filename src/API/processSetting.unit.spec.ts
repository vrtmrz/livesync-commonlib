import { describe, it, expect } from "vitest";
import { encodeSettingsToQRCodeData, decodeSettingsFromQRCodeData } from "@lib/API/processSetting";
import { DEFAULT_SETTINGS } from "@lib/common/types";
import type { RemoteConfiguration } from "@lib/common/models/setting.type";

describe("QR Codec Round-Trip Test with Real Data", () => {
    it("should preserve remoteConfigurations through encode/decode cycle", () => {
        // Dummy test data with remoteConfigurations
        // Note: In production, this would load from actual user settings containing multiple remoteConfigurations
        const testData: Partial<typeof DEFAULT_SETTINGS> = {
            remoteConfigurations: {
                "legacy-couchdb": {
                    id: "legacy-couchdb",
                    name: "CouchDB Remote",
                    uri: "sls+http://user:password@localhost:5984/?db=vault",
                    isEncrypted: false,
                } satisfies RemoteConfiguration,
                "legacy-s3": {
                    id: "legacy-s3",
                    name: "S3 Remote",
                    uri: "sls+s3://ak:sk@example.com",
                    isEncrypted: false,
                } satisfies RemoteConfiguration,
            },
            activeConfigurationId: "legacy-couchdb",
            encrypt: true,
            passphrase: "test-passphrase",
            usePathObfuscation: true,
        };

        // Merge test data with default settings to ensure all required properties exist
        const originalSettings = {
            ...DEFAULT_SETTINGS,
            ...testData,
        };

        // Verify original settings have remoteConfigurations
        expect(originalSettings.remoteConfigurations).toBeDefined();
        const originalConfigCount = Object.keys(originalSettings.remoteConfigurations || {}).length;
        expect(originalConfigCount).toBeGreaterThan(0);
        expect(originalSettings.activeConfigurationId).toBeDefined();

        // Encode settings to QR data using the fixed dense array encoding
        const encoded = encodeSettingsToQRCodeData(originalSettings);
        expect(encoded).toBeTruthy();
        expect(encoded.length).toBeGreaterThan(0);

        // Decode settings from QR data
        const decodedSettings = decodeSettingsFromQRCodeData(encoded);

        // Verify remoteConfigurations survived the round-trip encoding/decoding cycle
        expect(decodedSettings.remoteConfigurations).toBeDefined();
        const decodedConfigCount = Object.keys(decodedSettings.remoteConfigurations || {}).length;
        expect(decodedConfigCount).toBe(originalConfigCount);

        // Verify each remote configuration was correctly preserved
        const originalConfigs = originalSettings.remoteConfigurations || {};
        const decodedConfigs = decodedSettings.remoteConfigurations || {};

        for (const id of Object.keys(originalConfigs)) {
            const originalConfig = originalConfigs[id];
            const decodedConfig = decodedConfigs[id];

            // Ensure the configuration exists after decoding
            expect(decodedConfig).toBeDefined();
            // Verify all configuration properties match
            expect(decodedConfig.id).toBe(originalConfig.id);
            expect(decodedConfig.name).toBe(originalConfig.name);
            expect(decodedConfig.uri).toBe(originalConfig.uri);
            expect(decodedConfig.isEncrypted).toBe(originalConfig.isEncrypted);
        }

        // Verify activeConfigurationId was preserved
        expect(decodedSettings.activeConfigurationId).toBe(originalSettings.activeConfigurationId);

        // Verify other critical settings properties were preserved
        expect(decodedSettings.encrypt).toBe(originalSettings.encrypt);
        expect(decodedSettings.passphrase).toBe(originalSettings.passphrase);
        expect(decodedSettings.usePathObfuscation).toBe(originalSettings.usePathObfuscation);
    });
});
