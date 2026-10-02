import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, REMOTE_MINIO, type ObsidianLiveSyncSettings } from "@lib/common/types";
import { SettingService } from "./SettingService";
import { ServiceContext } from "./ServiceBase";

class CapturingSettingService extends SettingService<ServiceContext> {
    saved?: ObsidianLiveSyncSettings;
    readonly localItems = new Map<string, string>();
    protected setItem(key: string, value: string) {
        this.localItems.set(key, value);
    }
    protected getItem(key: string) {
        return this.localItems.get(key) ?? "";
    }
    protected deleteItem(key: string) {
        this.localItems.delete(key);
    }
    protected async saveData(settings: ObsidianLiveSyncSettings) {
        this.saved = structuredClone(settings);
    }
    protected async loadData() {
        return undefined;
    }
}

function createService(couchDB_URI = "") {
    const service = new CapturingSettingService(new ServiceContext(), {
        APIService: {
            getSystemVaultName: () => "synthetic-vault",
            getAppID: () => "synthetic-app",
            confirm: { askString: vi.fn(async () => "") },
            addLog: vi.fn(),
        } as any,
    });
    service.settings = {
        ...structuredClone(DEFAULT_SETTINGS),
        remoteConfigurations: {},
        remoteType: REMOTE_MINIO,
        couchDB_URI,
        couchDB_DBNAME: "",
        couchDB_USER: "",
        couchDB_PASSWORD: "",
        configPassphraseStore: "LOCALSTORAGE",
        endpoint: "https://synthetic.invalid",
        bucket: "synthetic-bucket",
        region: "auto",
        accessKey: "synthetic-object-access-key",
        secretKey: "synthetic-object-secret-key",
    };
    service.setDeviceLocalConfig("ls-setting-passphrase", "synthetic-configuration-passphrase");
    return service;
}

describe("SettingService settings persistence", () => {
    it("stores Object Storage settings independently of CouchDB settings", async () => {
        const service = createService();
        await service.saveSettingData();
        expect({ accessKey: service.saved?.accessKey, secretKey: service.saved?.secretKey }).toEqual({
            accessKey: "",
            secretKey: "",
        });
        expect(service.saved?.encryptedCouchDBConnection).toBeTruthy();
        const restored = await service.decryptSettings(structuredClone(service.saved!));
        expect(restored.accessKey).toBe(service.settings.accessKey);
        expect(restored.secretKey).toBe(service.settings.secretKey);
    });

    it("stores JWT values and headers in the connection payload", async () => {
        const service = createService("https://synthetic.invalid");
        Object.assign(service.settings, {
            jwtKey: "synthetic-jwt-key",
            couchDB_CustomHeaders: "Authorization: synthetic-couch-token",
            bucketCustomHeaders: "Authorization: synthetic-bucket-token",
        });
        await service.saveSettingData();
        expect(service.saved?.encryptedCouchDBConnection).toBeTruthy();
        expect(service.saved?.accessKey).toBe("");
        const secrets = [
            service.settings.jwtKey,
            service.settings.couchDB_CustomHeaders,
            service.settings.bucketCustomHeaders,
        ];
        expect(secrets.filter((value) => JSON.stringify(service.saved).includes(value))).toEqual([]);
        const restored = await createService().decryptSettings(structuredClone(service.saved!));
        expect(restored.jwtKey).toBe(service.settings.jwtKey);
        expect(restored.couchDB_CustomHeaders).toBe(service.settings.couchDB_CustomHeaders);
        expect(restored.bucketCustomHeaders).toBe(service.settings.bucketCustomHeaders);
    });

    it("restores connection settings when a CouchDB field is populated", async () => {
        const service = createService("https://synthetic.invalid");
        await service.saveSettingData();
        expect({ accessKey: service.saved?.accessKey, secretKey: service.saved?.secretKey }).toEqual({
            accessKey: "",
            secretKey: "",
        });
        expect(service.saved?.encryptedCouchDBConnection).toBeTruthy();
        const restored = await service.decryptSettings(structuredClone(service.saved!));
        expect(restored.accessKey).toBe(service.settings.accessKey);
        expect(restored.secretKey).toBe(service.settings.secretKey);
    });

    it("requires the selected configuration passphrase before saving", async () => {
        const service = createService();
        vi.spyOn(service, "getPassphrase").mockResolvedValue(false);
        await expect(service.saveSettingData()).rejects.toThrow();
        expect(service.saved).toBeUndefined();
    });

    it("requires a complete connection payload before saving", async () => {
        const service = createService("https://synthetic.invalid");
        vi.spyOn(service, "encryptConfigurationItem").mockResolvedValue("");
        await expect(service.saveSettingData()).rejects.toThrow();
        expect(service.saved).toBeUndefined();
    });

    it("defers saving when connection preparation throws", async () => {
        const service = createService("https://synthetic.invalid");
        vi.spyOn(service, "encryptConfigurationItem").mockRejectedValue(new Error("synthetic encryption failure"));
        await expect(service.saveSettingData()).rejects.toThrow("synthetic encryption failure");
        expect(service.saved).toBeUndefined();
    });
    it("restores Object Storage settings on a fresh service while retaining runtime values", async () => {
        const service = createService();
        const original = structuredClone(service.settings);
        await service.saveSettingData();
        const restored = await createService().decryptSettings(structuredClone(service.saved!));
        expect(service.settings.accessKey).toBe(original.accessKey);
        expect(service.settings.secretKey).toBe(original.secretKey);
        expect(restored.accessKey).toBe(original.accessKey);
        expect(restored.secretKey).toBe(original.secretKey);
        expect(restored.endpoint).toBe(original.endpoint);
        expect(service.saved?.accessKey).toBe("");
    });

    it("clears a previous connection payload after all connection values are removed", async () => {
        const service = createService("https://synthetic.invalid");
        await service.saveSettingData();
        service.settings.encryptedCouchDBConnection = service.saved!.encryptedCouchDBConnection;
        Object.assign(service.settings, {
            couchDB_URI: "",
            accessKey: "",
            secretKey: "",
            bucket: "",
            region: "",
            endpoint: "",
        });
        await service.saveSettingData();
        expect(service.saved?.encryptedCouchDBConnection).toBe("");
        const restored = await createService().decryptSettings(structuredClone(service.saved!));
        expect(restored.accessKey).toBe("");
        expect(restored.secretKey).toBe("");
    });

    it("retains an existing connection payload when its passphrase differs", async () => {
        const writer = createService();
        await writer.saveSettingData();
        const encryptedCouchDBConnection = writer.saved!.encryptedCouchDBConnection;
        const reader = createService();
        reader.setDeviceLocalConfig("ls-setting-passphrase", "synthetic-incorrect-passphrase");
        reader.settings = await reader.decryptSettings(structuredClone(writer.saved!));
        expect(reader.settings.accessKey).toBe("");
        expect(reader.settings.secretKey).toBe("");
        await reader.saveSettingData();
        expect(reader.saved?.encryptedCouchDBConnection).toBe(encryptedCouchDBConnection);

        reader.setDeviceLocalConfig("ls-setting-passphrase", "synthetic-configuration-passphrase");
        reader.clearUsedPassphrase();
        const restored = await reader.decryptSettings(structuredClone(reader.saved!));
        expect(restored.accessKey).toBe(writer.settings.accessKey);
        expect(restored.secretKey).toBe(writer.settings.secretKey);
    });

    it("loads legacy Object Storage settings", async () => {
        const service = createService();
        const original = structuredClone(service.settings);
        const restored = await service.decryptSettings(original);
        expect(restored.accessKey).toBe(service.settings.accessKey);
        expect(restored.secretKey).toBe(service.settings.secretKey);
    });

    it("retains headers absent from an older connection payload", async () => {
        const service = createService();
        const encryptedCouchDBConnection = await service.encryptConfigurationItem(
            JSON.stringify({
                accessKey: service.settings.accessKey,
                secretKey: service.settings.secretKey,
            }),
            service.settings
        );
        const restored = await service.decryptSettings({
            ...service.settings,
            accessKey: "",
            secretKey: "",
            encryptedCouchDBConnection,
            bucketCustomHeaders: "Authorization: synthetic-legacy-header",
        });
        expect(restored.accessKey).toBe(service.settings.accessKey);
        expect(restored.secretKey).toBe(service.settings.secretKey);
        expect(restored.bucketCustomHeaders).toBe("Authorization: synthetic-legacy-header");
    });

    it("retains previously saved settings when connection preparation fails", async () => {
        const service = createService("https://synthetic.invalid");
        await service.saveSettingData();
        const previouslySaved = structuredClone(service.saved);
        vi.spyOn(service, "encryptConfigurationItem").mockResolvedValue("");
        service.settings.secretKey = "synthetic-replacement-key";
        await expect(service.saveSettingData()).rejects.toThrow();
        expect(service.saved).toEqual(previouslySaved);
        expect(service.settings.secretKey).toBe("synthetic-replacement-key");
    });

    it("defers saving when a profile URI cannot be prepared", async () => {
        const service = createService();
        Object.assign(service.settings, { accessKey: "", secretKey: "", bucket: "", region: "", endpoint: "" });
        service.settings.remoteConfigurations = {
            inactive: {
                id: "inactive",
                name: "Inactive",
                uri: "sls+s3://synthetic-access:synthetic-secret@synthetic.invalid/?bucket=synthetic",
                isEncrypted: false,
            },
        };
        vi.spyOn(service, "encryptConfigurationItem").mockResolvedValue("");
        await expect(service.saveSettingData()).rejects.toThrow();
        expect(service.saved).toBeUndefined();
    });
});
