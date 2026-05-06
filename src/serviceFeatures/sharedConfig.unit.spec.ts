import { it, expect, describe, beforeEach, vi } from "vitest";
import {
    extractSharedSettings,
    hasSharedSettingsDifferences,
    applyAutoConfigurationIfNeeded,
    enableAutoConfigurationInteractive,
    fetchSharedConfig,
    writeSharedConfig,
    useSharedConfigFeature,
} from "./sharedConfig";
import { AutoConfigSyncableKeys } from "../common/models/setting.type";

describe("SharedConfig Feature", () => {
    let mockHost: any;

    beforeEach(() => {
        mockHost = {
            services: {
                setting: {
                    settings: {
                        useAutoConfig: true,
                        hashAlg: "sha256",
                        chunkSplitterVersion: 2,
                        enableChunkSplitterV2: true,
                        useSegmenter: false,
                        minimumChunkSize: 10,
                        customChunkSize: 20,
                    },
                    saveSettings: vi.fn().mockResolvedValue(true),
                    addLog: vi.fn(),
                    onSettingSaved: { addHandler: vi.fn() },
                },
                database: {
                    localDatabase: {
                        getDB: vi.fn().mockReturnValue({
                            get: vi.fn(),
                        }),
                        putRaw: vi.fn().mockResolvedValue({}),
                    },
                    reopenDatabase: vi.fn().mockResolvedValue(true),
                },
                UI: {
                    confirm: {
                        askYesNoDialog: vi.fn().mockResolvedValue("yes"),
                    },
                },
                replication: {
                    onBeforeReplicate: { addHandler: vi.fn() },
                },
            },
        };
    });

    describe("Core Logic", () => {
        it("extractSharedSettings extracts only syncable keys", () => {
            const mockSettings: any = {
                ...mockHost.services.setting.settings,
                otherSetting: "should not be included",
            };

            const extracted = extractSharedSettings(mockSettings);

            expect(extracted).toHaveProperty("hashAlg", "sha256");
            expect(extracted).toHaveProperty("chunkSplitterVersion", 2);
            expect(extracted).not.toHaveProperty("useAutoConfig");
            expect(extracted).not.toHaveProperty("otherSetting");
            expect(Object.keys(extracted).length).toBe(AutoConfigSyncableKeys.length);
        });

        it("hasSharedSettingsDifferences correctly detects differences", () => {
            const local = extractSharedSettings(mockHost.services.setting.settings);
            const remote = { ...local, hashAlg: "xxhash" };

            expect(hasSharedSettingsDifferences(local, remote)).toBe(true);
            expect(hasSharedSettingsDifferences(local, { ...local } as any)).toBe(false);
        });

        it("hasSharedSettingsDifferences detects variations in all keys", () => {
            const local = extractSharedSettings(mockHost.services.setting.settings) as any;

            for (const key of AutoConfigSyncableKeys) {
                const remote = { ...local };
                const originalValue = remote[key];
                if (typeof originalValue === "number") {
                    remote[key] = originalValue + 1;
                } else if (typeof originalValue === "boolean") {
                    remote[key] = !originalValue;
                } else {
                    remote[key] = (originalValue || "") + "_diff";
                }
                expect(hasSharedSettingsDifferences(local, remote)).toBe(true);
            }
        });
    });

    describe("applyAutoConfigurationIfNeeded", () => {
        it("does nothing if disabled in settings", async () => {
            mockHost.services.setting.settings.useAutoConfig = false;
            const result = await applyAutoConfigurationIfNeeded(mockHost);
            expect(result).toBe(false);
            expect(mockHost.services.database.localDatabase.getDB).not.toHaveBeenCalled();
        });

        it("fetches and applies config when enabled and different", async () => {
            const remoteSettings = { ...extractSharedSettings(mockHost.services.setting.settings), hashAlg: "xxhash" };
            mockHost.services.database.localDatabase
                .getDB()
                .get.mockResolvedValue({ type: "shared_config", settings: remoteSettings });

            const result = await applyAutoConfigurationIfNeeded(mockHost);

            expect(result).toBe(true);
            expect(mockHost.services.setting.settings.hashAlg).toBe("xxhash");
            expect(mockHost.services.setting.saveSettings).toHaveBeenCalled();
            expect(mockHost.services.database.reopenDatabase).toHaveBeenCalled();
        });

        it("does not apply if settings are identical", async () => {
            const remoteSettings = extractSharedSettings(mockHost.services.setting.settings);
            mockHost.services.database.localDatabase
                .getDB()
                .get.mockResolvedValue({ type: "shared_config", settings: remoteSettings });

            const result = await applyAutoConfigurationIfNeeded(mockHost);

            expect(result).toBe(false);
            expect(mockHost.services.setting.saveSettings).not.toHaveBeenCalled();
        });

        it("returns false if remote config not found (404)", async () => {
            mockHost.services.database.localDatabase.getDB().get.mockRejectedValue({ status: 404 });
            const result = await applyAutoConfigurationIfNeeded(mockHost);
            expect(result).toBe(false);
        });
    });

    describe("enableAutoConfigurationInteractive", () => {
        it("prompts to upload when no remote config exists", async () => {
            mockHost.services.database.localDatabase.getDB().get.mockRejectedValue({ status: 404 });
            mockHost.services.UI.confirm.askYesNoDialog.mockResolvedValue("yes");

            const result = await enableAutoConfigurationInteractive(mockHost);

            expect(result).toBe(true);
            expect(mockHost.services.setting.settings.useAutoConfig).toBe(true);
            expect(mockHost.services.UI.confirm.askYesNoDialog).toHaveBeenCalled();
            expect(mockHost.services.database.localDatabase.putRaw).toHaveBeenCalled();
        });

        it("asks to apply when remote config exists and is different", async () => {
            const remoteSettings = { ...extractSharedSettings(mockHost.services.setting.settings), hashAlg: "xxhash" };
            mockHost.services.database.localDatabase
                .getDB()
                .get.mockResolvedValue({ type: "shared_config", settings: remoteSettings });
            mockHost.services.UI.confirm.askYesNoDialog.mockResolvedValue("yes");

            const result = await enableAutoConfigurationInteractive(mockHost);

            expect(result).toBe(true);
            expect(mockHost.services.setting.settings.hashAlg).toBe("xxhash");
            expect(mockHost.services.database.reopenDatabase).toHaveBeenCalled();
        });

        it("simply enables if remote config is already identical", async () => {
            const remoteSettings = extractSharedSettings(mockHost.services.setting.settings);
            mockHost.services.database.localDatabase
                .getDB()
                .get.mockResolvedValue({ type: "shared_config", settings: remoteSettings });

            const result = await enableAutoConfigurationInteractive(mockHost);

            expect(result).toBe(true);
            expect(mockHost.services.UI.confirm.askYesNoDialog).not.toHaveBeenCalled();
        });

        it("aborts if user declines overriting with remote config", async () => {
            mockHost.services.database.localDatabase
                .getDB()
                .get.mockResolvedValue({ type: "shared_config", settings: { hashAlg: "xxhash" } });
            mockHost.services.UI.confirm.askYesNoDialog.mockResolvedValue("no");

            const result = await enableAutoConfigurationInteractive(mockHost);
            expect(result).toBe(false);
            // In the implementation, it doesn't set it to false explicitly if it was already false, it just returns false and doesn't set it to true.
        });
    });

    describe("Error Handling & Edge Cases", () => {
        it("fetchSharedConfig returns null and logs error on generic exceptions", async () => {
            const dbError = new Error("DB Error");
            mockHost.services.database.localDatabase.getDB().get.mockRejectedValue(dbError);
            const logSpy = vi.fn();

            const result = await fetchSharedConfig(mockHost.services.database, logSpy);
            expect(result).toBeNull();
            expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("Failed to fetch"), expect.anything());
        });

        it("fetchSharedConfig returns null if db is not ready", async () => {
            mockHost.services.database.localDatabase = null;
            const result = await fetchSharedConfig(mockHost.services.database);
            expect(result).toBeNull();
        });

        it("writeSharedConfig returns false and logs error on exception", async () => {
            mockHost.services.database.localDatabase.putRaw.mockRejectedValue(new Error("Write Failed"));
            const logSpy = vi.fn();
            const result = await writeSharedConfig(mockHost.services.database, {} as any, logSpy);
            expect(result).toBe(false);
            expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("Failed to write"), expect.anything());
        });

        it("writeSharedConfig returns false if database is missing", async () => {
            mockHost.services.database.localDatabase = null;
            const logSpy = vi.fn();
            const result = await writeSharedConfig(mockHost.services.database, {} as any, logSpy);
            expect(result).toBe(false);
            expect(logSpy).toHaveBeenCalledWith("Database not ready.", expect.anything());
        });
    });

    describe("useSharedConfigFeature", () => {
        it("registers handlers correctly", () => {
            useSharedConfigFeature(mockHost);
            expect(mockHost.services.setting.onSettingSaved.addHandler).toHaveBeenCalled();
            expect(mockHost.services.replication.onBeforeReplicate.addHandler).toHaveBeenCalled();
        });

        it("onSettingSaved handler uploads if changed", async () => {
            useSharedConfigFeature(mockHost);
            const handler = mockHost.services.setting.onSettingSaved.addHandler.mock.calls[0][0];

            // Remote is diff
            mockHost.services.database.localDatabase.getDB().get.mockResolvedValue({
                type: "shared_config",
                settings: { ...extractSharedSettings(mockHost.services.setting.settings), hashAlg: "xxhash" },
            });

            await handler();
            expect(mockHost.services.database.localDatabase.putRaw).toHaveBeenCalled();
        });

        it("onSettingSaved handler does nothing if disabled", async () => {
            mockHost.services.setting.settings.useAutoConfig = false;
            useSharedConfigFeature(mockHost);
            const handler = mockHost.services.setting.onSettingSaved.addHandler.mock.calls[0][0];
            await handler();
            expect(mockHost.services.database.localDatabase.getDB).not.toHaveBeenCalled();
        });

        it("onBeforeReplicate handler applies config and returns false if applied", async () => {
            useSharedConfigFeature(mockHost);
            const handler = mockHost.services.replication.onBeforeReplicate.addHandler.mock.calls[0][0];

            // Remote is diff
            mockHost.services.database.localDatabase.getDB().get.mockResolvedValue({
                type: "shared_config",
                settings: { ...extractSharedSettings(mockHost.services.setting.settings), hashAlg: "xxhash" },
            });

            const result = await handler(true);
            expect(result).toBe(false);
            expect(mockHost.services.setting.saveSettings).toHaveBeenCalled();
        });

        it("onBeforeReplicate handler returns true if not applied", async () => {
            useSharedConfigFeature(mockHost);
            const handler = mockHost.services.replication.onBeforeReplicate.addHandler.mock.calls[0][0];

            // Same settings
            mockHost.services.database.localDatabase.getDB().get.mockResolvedValue({
                type: "shared_config",
                settings: extractSharedSettings(mockHost.services.setting.settings),
            });

            const result = await handler(true);
            expect(result).toBe(true);
        });

        it("onBeforeReplicate handler returns true if disabled", async () => {
            mockHost.services.setting.settings.useAutoConfig = false;
            useSharedConfigFeature(mockHost);
            const handler = mockHost.services.replication.onBeforeReplicate.addHandler.mock.calls[0][0];
            const result = await handler(true);
            expect(result).toBe(true);
        });
    });

    describe("triggerEnableAutoConfiguration", () => {
        it("calls enableAutoConfigurationInteractive", async () => {
            const { triggerEnableAutoConfiguration } = await import("./sharedConfig");
            mockHost.services.database.localDatabase.getDB().get.mockRejectedValue({ status: 404 });
            mockHost.services.UI.confirm.askYesNoDialog.mockResolvedValue("no");

            const result = await triggerEnableAutoConfiguration(mockHost);
            expect(result).toBe(false);
        });
    });
});
