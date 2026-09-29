import { describe, it, expect, vi } from "vitest";
import {
    decodeSettingsFromSetupURI,
    encodeSettingsToQRCodeData,
    encodeSettingsToSetupURI,
    encodeTimeBoundSetupURI,
    getTimeBoundSetupURIUsableUntil,
    isTimeBoundSetupURIUsableNow,
    decodeSettingsFromQRCodeData,
} from "@lib/API/processSetting";
import { configURIBase, DEFAULT_SETTINGS } from "@lib/common/types";
import type { RemoteConfiguration } from "@lib/common/models/setting.type";
import { decryptString, encryptString } from "@lib/encryption/stringEncryption";
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

    it("shares the derived ID key and version in QR data without the persisted wrapper", () => {
        const key = "34".repeat(32);
        const decoded = decodeSettingsFromQRCodeData(
            encodeSettingsToQRCodeData({
                ...DEFAULT_SETTINGS,
                idDerivationVersion: 1,
                idDerivationKey: key,
                encryptedIdDerivationKey: "persisted-encrypted-wrapper",
            })
        );

        expect(decoded.idDerivationVersion).toBe(1);
        expect(decoded.idDerivationKey).toBe(key);
        expect(decoded.encryptedIdDerivationKey).toBe("");
    });

    it("rejects an incomplete ID configuration before encoding QR data", () => {
        expect(() =>
            encodeSettingsToQRCodeData({ ...DEFAULT_SETTINGS, idDerivationVersion: 1, idDerivationKey: "" })
        ).toThrow();
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

    it("preserves managed credentials through P2P profiles in plain QR data", () => {
        const profileURI = "sls+p2p://inactive-room?managedType=CF&managedId=key&token=secret";
        const settings = {
            ...DEFAULT_SETTINGS,
            P2P_managedType: "CF",
            P2P_managedId: "key",
            P2P_managedToken: "secret",
            remoteConfigurations: {
                inactive: {
                    id: "inactive",
                    name: "Inactive managed P2P",
                    uri: profileURI,
                    isEncrypted: false,
                } satisfies RemoteConfiguration,
            },
            P2P_ActiveRemoteConfigurationId: "inactive",
        };

        const decoded = decodeSettingsFromQRCodeData(encodeSettingsToQRCodeData(settings));

        expect(decoded.P2P_managedType).toBeUndefined();
        expect(decoded.P2P_managedId).toBeUndefined();
        expect(decoded.P2P_managedToken).toBeUndefined();
        expect(decoded.remoteConfigurations.inactive?.uri).toBe(profileURI);
        expect(decoded.remoteConfigurations.inactive?.uri).toContain("secret");
    });

    it("omits runtime ICE fields from plain QR data", () => {
        const decoded = decodeSettingsFromQRCodeData(
            encodeSettingsToQRCodeData({
                ...DEFAULT_SETTINGS,
                P2P_iceServers: [{ urls: "turn:turn.example.com", credential: "issued-secret" }],
                P2P_iceServersExpiresAt: 123_456,
            })
        );

        expect(decoded).not.toHaveProperty("P2P_iceServers");
        expect(decoded).not.toHaveProperty("P2P_iceServersExpiresAt");
    });

    it("uses the ordinary encrypted Setup URI payload for managed P2P profiles", async () => {
        const profileURI = "sls+p2p://managed-room?managedType=CF&managedId=key&token=secret";
        const settings = {
            ...DEFAULT_SETTINGS,
            activeConfigurationId: "couch",
            P2P_ActiveRemoteConfigurationId: "p2p",
            P2P_DevicePeerName: "receiver-device",
            P2P_managedType: "CF",
            P2P_managedId: "key",
            P2P_managedToken: "secret",
            P2P_iceServers: [{ urls: "turn:turn.example.com", credential: "issued-secret" }],
            P2P_iceServersExpiresAt: 123_456,
            remoteConfigurations: {
                p2p: {
                    id: "p2p",
                    name: "Managed P2P",
                    uri: profileURI,
                    isEncrypted: false,
                },
            },
        };

        const uri = await encodeSettingsToSetupURI(settings, "setup-pass", [], false);
        expect(uri.startsWith(configURIBase)).toBe(true);

        const encrypted = decodeURIComponent(uri.trim().slice(configURIBase.length));
        const payload = JSON.parse(await decryptString(encrypted, "setup-pass"));
        expect(payload).not.toHaveProperty("P2P_managedType");
        expect(payload).not.toHaveProperty("P2P_managedId");
        expect(payload).not.toHaveProperty("P2P_managedToken");
        expect(payload).not.toHaveProperty("P2P_iceServers");
        expect(payload).not.toHaveProperty("P2P_iceServersExpiresAt");
        expect(payload.remoteConfigurations.p2p.uri).toBe(profileURI);
        expect(payload.activeConfigurationId).toBe("couch");
        expect(payload.P2P_ActiveRemoteConfigurationId).toBe("p2p");
        expect(payload.P2P_DevicePeerName).toBe("receiver-device");
        expect(payload).not.toHaveProperty("version");
        expect(payload).not.toHaveProperty("settings");

        const decoded = await decodeSettingsFromSetupURI(uri, "setup-pass");
        expect(decoded && decoded.remoteConfigurations.p2p.uri).toBe(profileURI);
    });

    it("keeps legacy Setup URI output and decoding for manual settings", async () => {
        const settings = {
            ...DEFAULT_SETTINGS,
            P2P_roomID: "manual-room",
            P2P_turnServers: "turn:example.test:3478",
        };
        const uri = await encodeSettingsToSetupURI(settings, "setup-pass", [], false);
        expect(uri.startsWith(configURIBase)).toBe(true);
        const decoded = await decodeSettingsFromSetupURI(uri, "setup-pass");
        expect(decoded && decoded.P2P_roomID).toBe("manual-room");
        expect(decoded && "P2P_iceServers" in decoded).toBe(false);
    });

    it("shares the derived ID key and version in Setup URIs without the persisted wrapper", async () => {
        const key = "12".repeat(32);
        const uri = await encodeSettingsToSetupURI(
            {
                ...DEFAULT_SETTINGS,
                idDerivationVersion: 1,
                idDerivationKey: key,
                encryptedIdDerivationKey: "persisted-encrypted-wrapper",
            },
            "setup-pass",
            [],
            false
        );

        const encrypted = decodeURIComponent(uri.trim().slice(configURIBase.length));
        const payload = JSON.parse(await decryptString(encrypted, "setup-pass"));
        expect(payload.idDerivationVersion).toBe(1);
        expect(payload.idDerivationKey).toBe(key);
        expect(payload.encryptedIdDerivationKey).toBe("");

        const decoded = await decodeSettingsFromSetupURI(uri, "setup-pass");
        expect(decoded && decoded.idDerivationVersion).toBe(1);
        expect(decoded && decoded.idDerivationKey).toBe(key);
    });

    it("completes an old Setup URI without the new preferences as legacy defaults", async () => {
        const payload: Partial<typeof DEFAULT_SETTINGS> = { ...DEFAULT_SETTINGS };
        delete payload.encryptInternalMetadata;
        delete payload.idDerivationVersion;
        delete payload.idDerivationKey;
        const encrypted = await encryptString(JSON.stringify(payload), "setup-pass");
        const decoded = await decodeSettingsFromSetupURI(
            `${configURIBase}${encodeURIComponent(encrypted)}`,
            "setup-pass"
        );
        expect(decoded && decoded.encryptInternalMetadata).toBe(false);
        expect(decoded && decoded.idDerivationVersion).toBe(0);
        expect(decoded && decoded.idDerivationKey).toBe("");
    });

    it("rejects a Setup URI with a version but no derived key", async () => {
        const payload: Partial<typeof DEFAULT_SETTINGS> = { ...DEFAULT_SETTINGS, idDerivationVersion: 1 };
        delete payload.idDerivationKey;
        const encrypted = await encryptString(JSON.stringify(payload), "setup-pass");
        await expect(
            decodeSettingsFromSetupURI(`${configURIBase}${encodeURIComponent(encrypted)}`, "setup-pass")
        ).resolves.toBe(false);
    });

    it("discards runtime ICE fields from incoming Setup URI data", async () => {
        const encrypted = await encryptString(
            JSON.stringify({
                ...DEFAULT_SETTINGS,
                P2P_iceServers: [{ urls: "turn:external.example.com", credential: "external-secret" }],
                P2P_iceServersExpiresAt: 999_999,
            }),
            "setup-pass"
        );

        const decoded = await decodeSettingsFromSetupURI(
            `${configURIBase}${encodeURIComponent(encrypted)}`,
            "setup-pass"
        );

        expect(decoded).not.toHaveProperty("P2P_iceServers");
        expect(decoded).not.toHaveProperty("P2P_iceServersExpiresAt");
    });

    it.each(["structured", "bare"])("does not log provider tokens from malformed %s Setup payloads", async (kind) => {
        const token = "TURNSECRET";
        const malformedPayload = kind === "bare" ? token : `{"P2P_managedToken":"${token}"}BROKEN`;
        const encrypted = await encryptString(malformedPayload, "setup-pass");
        const logger = vi.fn();
        setGlobalLogFunction(logger);
        try {
            const result = await decodeSettingsFromSetupURI(
                `${configURIBase}${encodeURIComponent(encrypted)}`,
                "setup-pass"
            );
            expect(result).toBe(false);
            const messages = logger.mock.calls.map(([message]) => String(message)).join("\n");
            expect(messages).toContain("Failed to parse settings from decrypted data");
            expect(messages).not.toContain(token);
        } finally {
            setGlobalLogFunction(defaultLogger);
        }
    });

    it("propagates Setup URI decryption failures", async () => {
        await expect(decodeSettingsFromSetupURI(`${configURIBase}not-encrypted`, "setup-pass")).rejects.toThrow(
            "Unsupported encryption format"
        );
    });
});

describe("Time-bound Setup URI compatibility", () => {
    const settings = {
        ...DEFAULT_SETTINGS,
        isConfigured: true,
        couchDB_URI: "https://example.invalid",
        couchDB_PASSWORD: "synthetic-secret",
    };
    const passphrase = "setup-pass";
    const createdAt = Date.parse("2026-09-28T12:00:00Z");
    const endOfWindow = Date.parse("2026-10-01T00:00:00Z");

    it("reports the exact end of the window before generation", () => {
        const clock = vi.spyOn(Date, "now").mockReturnValue(createdAt);
        try {
            expect(getTimeBoundSetupURIUsableUntil()).toBe(endOfWindow);
            clock.mockReturnValue(endOfWindow);
            expect(getTimeBoundSetupURIUsableUntil()).toBe(endOfWindow + 604_800_000);
            clock.mockReturnValue(Number.NaN);
            expect(getTimeBoundSetupURIUsableUntil).toThrow("Invalid Setup URI clock");
        } finally {
            clock.mockRestore();
        }
    });

    it("makes Persistent readable by the existing passphrase and wire format", async () => {
        const generated = await encodeTimeBoundSetupURI(settings, passphrase, { mode: "persistent" });

        expect(generated.usableUntil).toBeNull();
        const encrypted = decodeURIComponent(generated.uri.trim().slice(configURIBase.length));
        expect(encrypted.startsWith("%$")).toBe(true);
        const oldReaderSettings = JSON.parse(await decryptString(encrypted, passphrase));
        expect(oldReaderSettings.couchDB_PASSWORD).toBe(settings.couchDB_PASSWORD);
    });

    it("opens Ephemeral only within its fixed UTC window", async () => {
        const clock = vi.spyOn(Date, "now").mockReturnValue(createdAt);
        try {
            const generated = await encodeTimeBoundSetupURI(settings, passphrase, { mode: "ephemeral" });
            expect(generated.usableUntil).toBe(endOfWindow);
            expect(isTimeBoundSetupURIUsableNow(generated.usableUntil)).toBe(true);
            const encrypted = decodeURIComponent(generated.uri.trim().slice(configURIBase.length));
            expect(encrypted.startsWith("%$")).toBe(true);
            await expect(decryptString(encrypted, passphrase)).rejects.toThrow();
            expect((await decodeSettingsFromSetupURI(generated.uri.trim(), passphrase)).couchDB_PASSWORD).toBe(
                settings.couchDB_PASSWORD
            );

            clock.mockReturnValue(endOfWindow);
            expect(isTimeBoundSetupURIUsableNow(generated.usableUntil)).toBe(false);
            await expect(decodeSettingsFromSetupURI(generated.uri.trim(), passphrase)).rejects.toThrow();
            clock.mockReturnValue(createdAt - 604_800_000);
            expect(isTimeBoundSetupURIUsableNow(generated.usableUntil)).toBe(false);
        } finally {
            clock.mockRestore();
        }
    });

    it("keeps existing URIs readable in the updated reader", async () => {
        const legacy = await encodeSettingsToSetupURI(settings, passphrase);
        const clock = vi.spyOn(Date, "now").mockReturnValue(endOfWindow + 100 * 604_800_000);
        try {
            const decoded = await decodeSettingsFromSetupURI(legacy.trim(), passphrase);
            expect(decoded.couchDB_PASSWORD).toBe(settings.couchDB_PASSWORD);
        } finally {
            clock.mockRestore();
        }
    });

    it("keeps Persistent readable when the device clock is invalid", async () => {
        const clock = vi.spyOn(Date, "now").mockReturnValue(Number.NaN);
        try {
            const generated = await encodeTimeBoundSetupURI(settings, passphrase, { mode: "persistent" });
            expect(isTimeBoundSetupURIUsableNow(generated.usableUntil)).toBe(true);
            const decoded = await decodeSettingsFromSetupURI(generated.uri.trim(), passphrase);
            expect(decoded.couchDB_PASSWORD).toBe(settings.couchDB_PASSWORD);
        } finally {
            clock.mockRestore();
        }
    });

    it("uses the specified full-length Ephemeral passphrase derivation", async () => {
        const window = 1_234;
        const clock = vi.spyOn(Date, "now").mockReturnValue(window * 604_800_000 + 1);
        try {
            const generated = await encodeTimeBoundSetupURI(settings, "test-passphrase");
            const encrypted = decodeURIComponent(generated.uri.trim().slice(configURIBase.length));
            const payload = await decryptString(
                encrypted,
                "b39361c51f0b7bd835554db1dffbc9a540fb30789aa62bf53e39e07d1073013b"
            );
            expect(JSON.parse(payload).couchDB_PASSWORD).toBe(settings.couchDB_PASSWORD);
        } finally {
            clock.mockRestore();
        }
    });

    it("returns one generic opening failure for a wrong passphrase or an old window", async () => {
        const clock = vi.spyOn(Date, "now").mockReturnValue(createdAt);
        try {
            const generated = await encodeTimeBoundSetupURI(settings, passphrase);
            await expect(decodeSettingsFromSetupURI(generated.uri.trim(), "wrong-passphrase")).rejects.toThrow(
                "Cannot open Setup URI"
            );
            clock.mockReturnValue(endOfWindow);
            await expect(decodeSettingsFromSetupURI(generated.uri.trim(), passphrase)).rejects.toThrow(
                "Cannot open Setup URI"
            );
        } finally {
            clock.mockRestore();
        }
    });
});
