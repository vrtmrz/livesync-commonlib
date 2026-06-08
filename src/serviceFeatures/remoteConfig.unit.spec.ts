import { describe, it, expect, vi, beforeEach } from "vitest";
import {
    migrateLegacyRemoteConfigurationsInPlace,
    migrateToMultipleRemoteConfigurations,
    activateRemoteConfiguration,
} from "@lib/serviceFeatures/remoteConfig";
import { REMOTE_COUCHDB, REMOTE_MINIO, REMOTE_P2P } from "@lib/common/models/setting.const";
import type { ObsidianLiveSyncSettings } from "@lib/common/models/setting.type";

describe("Remote Configuration Migration", () => {
    let mockSettings: Partial<ObsidianLiveSyncSettings>;
    let mockHost: any;

    beforeEach(() => {
        mockSettings = {
            couchDB_URI: "",
            accessKey: "",
            P2P_roomID: "",
            remoteType: REMOTE_COUCHDB,
            remoteConfigurations: {},
            activeConfigurationId: "",
        };

        mockHost = {
            services: {
                setting: {
                    currentSettings: vi.fn(() => mockSettings as ObsidianLiveSyncSettings),
                    saveSettingData: vi.fn(() => Promise.resolve()),
                },
                appLifecycle: {
                    onInitialise: Promise.resolve(),
                },
            },
        };
    });

    it("should migrate existing CouchDB settings to a new remote configuration", async () => {
        mockSettings.couchDB_URI = "http://localhost:5984";
        mockSettings.couchDB_USER = "user";
        mockSettings.couchDB_PASSWORD = "password";
        mockSettings.couchDB_DBNAME = "vault";

        const result = await migrateToMultipleRemoteConfigurations(mockHost);

        expect(result).toBe(true);
        const configs = Object.values(mockSettings.remoteConfigurations || {});
        expect(configs).toHaveLength(1);
        expect(configs[0].name).toBe("CouchDB Remote");
        const uri = configs[0].uri;
        expect(uri).toContain("sls+http://user:password@localhost:5984");
        expect(uri).toContain("db=vault");
        expect(mockSettings.activeConfigurationId).toBe(configs[0].id);
        expect(mockHost.services.setting.saveSettingData).toHaveBeenCalled();
    });

    it("should migrate existing S3 (Minio) settings", async () => {
        mockSettings.remoteType = REMOTE_MINIO;
        mockSettings.accessKey = "access";
        mockSettings.secretKey = "secret";
        mockSettings.endpoint = "https://s3.amazonaws.com";
        mockSettings.bucket = "mybucket";
        mockSettings.region = "auto";

        const result = await migrateToMultipleRemoteConfigurations(mockHost);

        expect(result).toBe(true);
        const configs = Object.values(mockSettings.remoteConfigurations || {});
        expect(configs[0].uri).toContain("sls+s3://access:secret@s3.amazonaws.com");
        expect(configs[0].uri).toContain("bucket=mybucket");
    });

    it("should migrate existing P2P settings", async () => {
        mockSettings.remoteType = REMOTE_P2P;
        mockSettings.P2P_roomID = "room 123";
        mockSettings.P2P_passphrase = "pass";
        mockSettings.P2P_relays = "relay1";
        mockSettings.P2P_AppID = "app1";

        const result = await migrateToMultipleRemoteConfigurations(mockHost);

        expect(result).toBe(true);
        const configs = Object.values(mockSettings.remoteConfigurations || {});
        expect(configs[0].uri).toContain("room%20123");
    });

    it("should migrate all configured legacy remotes and keep active based on remoteType", async () => {
        mockSettings.remoteType = REMOTE_MINIO;
        mockSettings.couchDB_URI = "http://localhost:5984";
        mockSettings.couchDB_USER = "user";
        mockSettings.couchDB_PASSWORD = "password";
        mockSettings.couchDB_DBNAME = "vault";

        mockSettings.accessKey = "access";
        mockSettings.secretKey = "secret";
        mockSettings.endpoint = "https://s3.amazonaws.com";
        mockSettings.bucket = "mybucket";
        mockSettings.region = "auto";

        mockSettings.P2P_roomID = "room-abc";
        mockSettings.P2P_passphrase = "pass";
        mockSettings.P2P_relays = "relay1";
        mockSettings.P2P_AppID = "app1";

        const result = await migrateToMultipleRemoteConfigurations(mockHost);

        expect(result).toBe(true);
        const configs = mockSettings.remoteConfigurations || {};
        expect(Object.keys(configs)).toHaveLength(3);
        expect(configs["legacy-couchdb"]?.uri).toContain("sls+http://");
        expect(configs["legacy-s3"]?.uri).toContain("sls+s3://");
        expect(configs["legacy-p2p"]?.uri).toContain("sls+p2p://");
        expect(mockSettings.activeConfigurationId).toBe("legacy-s3");
    });

    it("should not migrate if remoteConfigurations is already populated", async () => {
        mockSettings.couchDB_URI = "http://localhost:5984";
        mockSettings.remoteConfigurations = {
            existing: { id: "existing", name: "Existing", uri: "...", isEncrypted: false },
        };

        const result = await migrateToMultipleRemoteConfigurations(mockHost);

        expect(result).toBe(false);
        expect(Object.keys(mockSettings.remoteConfigurations || {})).toHaveLength(1);
    });

    it("should not migrate if no remote settings are present", async () => {
        const result = await migrateToMultipleRemoteConfigurations(mockHost);
        expect(result).toBe(false);
    });

    it("should migrate legacy remote settings in place without host services", () => {
        mockSettings.couchDB_URI = "http://localhost:5984";
        mockSettings.couchDB_USER = "user";
        mockSettings.couchDB_PASSWORD = "password";
        mockSettings.couchDB_DBNAME = "vault";

        const result = migrateLegacyRemoteConfigurationsInPlace(mockSettings as ObsidianLiveSyncSettings);

        expect(result).toBe(true);
        expect(mockSettings.remoteConfigurations?.["legacy-couchdb"]?.uri).toContain(
            "sls+http://user:password@localhost:5984"
        );
        expect(mockSettings.activeConfigurationId).toBe("legacy-couchdb");
    });
});

describe("Remote Configuration Activation", () => {
    it("should correctly set settings when activating a remote configuration", () => {
        const settings = {
            remoteConfigurations: {
                "target-remote": {
                    id: "target-remote",
                    name: "Target Remote",
                    uri: "sls+http://user:pass@localhost:5984/?db=db",
                    isEncrypted: false,
                },
            },
            activeConfigurationId: "",
            remoteType: REMOTE_P2P, // Initially different
        } as any;

        const result = activateRemoteConfiguration(settings, "target-remote");

        expect(result).toBe(settings);
        expect(settings.activeConfigurationId).toBe("target-remote");
        expect(settings.remoteType).toBe(REMOTE_COUCHDB);
        expect(settings.couchDB_URI).toBe("http://localhost:5984");
        expect(settings.couchDB_URI).toContain("localhost:5984");
        expect(settings.couchDB_DBNAME).toBe("db");
        expect(settings.couchDB_USER).toBe("user");
        expect(settings.couchDB_PASSWORD).toBe("pass");
    });

    it("should return false if configuration ID is not found", () => {
        const settings = { remoteConfigurations: {} } as any;
        const result = activateRemoteConfiguration(settings, "non-existent");
        expect(result).toBe(false);
    });

    it("should return false if configuration URI is invalid", () => {
        const settings = {
            remoteConfigurations: {
                "invalid-remote": {
                    id: "invalid-remote",
                    name: "Invalid",
                    uri: "invalid-uri",
                    isEncrypted: false,
                },
            },
            activeConfigurationId: "",
        } as any;
        const result = activateRemoteConfiguration(settings, "invalid-remote");
        expect(result).toBe(false);
    });
});

describe("Remote Configuration Commands", () => {
    let mockSettings: any;
    let mockHost: any;

    beforeEach(() => {
        mockSettings = {
            remoteConfigurations: {
                r1: { id: "r1", name: "Remote 1", uri: "sls+http://user:pass@host/db1", isEncrypted: false },
                r2: { id: "r2", name: "Remote 2", uri: "sls+http://user:pass@host/db2", isEncrypted: false },
            },
            activeConfigurationId: "r1",
        };

        mockHost = {
            services: {
                setting: {
                    currentSettings: vi.fn(() => mockSettings),
                    updateSettings: vi.fn((updater: (settings: any) => any) => {
                        mockSettings = updater(mockSettings);
                        return Promise.resolve();
                    }),
                    saveSettingData: vi.fn(() => Promise.resolve()),
                },
                UI: {
                    confirm: {
                        askSelectString: vi.fn(),
                    },
                },
                API: {
                    addLog: vi.fn(),
                    addCommand: vi.fn(),
                },
                control: {
                    applySettings: vi.fn(() => Promise.resolve()),
                },
                replication: {
                    replicate: vi.fn(() => Promise.resolve()),
                },
                appLifecycle: {
                    onInitialise: Promise.resolve(),
                },
            },
        };
    });

    it("commandSwitchActiveRemote should switch configuration based on user selection", async () => {
        const { commandSwitchActiveRemote } = await import("@lib/serviceFeatures/remoteConfig");
        mockHost.services.UI.confirm.askSelectString.mockResolvedValue("Remote 2 (Inactive)");

        await commandSwitchActiveRemote(mockHost);

        expect(mockSettings.activeConfigurationId).toBe("r2");
        expect(mockHost.services.control.applySettings).toHaveBeenCalled();
        expect(mockHost.services.setting.saveSettingData).toHaveBeenCalled();
    });

    it("commandReplicateWithSpecificRemote should switch and replicate", async () => {
        const { commandReplicateWithSpecificRemote } = await import("@lib/serviceFeatures/remoteConfig");
        mockHost.services.UI.confirm.askSelectString.mockResolvedValue("Remote 2");

        await commandReplicateWithSpecificRemote(mockHost);

        expect(mockSettings.activeConfigurationId).toBe("r2");
        expect(mockHost.services.replication.replicate).toHaveBeenCalledWith(true);
    });
});
