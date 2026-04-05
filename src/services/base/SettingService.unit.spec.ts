import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, REMOTE_COUCHDB } from "@lib/common/types";
import { SettingService } from "./SettingService";
import { ServiceContext } from "./ServiceBase";
import type { ObsidianLiveSyncSettings } from "@lib/common/types";

class TestSettingService extends SettingService<ServiceContext> {
    lastSavedSetting?: ObsidianLiveSyncSettings;
    protected setItem(_key: string, _value: string): void {}
    protected getItem(_key: string): string {
        return "";
    }
    protected deleteItem(_key: string): void {}
    protected saveData(setting: ObsidianLiveSyncSettings): Promise<void> {
        this.lastSavedSetting = JSON.parse(JSON.stringify(setting));
        return Promise.resolve();
    }
    protected loadData(): Promise<ObsidianLiveSyncSettings | undefined> {
        return Promise.resolve(undefined);
    }
}

function createService() {
    const service = new TestSettingService(new ServiceContext(), {
        APIService: {
            getSystemVaultName: vi.fn(() => "vault"),
            getAppID: vi.fn(() => "app"),
            confirm: {
                askString: vi.fn(() => Promise.resolve("")),
            },
            addLog: vi.fn(),
        } as any,
    });
    service.settings = {
        ...DEFAULT_SETTINGS,
        remoteConfigurations: {},
        activeConfigurationId: "",
    };
    return service;
}

describe("SettingService", () => {
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
});
