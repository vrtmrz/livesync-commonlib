import { describe, it, expect, vi, beforeEach } from "vitest";
import {
    migrateLegacyRemoteConfigurationsInPlace,
    migrateToMultipleRemoteConfigurations,
    activateRemoteConfiguration,
    upsertRemoteConfigurationInPlace,
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

describe("Remote Configuration Registration", () => {
    it("adds and activates a CouchDB profile without replacing existing profiles", () => {
        const settings = {
            remoteConfigurations: {
                existing: {
                    id: "existing",
                    name: "Existing remote",
                    uri: "sls+http://old:secret@old.example/?db=old",
                    isEncrypted: false,
                },
            },
            activeConfigurationId: "existing",
            P2P_ActiveRemoteConfigurationId: "",
            remoteType: REMOTE_P2P,
            couchDB_URI: "https://couch.example/vault",
            couchDB_USER: "alice",
            couchDB_PASSWORD: "secret",
            couchDB_DBNAME: "notes",
            couchDB_CustomHeaders: "",
            useJWT: false,
            jwtAlgorithm: "",
            jwtKey: "",
            jwtKid: "",
            jwtSub: "",
            jwtExpDuration: 5,
            useRequestAPI: false,
        } as ObsidianLiveSyncSettings;

        const profile = upsertRemoteConfigurationInPlace(settings, "couchdb", { activate: true });

        expect(settings.remoteConfigurations.existing).toBeDefined();
        expect(Object.keys(settings.remoteConfigurations)).toHaveLength(2);
        expect(profile.id).toMatch(/^remote-/);
        expect(profile).toEqual(settings.remoteConfigurations[profile.id]);
        expect(profile.name).toBe("CouchDB couch.example");
        expect(profile.uri).toContain("sls+https://alice:secret@couch.example/vault");
        expect(settings.activeConfigurationId).toBe(profile.id);
        expect(settings.remoteType).toBe(REMOTE_COUCHDB);
    });

    it("gives generated display names a suffix instead of treating a name as an identifier", () => {
        const settings = {
            remoteConfigurations: {
                existing: {
                    id: "existing",
                    name: "S3 notes",
                    uri: "sls+s3://old:secret@storage.example/?bucket=old",
                    isEncrypted: false,
                },
            },
            activeConfigurationId: "existing",
            endpoint: "https://storage.example",
            accessKey: "key",
            secretKey: "secret",
            bucket: "notes",
            region: "auto",
            bucketPrefix: "",
            useCustomRequestHandler: false,
            bucketCustomHeaders: "",
            forcePathStyle: true,
        } as ObsidianLiveSyncSettings;

        const profile = upsertRemoteConfigurationInPlace(settings, "s3", {
            id: "onboarding-s3",
        });

        expect(profile.name).toBe("S3 notes (2)");
        expect(settings.activeConfigurationId).toBe("existing");
    });

    it("can select a P2P profile without replacing the main active remote", () => {
        const settings = {
            remoteConfigurations: {
                couch: {
                    id: "couch",
                    name: "Primary CouchDB",
                    uri: "sls+http://user:secret@localhost:5984/?db=vault",
                    isEncrypted: false,
                },
            },
            activeConfigurationId: "couch",
            P2P_ActiveRemoteConfigurationId: "",
            remoteType: REMOTE_COUCHDB,
            P2P_Enabled: true,
            P2P_roomID: "team-room",
            P2P_passphrase: "secret",
            P2P_relays: "wss://relay.example",
            P2P_AppID: "self-hosted-livesync",
            P2P_AutoStart: true,
            P2P_AutoBroadcast: false,
            P2P_turnServers: "",
            P2P_turnUsername: "",
            P2P_turnCredential: "",
        } as ObsidianLiveSyncSettings;

        const profile = upsertRemoteConfigurationInPlace(settings, "p2p", {
            id: "onboarding-p2p",
            activateForP2P: true,
        });

        expect(profile.name).toBe("P2P team-room");
        expect(settings.activeConfigurationId).toBe("couch");
        expect(settings.remoteType).toBe(REMOTE_COUCHDB);
        expect(settings.P2P_ActiveRemoteConfigurationId).toBe("onboarding-p2p");
    });

    it("updates a known P2P profile without replacing its display name", () => {
        const settings = {
            remoteConfigurations: {
                p2p: {
                    id: "p2p",
                    name: "My phone",
                    uri: "sls+p2p://old-room?passphrase=old",
                    isEncrypted: false,
                },
            },
            activeConfigurationId: "",
            P2P_ActiveRemoteConfigurationId: "p2p",
            remoteType: REMOTE_COUCHDB,
            P2P_Enabled: true,
            P2P_roomID: "new-room",
            P2P_passphrase: "new-secret",
            P2P_relays: "wss://relay.example",
            P2P_AppID: "self-hosted-livesync",
            P2P_AutoStart: true,
            P2P_AutoBroadcast: false,
            P2P_turnServers: "",
            P2P_turnUsername: "",
            P2P_turnCredential: "",
        } as ObsidianLiveSyncSettings;

        const profile = upsertRemoteConfigurationInPlace(settings, "p2p", {
            id: "p2p",
            activateForP2P: true,
        });

        expect(Object.keys(settings.remoteConfigurations)).toEqual(["p2p"]);
        expect(profile.name).toBe("My phone");
        expect(profile.uri).toContain("new-room");
        expect(settings.P2P_ActiveRemoteConfigurationId).toBe("p2p");
    });

    it("rejects a non-P2P selection without partially registering the profile", () => {
        const settings = {
            remoteConfigurations: {},
            activeConfigurationId: "",
            P2P_ActiveRemoteConfigurationId: "",
            remoteType: REMOTE_COUCHDB,
            couchDB_URI: "https://couch.example/vault",
            couchDB_USER: "alice",
            couchDB_PASSWORD: "secret",
            couchDB_DBNAME: "notes",
            couchDB_CustomHeaders: "",
            useJWT: false,
            jwtAlgorithm: "",
            jwtKey: "",
            jwtKid: "",
            jwtSub: "",
            jwtExpDuration: 5,
            useRequestAPI: false,
        } as ObsidianLiveSyncSettings;
        const before = JSON.parse(JSON.stringify(settings)) as ObsidianLiveSyncSettings;

        expect(() =>
            upsertRemoteConfigurationInPlace(settings, "couchdb", {
                id: "invalid-p2p-selection",
                activateForP2P: true,
            })
        ).toThrow("Only a P2P remote configuration can be selected for P2P features.");

        expect(settings).toEqual(before);
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
