import { describe, expect, it, vi } from "vitest";
import { CURRENT_SETTING_VERSION, DEFAULT_SETTINGS, REMOTE_COUCHDB } from "@lib/common/types";
import { SettingService } from "./SettingService";
import { ServiceContext } from "./ServiceBase";
import type { ObsidianLiveSyncSettings } from "@lib/common/types";
import { ConnectionStringParser } from "@lib/common/ConnectionString";

class TestSettingService extends SettingService<ServiceContext> {
    lastSavedSetting?: ObsidianLiveSyncSettings;
    readonly localItems = new Map<string, string>();
    protected setItem(key: string, value: string): void {
        this.localItems.set(key, value);
    }
    protected getItem(key: string): string {
        return this.localItems.get(key) ?? "";
    }
    protected deleteItem(key: string): void {
        this.localItems.delete(key);
    }
    protected saveData(setting: ObsidianLiveSyncSettings): Promise<void> {
        this.lastSavedSetting = JSON.parse(JSON.stringify(setting));
        return Promise.resolve();
    }
    protected loadData(): Promise<ObsidianLiveSyncSettings | undefined> {
        return Promise.resolve(undefined);
    }
}

function createService(onDisplayLanguageChanged?: (language: ObsidianLiveSyncSettings["displayLanguage"]) => void) {
    const service = new TestSettingService(new ServiceContext(), {
        APIService: {
            getSystemVaultName: vi.fn(() => "vault"),
            getAppID: vi.fn(() => "app"),
            confirm: {
                askString: vi.fn(() => Promise.resolve("")),
            },
            addLog: vi.fn(),
        } as any,
        onDisplayLanguageChanged,
    } as any);
    service.settings = {
        ...DEFAULT_SETTINGS,
        remoteConfigurations: {},
        activeConfigurationId: "",
    };
    return service;
}

const MANAGED_SOURCE = {
    version: 1,
    id: "cloudflare",
    configuration: { turnKeyId: "key-id", apiToken: "secret-token" },
};

function managedP2PProfileURI(settings: ObsidianLiveSyncSettings): string {
    return ConnectionStringParser.serialize({
        type: "p2p",
        settings: {
            ...settings,
            P2P_roomID: settings.P2P_roomID || "managed-room",
            P2P_iceServerSource: MANAGED_SOURCE,
        },
    });
}

function centralProfileURI(settings: ObsidianLiveSyncSettings): string {
    return ConnectionStringParser.serialize({
        type: "couchdb",
        settings: {
            ...settings,
            couchDB_URI: "http://localhost:5984",
            couchDB_USER: "user",
            couchDB_PASSWORD: "password",
            couchDB_DBNAME: "vault",
        },
    });
}

describe("SettingService", () => {
    it("delegates the loaded display language to the host", async () => {
        const onDisplayLanguageChanged = vi.fn();
        const service = createService(onDisplayLanguageChanged);
        vi.spyOn(service as any, "loadData").mockResolvedValue({
            ...DEFAULT_SETTINGS,
            displayLanguage: "ja",
        });

        await service.loadSettings();

        expect(onDisplayLanguageChanged).toHaveBeenCalledOnce();
        expect(onDisplayLanguageChanged).toHaveBeenCalledWith("ja");
    });

    it("exposes exact device-local configuration without placing it in the settings document", () => {
        const service = createService();

        service.setDeviceLocalConfig("legacy-version-marker", "12");

        expect(service.getDeviceLocalConfig("legacy-version-marker")).toBe("12");
        expect(service.localItems.get("legacy-version-marker")).toBe("12");
        expect(service.currentSettings()).not.toHaveProperty("legacy-version-marker");

        service.deleteDeviceLocalConfig("legacy-version-marker");
        expect(service.getDeviceLocalConfig("legacy-version-marker")).toBe("");
    });

    it("adjustSettings should migrate legacy remote settings into remoteConfigurations", async () => {
        const service = createService();
        const settings = {
            ...DEFAULT_SETTINGS,
            remoteConfigurations: {},
            activeConfigurationId: "",
            remoteType: REMOTE_COUCHDB,
            couchDB_URI: "http://localhost:5984",
            couchDB_USER: "user",
            couchDB_PASSWORD: "password",
            couchDB_DBNAME: "vault",
        };

        const adjusted = await service.adjustSettings(settings);

        expect(adjusted.remoteConfigurations["legacy-couchdb"]?.uri).toContain(
            "sls+http://user:password@localhost:5984"
        );
        expect(adjusted.activeConfigurationId).toBe("legacy-couchdb");
    });

    it("applyExternalSettings should merge current settings and migrate imported legacy remote settings", async () => {
        const service = createService();
        const saveSpy = vi.spyOn(service, "saveSettingData").mockResolvedValue();

        await service.applyExternalSettings(
            {
                couchDB_URI: "http://localhost:5984",
                couchDB_USER: "user",
                couchDB_PASSWORD: "password",
                couchDB_DBNAME: "vault",
            },
            true
        );

        expect(service.currentSettings().remoteConfigurations["legacy-couchdb"]?.uri).toContain(
            "sls+http://user:password@localhost:5984"
        );
        expect(service.currentSettings().activeConfigurationId).toBe("legacy-couchdb");
        expect(saveSpy).toHaveBeenCalledTimes(1);
    });

    it("saveSettingData should encrypt remote configuration URIs before persisting", async () => {
        const service = createService();
        const plainURI = "sls+http://user:password@localhost:5984/?db=vault";
        service.settings = {
            ...service.settings,
            remoteConfigurations: {
                r1: {
                    id: "r1",
                    name: "Primary",
                    uri: plainURI,
                    isEncrypted: false,
                },
            },
            activeConfigurationId: "r1",
        };

        await service.saveSettingData();

        const persisted = service.lastSavedSetting;
        expect(persisted).toBeDefined();
        expect(persisted?.remoteConfigurations.r1.isEncrypted).toBe(true);
        expect(persisted?.remoteConfigurations.r1.uri).not.toBe(plainURI);
    });

    it("preserves the legacy plaintext fallback when a non-managed URI cannot be encrypted", async () => {
        const service = createService();
        const plainURI = "sls+http://user:password@localhost:5984/?db=vault";
        service.settings = {
            ...service.settings,
            remoteConfigurations: {
                r1: {
                    id: "r1",
                    name: "Primary",
                    uri: plainURI,
                    isEncrypted: false,
                },
            },
        };
        vi.spyOn(service, "encryptConfigurationItem").mockResolvedValue("");

        await service.saveSettingData();

        expect(service.lastSavedSetting?.remoteConfigurations.r1.uri).toBe(plainURI);
        expect(service.lastSavedSetting?.remoteConfigurations.r1.isEncrypted).toBe(false);
    });

    it("fails closed when a managed profile URI cannot be encrypted", async () => {
        const service = createService();
        const managedURI = ConnectionStringParser.serialize({
            type: "p2p",
            settings: {
                ...service.settings,
                P2P_roomID: "managed-room",
                P2P_iceServerSource: {
                    version: 1,
                    id: "cloudflare",
                    configuration: { turnKeyId: "key-id", apiToken: "secret-token" },
                },
            },
        });
        service.settings = {
            ...service.settings,
            remoteConfigurations: {
                p2p: {
                    id: "p2p",
                    name: "Managed P2P",
                    uri: managedURI,
                    isEncrypted: false,
                },
            },
        };
        vi.spyOn(service, "encryptConfigurationItem").mockResolvedValue("");

        await expect(service.saveSettingData()).rejects.toThrow(/managed P2P remote configuration/i);
        expect(service.lastSavedSetting).toBeUndefined();
    });

    it("persists the source only in its P2P profile and restores it on load", async () => {
        const service = createService();
        service.settings = {
            ...service.settings,
            remoteType: REMOTE_COUCHDB,
            activeConfigurationId: "central",
            P2P_ActiveRemoteConfigurationId: "p2p",
            P2P_Enabled: true,
            P2P_AutoStart: true,
            P2P_roomID: "managed-room",
            P2P_passphrase: "managed-passphrase",
            P2P_iceServerSource: MANAGED_SOURCE,
            remoteConfigurations: {
                central: { id: "central", name: "Central", uri: centralProfileURI(service.settings), isEncrypted: false },
                p2p: { id: "p2p", name: "P2P", uri: managedP2PProfileURI(service.settings), isEncrypted: false },
            },
        };
        let notified: ObsidianLiveSyncSettings | undefined;
        service.onSettingSaved.addHandler(async (settings) => {
            notified = settings;
            return true;
        });

        await service.saveSettingData();

        const persisted = service.lastSavedSetting!;
        expect(persisted).not.toHaveProperty("P2P_iceServerSource");
        expect(persisted).not.toHaveProperty("encryptedP2PIceServerSource");
        expect(JSON.stringify(persisted)).not.toContain("secret-token");
        expect(persisted.remoteConfigurations.p2p.isEncrypted).toBe(true);
        expect(service.currentSettings().remoteConfigurations.p2p.isEncrypted).toBe(false);
        expect(notified?.P2P_iceServerSource).toEqual(MANAGED_SOURCE);

        const restored = createService();
        vi.spyOn(restored as any, "loadData").mockResolvedValue(persisted);
        await restored.loadSettings();
        expect(restored.currentSettings()).toMatchObject({
            remoteType: REMOTE_COUCHDB,
            activeConfigurationId: "central",
            P2P_ActiveRemoteConfigurationId: "p2p",
            P2P_Enabled: true,
            P2P_AutoStart: true,
            P2P_roomID: "managed-room",
            P2P_passphrase: "managed-passphrase",
            P2P_iceServerSource: MANAGED_SOURCE,
        });
    });

    it("keeps one P2P profile when saving flat source settings beside a central remote", async () => {
        const service = createService();
        service.settings = {
            ...service.settings,
            activeConfigurationId: "central",
            P2P_roomID: "standalone-room",
            P2P_iceServerSource: MANAGED_SOURCE,
            remoteConfigurations: {
                central: { id: "central", name: "Central", uri: centralProfileURI(service.settings), isEncrypted: false },
            },
        };

        await service.saveSettingData();
        const profileID = service.lastSavedSetting!.P2P_ActiveRemoteConfigurationId;
        expect(profileID).toBeTruthy();
        expect(service.currentSettings().P2P_ActiveRemoteConfigurationId).toBe(profileID);
        service.settings.P2P_iceServerSource = { ...MANAGED_SOURCE, configuration: { apiToken: "updated-token" } };
        await service.saveSettingData();
        expect(service.lastSavedSetting!.P2P_ActiveRemoteConfigurationId).toBe(profileID);
        expect(Object.keys(service.lastSavedSetting!.remoteConfigurations)).toHaveLength(2);
        const restored = createService();
        vi.spyOn(restored as any, "loadData").mockResolvedValue(service.lastSavedSetting);
        await restored.loadSettings();
        expect(restored.currentSettings().P2P_iceServerSource?.configuration.apiToken).toBe("updated-token");
        expect(restored.currentSettings().activeConfigurationId).toBe("central");
    });

    it("does not persist a source draft without a Group ID", async () => {
        const service = createService();
        service.settings.P2P_iceServerSource = MANAGED_SOURCE;
        await service.saveSettingData();
        expect(service.lastSavedSetting).not.toHaveProperty("P2P_iceServerSource");
        expect(service.lastSavedSetting).not.toHaveProperty("encryptedP2PIceServerSource");
        expect(service.lastSavedSetting?.remoteConfigurations).toEqual({});
        expect(service.currentSettings().P2P_iceServerSource).toEqual(MANAGED_SOURCE);
    });

    it("preserves an encrypted profile while saving a new P2P configuration", async () => {
        const service = createService();
        const encryptedProfile = { id: "existing", name: "Existing", uri: "opaque-encrypted-profile", isEncrypted: true };
        service.settings = {
            ...service.settings,
            P2P_roomID: "new-room",
            P2P_iceServerSource: MANAGED_SOURCE,
            P2P_ActiveRemoteConfigurationId: "existing",
            remoteConfigurations: { existing: encryptedProfile },
        };
        await service.saveSettingData();
        expect(service.lastSavedSetting?.remoteConfigurations.existing).toEqual(encryptedProfile);
        expect(service.lastSavedSetting?.P2P_ActiveRemoteConfigurationId).not.toBe("existing");
    });

    it("omits credentials from profile encryption failures and leaves saved data intact", async () => {
        const service = createService();
        service.settings = { ...service.settings, P2P_roomID: "room", P2P_iceServerSource: MANAGED_SOURCE };
        vi.spyOn(service, "encryptConfigurationItem").mockRejectedValue(new Error("secret-token"));
        const log = vi.spyOn(service, "_log");
        await expect(service.saveSettingData()).rejects.toThrow("Failed to encrypt managed P2P remote configuration");
        expect(log.mock.calls.flat().map(String).join("\n")).not.toContain("secret-token");
        expect(service.lastSavedSetting).toBeUndefined();
    });

    it("does not save managed profile data when its configuration passphrase is unavailable", async () => {
        const service = createService();
        service.settings = { ...service.settings, P2P_roomID: "room", P2P_iceServerSource: MANAGED_SOURCE };
        vi.spyOn(service, "getPassphrase").mockResolvedValue(false);
        await expect(service.saveSettingData()).rejects.toThrow(/passphrase.*managed P2P/i);
        expect(service.lastSavedSetting).toBeUndefined();
    });

    it("saveSettingData should not mutate in-memory remote configuration URIs", async () => {
        const service = createService();
        const plainURI = "sls+http://user:password@localhost:5984/?db=vault";
        service.settings = {
            ...service.settings,
            remoteConfigurations: {
                r1: {
                    id: "r1",
                    name: "Primary",
                    uri: plainURI,
                    isEncrypted: false,
                },
            },
            activeConfigurationId: "r1",
        };

        await service.saveSettingData();

        expect(service.currentSettings().remoteConfigurations.r1.uri).toBe(plainURI);
        expect(service.currentSettings().remoteConfigurations.r1.isEncrypted).toBe(false);
    });

    it("decryptSettings should restore encrypted remote configuration URIs", async () => {
        const service = createService();
        const plainURI = "sls+s3://ak:sk@example.com/?endpoint=https%3A%2F%2Fexample.com&bucket=vault";
        service.settings = {
            ...service.settings,
            remoteConfigurations: {
                r1: {
                    id: "r1",
                    name: "Primary",
                    uri: plainURI,
                    isEncrypted: false,
                },
            },
            activeConfigurationId: "r1",
        };

        await service.saveSettingData();
        const encrypted = JSON.parse(JSON.stringify(service.lastSavedSetting!)) as ObsidianLiveSyncSettings;

        const decrypted = await service.decryptSettings(encrypted);

        expect(decrypted.remoteConfigurations.r1.isEncrypted).toBe(false);
        expect(decrypted.remoteConfigurations.r1.uri).toBe(plainURI);
    });

    it("decryptSettings should repair a plain-text remote URI that is incorrectly marked as encrypted", async () => {
        const service = createService();
        const plainURI = "sls+http://user:password@localhost:5984/?db=vault";

        const decrypted = await service.decryptSettings({
            ...DEFAULT_SETTINGS,
            remoteConfigurations: {
                r1: {
                    id: "r1",
                    name: "Primary",
                    uri: plainURI,
                    isEncrypted: true,
                },
            },
            activeConfigurationId: "r1",
        });

        expect(decrypted.remoteConfigurations.r1.uri).toBe(plainURI);
        expect(decrypted.remoteConfigurations.r1.isEncrypted).toBe(false);
    });

    it("loadSettings should apply P2P active remote fields without overwriting remoteType", async () => {
        const service = createService();
        const couchURI = ConnectionStringParser.serialize({
            type: "couchdb",
            settings: {
                ...DEFAULT_SETTINGS,
                couchDB_URI: "http://localhost:5984",
                couchDB_USER: "user",
                couchDB_PASSWORD: "password",
                couchDB_DBNAME: "vault",
            },
        });
        const p2pURI = ConnectionStringParser.serialize({
            type: "p2p",
            settings: {
                ...DEFAULT_SETTINGS,
                P2P_roomID: "123-456-789-abc",
                P2P_passphrase: "passphrase",
                P2P_relays: "wss://exp-relay.vrtmrz.net/",
            },
        });

        vi.spyOn(service as any, "loadData").mockResolvedValue({
            ...DEFAULT_SETTINGS,
            remoteType: REMOTE_COUCHDB,
            remoteConfigurations: {
                couch: {
                    id: "couch",
                    name: "CouchDB",
                    uri: couchURI,
                    isEncrypted: false,
                },
                p2p: {
                    id: "p2p",
                    name: "P2P",
                    uri: p2pURI,
                    isEncrypted: false,
                },
            },
            activeConfigurationId: "couch",
            P2P_ActiveRemoteConfigurationId: "p2p",
        } as ObsidianLiveSyncSettings);

        await service.loadSettings();

        expect(service.currentSettings().remoteType).toBe(REMOTE_COUCHDB);
        expect(service.currentSettings().P2P_roomID).toBe("123-456-789-abc");
        expect(service.currentSettings().P2P_ActiveRemoteConfigurationId).toBe("p2p");
    });

    it("loadSettings should persist the detected schema version without changing explicit sync choices", async () => {
        const service = createService();
        const storedSettings: Partial<ObsidianLiveSyncSettings> = {
            ...DEFAULT_SETTINGS,
            liveSync: true,
            syncOnSave: true,
            syncOnStart: true,
            remoteConfigurations: {
                couch: {
                    id: "couch",
                    name: "CouchDB",
                    uri: "sls+http://user:password@localhost:5984/?db=vault",
                    isEncrypted: false,
                },
            },
            activeConfigurationId: "couch",
        };
        delete storedSettings.settingVersion;
        vi.spyOn(service as any, "loadData").mockResolvedValue(storedSettings);

        await service.loadSettings();

        expect(service.lastSavedSetting).toMatchObject({
            settingVersion: CURRENT_SETTING_VERSION,
            liveSync: true,
            syncOnSave: true,
            syncOnStart: true,
        });
    });

    it("keeps a non-empty legacy default-equivalent store unconfigured when isConfigured is absent", async () => {
        const service = createService();
        vi.spyOn(service as any, "loadData").mockResolvedValue({
            liveSync: DEFAULT_SETTINGS.liveSync,
        });

        await service.loadSettings();

        expect(service.currentSettings().isConfigured).toBe(false);
    });

    it("saveSettingData should apply patches from onBeforeSaveSettingData handlers", async () => {
        const service = createService();

        (service.onBeforeSaveSettingData as any).addHandler(async () => ({ tweakModified: 100 }), 10);
        (service.onBeforeSaveSettingData as any).addHandler(async () => ({ tweakModified: 200 }), 20);

        await service.saveSettingData();

        expect(service.lastSavedSetting?.tweakModified).toBe(200);
    });
});
