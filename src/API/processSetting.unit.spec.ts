import { describe, it, expect, vi } from "vitest";
import {
    decodeSettingsFromSetupURI,
    decodeSettingsFromSetupURIV2,
    encodeSettingsToQRCodeData,
    encodeSettingsToSetupURI,
    SETUP_SETTINGS_ENVELOPE_VERSION,
    decodeSettingsFromQRCodeData,
} from "@lib/API/processSetting";
import { configURIBase, configURIBaseV2, DEFAULT_SETTINGS } from "@lib/common/types";
import type { RemoteConfiguration } from "@lib/common/models/setting.type";
import { encryptString } from "@lib/encryption/stringEncryption";
import { defaultLogger, setGlobalLogFunction } from "octagonal-wheels/common/logger";

describe("QR Codec Round-Trip Test with Real Data", () => {
    it("preserves sleep preferences in Setup URI data", () => {
        const encoded = encodeSettingsToQRCodeData({
            ...DEFAULT_SETTINGS,
            allowSleepDuringSynchronisation: true,
            allowSleepDuringSynchronisationOnDesktop: false,
        });

        const decoded = decodeSettingsFromQRCodeData(encoded);

        expect(decoded.allowSleepDuringSynchronisation).toBe(true);
        expect(decoded.allowSleepDuringSynchronisationOnDesktop).toBe(false);
    });

    it("preserves P2P transport compatibility settings in Setup URI data", () => {
        const encoded = encodeSettingsToQRCodeData({
            ...DEFAULT_SETTINGS,
            P2P_maxWirePayloadBytes: 1024,
            P2P_connectionPath: "relay",
        });

        const decoded = decodeSettingsFromQRCodeData(encoded);

        expect(decoded.P2P_maxWirePayloadBytes).toBe(1024);
        expect(decoded.P2P_connectionPath).toBe("relay");
    });

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

    it("rejects managed source profiles from plain QR sharing", () => {
        expect(() =>
            encodeSettingsToQRCodeData({
                ...DEFAULT_SETTINGS,
                P2P_iceServerSource: {
                    version: 1,
                    id: "cloudflare",
                    configuration: { turnKeyId: "key", apiToken: "secret" },
                },
            })
        ).toThrow(/encrypted Setup URI/i);
    });

    it("uses and validates the v2 encrypted Setup URI envelope for managed sources", async () => {
        const settings = {
            ...DEFAULT_SETTINGS,
            activeConfigurationId: "couch",
            P2P_ActiveRemoteConfigurationId: "p2p",
            P2P_DevicePeerName: "receiver-device",
            P2P_iceServerSource: {
                version: 1,
                id: "cloudflare",
                configuration: { turnKeyId: "key", apiToken: "secret" },
            },
        };

        const uri = await encodeSettingsToSetupURI(settings, "setup-pass", [], false);
        expect(uri.startsWith(configURIBaseV2)).toBe(true);
        expect(uri.startsWith(configURIBase)).toBe(false);

        const envelope = await decodeSettingsFromSetupURIV2(uri, "setup-pass");
        expect(envelope).toMatchObject({ version: SETUP_SETTINGS_ENVELOPE_VERSION });
        expect(envelope && envelope.settings.P2P_iceServerSource).toEqual(settings.P2P_iceServerSource);
        expect(envelope && envelope.settings.P2P_ActiveRemoteConfigurationId).toBe("p2p");
        expect(envelope && envelope.settings.P2P_DevicePeerName).toBe("receiver-device");

        const decoded = await decodeSettingsFromSetupURI(uri, "setup-pass");
        expect(decoded && decoded.P2P_iceServerSource).toEqual(settings.P2P_iceServerSource);
    });

    it("keeps legacy Setup URI output and decoding for manual settings", async () => {
        const settings = {
            ...DEFAULT_SETTINGS,
            P2P_roomID: "manual-room",
            P2P_turnServers: "turn:example.test:3478",
        };
        const uri = await encodeSettingsToSetupURI(settings, "setup-pass", [], false);
        expect(uri.startsWith(configURIBase)).toBe(true);
        expect(uri.startsWith(configURIBaseV2)).toBe(false);
        const decoded = await decodeSettingsFromSetupURI(uri, "setup-pass");
        expect(decoded && decoded.P2P_roomID).toBe("manual-room");
        expect(decoded && "encryptedP2PIceServerSource" in decoded).toBe(false);
    });

    it("does not log provider tokens from malformed v2 Setup payloads", async () => {
        const token = "turn-key-api-token-that-must-not-be-logged";
        const malformedPayload = `{"version":2,"settings":{"P2P_iceServerSource":{"version":1,"id":"cloudflare","configuration":{"apiToken":"${token}"}}}BROKEN`;
        const encrypted = await encryptString(malformedPayload, "setup-pass");
        const logger = vi.fn();
        setGlobalLogFunction(logger);
        try {
            const result = await decodeSettingsFromSetupURIV2(
                `${configURIBaseV2}${encodeURIComponent(encrypted)}`,
                "setup-pass"
            );
            expect(result).toBe(false);
            const messages = logger.mock.calls.map(([message]) => String(message)).join("\n");
            expect(messages).toContain("Failed to decode versioned settings from Setup URI");
            expect(messages).not.toContain(token);
        } finally {
            setGlobalLogFunction(defaultLogger);
        }
    });
});
