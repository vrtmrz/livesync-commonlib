import { describe, expect, it, vi } from "vitest";
import {
    CURRENT_SETTING_VERSION,
    DEFAULT_SETTINGS,
    REMOTE_COUCHDB,
    type ConfigPassphraseStore,
    type ObsidianLiveSyncSettings,
} from "@lib/common/types";
import { SettingService } from "./SettingService";
import { ServiceContext } from "./ServiceBase";

const LOCAL_KEY = "ls-setting-passphrase";
const CUSTOM_KEY = "synthetic-custom-configuration-key";
const ID_KEY = "ab".repeat(32);

class ConfigurationSettingService extends SettingService<ServiceContext> {
    saved?: ObsidianLiveSyncSettings;
    readonly writes: ObsidianLiveSyncSettings[] = [];
    readonly localItems = new Map<string, string>();
    failLocalWrites = 0;
    failDataWrites = 0;

    protected setItem(key: string, value: string): void {
        this.localItems.set(key, value);
        if (key === LOCAL_KEY && this.failLocalWrites-- > 0) throw new Error("synthetic local write failure");
    }
    protected getItem(key: string): string {
        return this.localItems.get(key) ?? "";
    }
    protected deleteItem(key: string): void {
        this.localItems.delete(key);
    }
    protected async saveData(settings: ObsidianLiveSyncSettings): Promise<void> {
        if (this.failDataWrites-- > 0) throw new Error("synthetic settings write failure");
        this.saved = structuredClone(settings);
        this.writes.push(structuredClone(settings));
    }
    protected async loadData(): Promise<ObsidianLiveSyncSettings | undefined> {
        return this.saved && structuredClone(this.saved);
    }
}

function createService(version: 0 | 1 = 1) {
    const askString = vi.fn<(...args: any[]) => Promise<string | false>>(async () => false);
    const addLog = vi.fn();
    const service = new ConfigurationSettingService(new ServiceContext(), {
        APIService: {
            getSystemVaultName: () => "synthetic-vault",
            getAppID: () => "synthetic-app",
            confirm: { askString },
            addLog,
        } as any,
    });
    service.settings = {
        ...structuredClone(DEFAULT_SETTINGS),
        settingVersion: CURRENT_SETTING_VERSION,
        handleFilenameCaseSensitive: false,
        isConfigured: true,
        idDerivationVersion: version,
        idDerivationKey: version === 1 ? ID_KEY : "",
        remoteType: REMOTE_COUCHDB,
        couchDB_URI: "https://synthetic.invalid",
        couchDB_DBNAME: "synthetic-database",
        couchDB_USER: "synthetic-user",
        couchDB_PASSWORD: "synthetic-password",
        encrypt: true,
        passphrase: "%synthetic-plaintext-e2ee-key",
        activeConfigurationId: "",
        remoteConfigurations: {
            inactive: {
                id: "inactive",
                name: "Synthetic profile",
                uri: "sls+couchdb://synthetic-profile.invalid/synthetic-database",
                isEncrypted: false,
            },
        },
    };
    return { service, askString, addLog };
}

function expectSecrets(actual: ObsidianLiveSyncSettings, expected: ObsidianLiveSyncSettings): void {
    expect(actual.couchDB_URI).toBe(expected.couchDB_URI);
    expect(actual.couchDB_PASSWORD).toBe(expected.couchDB_PASSWORD);
    expect(actual.passphrase).toBe(expected.passphrase);
    expect(actual.remoteConfigurations.inactive.uri).toBe(expected.remoteConfigurations.inactive.uri);
    expect(actual.remoteConfigurations.inactive.isEncrypted).toBe(false);
    expect(actual.idDerivationKey).toBe(expected.idDerivationKey);
}

describe("SettingService configuration encryption", () => {
    it.each([0, 1] as const)(
        "loads, edits, saves, and reloads Default settings without asking for a key (ID version %s)",
        async (version) => {
            const writer = createService(version).service;
            const expected = structuredClone(writer.settings);
            await writer.saveSettingData();
            const { service, askString } = createService(version);
            service.saved = structuredClone(writer.saved!);
            service.setDeviceLocalConfig(LOCAL_KEY, CUSTOM_KEY);

            await service.loadSettings();
            expectSecrets(service.settings, expected);
            expect(askString).not.toHaveBeenCalled();
            expected.couchDB_PASSWORD += "-updated";
            service.settings.couchDB_PASSWORD = expected.couchDB_PASSWORD;
            await service.saveSettingData();

            const fresh = createService(version);
            fresh.service.saved = structuredClone(service.saved!);
            fresh.service.setDeviceLocalConfig(LOCAL_KEY, CUSTOM_KEY);
            await fresh.service.loadSettings();
            expectSecrets(fresh.service.settings, expected);
            expect(fresh.service.settings.configPassphraseStore).toBe("");
            expect(fresh.askString).not.toHaveBeenCalled();
            expect(service.getDeviceLocalConfig(LOCAL_KEY)).toBe(CUSTOM_KEY);
        }
    );

    it.each([0, 1] as const)(
        "uses the selected custom key after a cached default save (ID version %s)",
        async (version) => {
            const { service } = createService(version);
            const expected = structuredClone(service.settings);
            await service.saveSettingData();
            service.setDeviceLocalConfig(LOCAL_KEY, CUSTOM_KEY);
            service.settings.configPassphraseStore = "LOCALSTORAGE";

            await service.saveSettingData();

            const reader = createService(version).service;
            reader.setDeviceLocalConfig(LOCAL_KEY, CUSTOM_KEY);
            const restored = await reader.decryptSettings(structuredClone(service.saved!));
            expectSecrets(restored, expected);
        }
    );

    it.each([0, 1] as const)(
        "asks for a missing custom key before loading protected settings (ID version %s)",
        async (version) => {
            const writer = createService(version).service;
            writer.settings.configPassphraseStore = "LOCALSTORAGE";
            writer.setDeviceLocalConfig(LOCAL_KEY, CUSTOM_KEY);
            await writer.saveSettingData();
            const { service, askString } = createService(version);
            service.saved = structuredClone(writer.saved!);
            const original = structuredClone(service.saved);
            askString.mockResolvedValue(CUSTOM_KEY);

            await service.loadSettings();

            expect(askString).toHaveBeenCalledOnce();
            expect(askString.mock.calls[0][3]).toBe(true);
            expectSecrets(service.settings, writer.settings);
            expect(service.getDeviceLocalConfig(LOCAL_KEY)).toBe(CUSTOM_KEY);
            expect(service.saved).toEqual(original);
            expect(service.writes).toHaveLength(0);
        }
    );

    it.each([
        [0, "", "LOCALSTORAGE"],
        [1, "", "LOCALSTORAGE"],
        [0, "LOCALSTORAGE", "LOCALSTORAGE"],
        [1, "LOCALSTORAGE", "LOCALSTORAGE"],
        [0, "LOCALSTORAGE", ""],
        [1, "LOCALSTORAGE", ""],
        [0, "LOCALSTORAGE", "ASK_AT_LAUNCH"],
        [1, "LOCALSTORAGE", "ASK_AT_LAUNCH"],
        [0, "ASK_AT_LAUNCH", "LOCALSTORAGE"],
        [1, "ASK_AT_LAUNCH", "LOCALSTORAGE"],
        [0, "ASK_AT_LAUNCH", ""],
        [1, "ASK_AT_LAUNCH", ""],
    ] as const)("rewraps all protected values for ID %s, %s to %s", async (version, from, to) => {
        const { service, askString } = createService(version);
        service.settings.configPassphraseStore = from;
        service.setDeviceLocalConfig(LOCAL_KEY, CUSTOM_KEY);
        askString.mockResolvedValue(CUSTOM_KEY);
        const expected = structuredClone(service.settings);
        await service.saveSettingData();
        const saved = vi.fn(async () => true);
        service.onSettingSaved.addHandler(saved);
        const nextKey = "synthetic-replacement-configuration-key";
        askString.mockResolvedValue(nextKey);

        await service.changeConfigurationEncryption(to, to === "LOCALSTORAGE" ? nextKey : undefined);

        expect(service.writes).toHaveLength(2);
        expect(saved).toHaveBeenCalledOnce();
        expect(service.settings.configPassphraseStore).toBe(to);
        expect(service.getDeviceLocalConfig(LOCAL_KEY)).toBe(to === "LOCALSTORAGE" ? nextKey : CUSTOM_KEY);
        const reader = createService(version);
        reader.service.setDeviceLocalConfig(LOCAL_KEY, nextKey);
        reader.askString.mockResolvedValue(nextKey);
        expectSecrets(await reader.service.decryptSettings(structuredClone(service.saved!)), expected);
        if (to === "ASK_AT_LAUNCH") {
            const count = askString.mock.calls.length;
            await service.saveSettingData();
            expect(askString).toHaveBeenCalledTimes(count);
        }
    });

    it.each(["", false] as const)("does not begin a key change when ASK is declined with %s", async (answer) => {
        const { service, askString } = createService();
        await service.saveSettingData();
        const original = structuredClone(service.saved);
        const runtime = structuredClone(service.settings);
        askString.mockResolvedValue(answer);

        await expect(service.changeConfigurationEncryption("ASK_AT_LAUNCH")).rejects.toThrow("required");

        expect(service.saved).toEqual(original);
        expect(service.settings).toEqual(runtime);
        expect(service.writes).toHaveLength(1);
        expect(service.localItems.has(LOCAL_KEY)).toBe(false);
    });

    it("rejects an empty custom key without discarding the current key", async () => {
        const { service } = createService();
        service.settings.configPassphraseStore = "LOCALSTORAGE";
        service.setDeviceLocalConfig(LOCAL_KEY, CUSTOM_KEY);
        await service.saveSettingData();
        const original = structuredClone(service.saved);

        await expect(service.changeConfigurationEncryption("LOCALSTORAGE", "")).rejects.toThrow("required");

        expect(service.saved).toEqual(original);
        expect(service.getDeviceLocalConfig(LOCAL_KEY)).toBe(CUSTOM_KEY);
        expect(service.writes).toHaveLength(1);
    });

    it.each(["preparation", "local", "settings"] as const)(
        "retains the saved key and live values after a %s failure",
        async (failure) => {
            const { service } = createService();
            service.settings.configPassphraseStore = "LOCALSTORAGE";
            service.setDeviceLocalConfig(LOCAL_KEY, CUSTOM_KEY);
            await service.saveSettingData();
            const original = structuredClone(service.saved);
            const runtime = structuredClone(service.settings);
            const saved = vi.fn(async () => true);
            service.onSettingSaved.addHandler(saved);
            if (failure === "preparation") {
                vi.spyOn(service, "encryptConfigurationItem").mockRejectedValue(
                    new Error("synthetic preparation failure")
                );
            } else if (failure === "local") service.failLocalWrites = 1;
            else service.failDataWrites = 1;

            await expect(service.changeConfigurationEncryption("LOCALSTORAGE", "synthetic-new-key")).rejects.toThrow(
                "failure"
            );

            expect(service.saved).toEqual(original);
            expect(service.settings).toEqual(runtime);
            expect(service.getDeviceLocalConfig(LOCAL_KEY)).toBe(CUSTOM_KEY);
            expect(service.writes).toHaveLength(1);
            expect(saved).not.toHaveBeenCalled();
        }
    );

    it("reports a failed key rollback without notifying success", async () => {
        const { service, addLog } = createService();
        service.settings.configPassphraseStore = "LOCALSTORAGE";
        service.setDeviceLocalConfig(LOCAL_KEY, CUSTOM_KEY);
        await service.saveSettingData();
        const original = structuredClone(service.saved);
        const saved = vi.fn(async () => true);
        service.onSettingSaved.addHandler(saved);
        service.failLocalWrites = 2;

        await expect(service.changeConfigurationEncryption("LOCALSTORAGE", "synthetic-new-key")).rejects.toThrow(
            "could not be restored"
        );

        expect(service.saved).toEqual(original);
        expect(service.settings.configPassphraseStore).toBe("LOCALSTORAGE");
        expect(saved).not.toHaveBeenCalled();
        expect(addLog.mock.calls.flat().map(String).join(" ")).toContain("could not be restored");
    });

    it("permits manual recovery when a settings write completed before reporting an error", async () => {
        const { service } = createService();
        service.settings.configPassphraseStore = "LOCALSTORAGE";
        service.setDeviceLocalConfig(LOCAL_KEY, CUSTOM_KEY);
        await service.saveSettingData();
        vi.spyOn(service as any, "saveData").mockImplementation(async (settings: any) => {
            service.saved = structuredClone(settings);
            throw new Error("synthetic uncertain write failure");
        });

        await expect(service.changeConfigurationEncryption("LOCALSTORAGE", "synthetic-new-key")).rejects.toThrow(
            "uncertain write"
        );
        expect(service.getDeviceLocalConfig(LOCAL_KEY)).toBe(CUSTOM_KEY);
        const reader = createService();
        reader.service.saved = structuredClone(service.saved!);
        reader.service.setDeviceLocalConfig(LOCAL_KEY, CUSTOM_KEY);
        reader.askString.mockResolvedValue("synthetic-new-key");
        await reader.service.loadSettings();
        expectSecrets(reader.service.settings, service.settings);
        expect(reader.askString).toHaveBeenCalledOnce();
    });

    it("refuses to rewrap an unreadable existing payload while ordinary saves retain it", async () => {
        const writer = createService(0).service;
        writer.settings.configPassphraseStore = "LOCALSTORAGE";
        writer.setDeviceLocalConfig(LOCAL_KEY, CUSTOM_KEY);
        await writer.saveSettingData();
        const reader = createService(0).service;
        reader.setDeviceLocalConfig(LOCAL_KEY, "synthetic-wrong-key");
        reader.settings = await reader.decryptSettings(structuredClone(writer.saved!));
        reader.saved = structuredClone(writer.saved!);
        const original = structuredClone(reader.saved);

        await expect(reader.changeConfigurationEncryption("LOCALSTORAGE", "synthetic-new-key")).rejects.toThrow(
            "could not be decrypted"
        );
        expect(reader.saved).toEqual(original);
        expect(reader.getDeviceLocalConfig(LOCAL_KEY)).toBe("synthetic-wrong-key");
        await reader.saveSettingData();
        expect(reader.saved?.encryptedCouchDBConnection).toBe(original!.encryptedCouchDBConnection);
    });

    it.each(["profile", "passphrase"] as const)(
        "retains a damaged %s after another item validates the key",
        async (item) => {
            const writer = createService(0).service;
            writer.settings.configPassphraseStore = "LOCALSTORAGE";
            writer.setDeviceLocalConfig(LOCAL_KEY, CUSTOM_KEY);
            await writer.saveSettingData();
            const { service, askString } = createService(0);
            service.saved = structuredClone(writer.saved!);
            if (item === "profile") service.saved.remoteConfigurations.inactive.uri = "synthetic-damaged-ciphertext";
            else service.saved.encryptedPassphrase = "synthetic-damaged-ciphertext";
            const original = structuredClone(service.saved);
            service.setDeviceLocalConfig(LOCAL_KEY, CUSTOM_KEY);

            await service.loadSettings();

            expect(service.settings.couchDB_PASSWORD).toBe(writer.settings.couchDB_PASSWORD);
            expect(askString).not.toHaveBeenCalled();
            await expect(service.changeConfigurationEncryption("LOCALSTORAGE", "synthetic-new-key")).rejects.toThrow(
                "could not be decrypted"
            );
            expect(service.saved).toEqual(original);
            await service.saveSettingData();
            if (item === "profile")
                expect(service.saved?.remoteConfigurations.inactive).toEqual(original!.remoteConfigurations.inactive);
            else expect(service.saved?.encryptedPassphrase).toBe(original!.encryptedPassphrase);
        }
    );

    it("serialises an in-flight ordinary save before the key change", async () => {
        const { service } = createService();
        await service.saveSettingData();
        let release!: () => void;
        const held = new Promise<void>((resolve) => {
            release = resolve;
        });
        let entered!: () => void;
        const started = new Promise<void>((resolve) => {
            entered = resolve;
        });
        const write = (service as any).saveData.bind(service);
        vi.spyOn(service as any, "saveData").mockImplementationOnce(async (settings: any) => {
            entered();
            await held;
            await write(settings);
        });
        const ordinary = service.saveSettingData();
        await started;
        const change = service.changeConfigurationEncryption("LOCALSTORAGE", CUSTOM_KEY);
        expect(service.getDeviceLocalConfig(LOCAL_KEY)).toBe("");
        release();
        await Promise.all([ordinary, change]);

        expect(service.writes.map((settings) => settings.configPassphraseStore)).toEqual(["", "", "LOCALSTORAGE"]);
        const reader = createService().service;
        reader.setDeviceLocalConfig(LOCAL_KEY, CUSTOM_KEY);
        expectSecrets(await reader.decryptSettings(structuredClone(service.saved!)), service.settings);
    });

    it("serialises two changes and allows a later save after a failed change", async () => {
        const { service } = createService();
        await service.saveSettingData();
        await Promise.all([
            service.changeConfigurationEncryption("LOCALSTORAGE", CUSTOM_KEY),
            service.changeConfigurationEncryption("LOCALSTORAGE", "synthetic-second-key"),
        ]);
        expect(service.writes).toHaveLength(3);
        await expect(service.changeConfigurationEncryption("LOCALSTORAGE", "")).rejects.toThrow();
        await service.saveSettingData();
        const reader = createService().service;
        reader.setDeviceLocalConfig(LOCAL_KEY, "synthetic-second-key");
        expectSecrets(await reader.decryptSettings(structuredClone(service.saved!)), service.settings);
    });

    it("commits hook patches only after a successful write", async () => {
        const { service } = createService();
        await service.saveSettingData();
        const previous = service.settings.tweakModified;
        service.onBeforeSaveSettingData.addHandler(async () => ({ tweakModified: 123 }));
        service.failDataWrites = 1;
        await expect(service.changeConfigurationEncryption("LOCALSTORAGE", CUSTOM_KEY)).rejects.toThrow();
        expect(service.settings.tweakModified).toBe(previous);
        await service.changeConfigurationEncryption("LOCALSTORAGE", CUSTOM_KEY);
        expect(service.settings.tweakModified).toBe(123);
        expect(service.saved?.tweakModified).toBe(123);
    });

    it.each([0, 1] as const)("validates retry inputs before replacing the stored key (ID %s)", async (version) => {
        const writer = createService(version).service;
        writer.settings.configPassphraseStore = "LOCALSTORAGE";
        writer.setDeviceLocalConfig(LOCAL_KEY, CUSTOM_KEY);
        await writer.saveSettingData();
        const { service, askString } = createService(version);
        service.saved = structuredClone(writer.saved!);
        service.setDeviceLocalConfig(LOCAL_KEY, "synthetic-stored-wrong-key");
        const original = structuredClone(service.saved);
        askString.mockResolvedValueOnce("synthetic-entered-wrong-key").mockImplementationOnce(async () => {
            expect(service.getDeviceLocalConfig(LOCAL_KEY)).toBe("synthetic-stored-wrong-key");
            expect(service.saved).toEqual(original);
            return CUSTOM_KEY;
        });

        await service.loadSettings();

        expect(askString).toHaveBeenCalledTimes(2);
        expectSecrets(service.settings, writer.settings);
        expect(service.getDeviceLocalConfig(LOCAL_KEY)).toBe(CUSTOM_KEY);
        expect(service.writes).toHaveLength(0);
    });

    it.each([0, 1] as const)("retains settings and the old key when retry is cancelled (ID %s)", async (version) => {
        const writer = createService(version).service;
        writer.settings.configPassphraseStore = "LOCALSTORAGE";
        writer.setDeviceLocalConfig(LOCAL_KEY, CUSTOM_KEY);
        await writer.saveSettingData();
        const { service, askString } = createService(version);
        service.saved = structuredClone(writer.saved!);
        const original = structuredClone(service.saved);
        const runtime = structuredClone(service.settings);
        service.setDeviceLocalConfig(LOCAL_KEY, "synthetic-stored-wrong-key");
        askString.mockResolvedValueOnce("synthetic-wrong-key").mockResolvedValueOnce(false);
        const loaded = vi.fn(async () => true);
        service.onSettingLoaded.addHandler(loaded);

        await expect(service.loadSettings()).rejects.toThrow("cancelled or unavailable");

        expect(service.saved).toEqual(original);
        expect(service.settings).toEqual(runtime);
        expect(service.getDeviceLocalConfig(LOCAL_KEY)).toBe("synthetic-stored-wrong-key");
        expect(service.writes).toHaveLength(0);
        expect(loaded).not.toHaveBeenCalled();
    });

    it("stops immediately when a headless-style prompt declines a missing key", async () => {
        const writer = createService().service;
        writer.settings.configPassphraseStore = "LOCALSTORAGE";
        writer.setDeviceLocalConfig(LOCAL_KEY, CUSTOM_KEY);
        await writer.saveSettingData();
        const { service, askString } = createService();
        service.saved = structuredClone(writer.saved!);
        await expect(service.loadSettings()).rejects.toThrow("cancelled or unavailable");
        expect(askString).toHaveBeenCalledOnce();
        expect(service.writes).toHaveLength(0);
        expect(service.localItems.has(LOCAL_KEY)).toBe(false);
    });

    it("stops when a validated key cannot be stored and permits a clean retry", async () => {
        const writer = createService().service;
        writer.settings.configPassphraseStore = "LOCALSTORAGE";
        writer.setDeviceLocalConfig(LOCAL_KEY, CUSTOM_KEY);
        await writer.saveSettingData();
        const { service, askString } = createService();
        service.saved = structuredClone(writer.saved!);
        service.failLocalWrites = 1;
        askString.mockResolvedValue(CUSTOM_KEY);
        await expect(service.loadSettings()).rejects.toThrow("local write failure");
        expect(service.localItems.has(LOCAL_KEY)).toBe(false);
        expect(service.writes).toHaveLength(0);
        await service.loadSettings();
        expectSecrets(service.settings, writer.settings);
    });

    it.each(["missing", "unsupported", "invalid"] as const)(
        "keeps the ID rejection contract for an %s ID key",
        async (kind) => {
            const writer = createService().service;
            writer.settings.configPassphraseStore = "LOCALSTORAGE";
            writer.setDeviceLocalConfig(LOCAL_KEY, CUSTOM_KEY);
            await writer.saveSettingData();
            const { service, askString } = createService();
            service.saved = structuredClone(writer.saved!);
            service.setDeviceLocalConfig(LOCAL_KEY, CUSTOM_KEY);
            if (kind === "missing") service.saved.encryptedIdDerivationKey = "";
            if (kind === "unsupported") service.saved.idDerivationVersion = 2 as any;
            if (kind === "invalid") {
                service.saved.encryptedIdDerivationKey = await service.encryptConfigurationItem(
                    "invalid-id-key",
                    writer.settings
                );
            }
            const original = structuredClone(service.saved);
            await expect(service.loadSettings()).rejects.toThrow(/ID derivation/);
            expect(askString).not.toHaveBeenCalled();
            expect(service.saved).toEqual(original);
            expect(service.writes).toHaveLength(0);
        }
    );

    it("keeps one ASK key per launch across ordinary saves until it is cleared", async () => {
        const writer = createService();
        writer.service.settings.configPassphraseStore = "ASK_AT_LAUNCH";
        writer.askString.mockResolvedValue(CUSTOM_KEY);
        await writer.service.saveSettingData();
        const { service, askString } = createService();
        service.saved = structuredClone(writer.service.saved!);
        askString.mockResolvedValue(CUSTOM_KEY);
        await service.loadSettings();
        await service.saveSettingData();
        await service.saveSettingData();
        expect(askString).toHaveBeenCalledOnce();
        service.clearUsedPassphrase();
        await service.saveSettingData();
        expect(askString).toHaveBeenCalledTimes(2);
    });

    it("does not require a key for an unprotected custom configuration", async () => {
        const { service, askString } = createService(0);
        service.saved = {
            ...structuredClone(DEFAULT_SETTINGS),
            settingVersion: CURRENT_SETTING_VERSION,
            handleFilenameCaseSensitive: false,
            isConfigured: true,
            configPassphraseStore: "LOCALSTORAGE",
        };
        await service.loadSettings();
        expect(askString).not.toHaveBeenCalled();
        expect(service.writes).toHaveLength(0);
    });

    it("does not mistake a repaired plaintext profile flag for a need to unlock settings", async () => {
        const { service, askString } = createService(0);
        const uri = "sls+http://user:password@synthetic.invalid/?db=synthetic-database";
        service.saved = {
            ...structuredClone(DEFAULT_SETTINGS),
            settingVersion: CURRENT_SETTING_VERSION,
            handleFilenameCaseSensitive: false,
            isConfigured: true,
            configPassphraseStore: "LOCALSTORAGE",
            remoteConfigurations: { inactive: { id: "inactive", name: "Synthetic profile", uri, isEncrypted: true } },
        };
        await service.loadSettings();
        expect(askString).not.toHaveBeenCalled();
        expect(service.settings.remoteConfigurations.inactive).toMatchObject({ uri, isEncrypted: false });
        expect(service.writes).toHaveLength(0);
    });
});
