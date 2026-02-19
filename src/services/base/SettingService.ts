import {
    ChunkAlgorithmNames,
    DEFAULT_SETTINGS,
    LOG_LEVEL_NOTICE,
    LOG_LEVEL_URGENT,
    SALT_OF_PASSPHRASE,
    SETTING_KEY_P2P_DEVICE_NAME,
    type BucketSyncSetting,
    type ConfigPassphraseStore,
    type CouchDBConnection,
    type ObsidianLiveSyncSettings,
} from "@lib/common/types";
import { handlers } from "@lib/services/lib/HandlerUtils";
import type { IAPIService, ISettingService } from "./IService";
import { ServiceBase, type ServiceContext } from "./ServiceBase";
import { createInstanceLogFunction } from "../lib/logUtils";
import { isCloudantURI } from "../../pouchdb/utils_couchdb";
import { decryptString, encryptString } from "../../encryption/stringEncryption";
import { setLang } from "../../common/i18n";

export interface SettingServiceDependencies {
    APIService: IAPIService;
}
export abstract class SettingService<T extends ServiceContext = ServiceContext>
    extends ServiceBase<T>
    implements ISettingService
{
    deviceAndVaultName: string = "";
    protected APIService: IAPIService;

    protected abstract setItem(key: string, value: string): void;
    protected abstract getItem(key: string): string;
    protected abstract deleteItem(key: string): void;

    _settings!: ObsidianLiveSyncSettings;

    get settings() {
        return this._settings;
    }
    set settings(value: ObsidianLiveSyncSettings) {
        this._settings = value;
    }

    // Save setting to the runtime storage.
    protected abstract saveData(setting: ObsidianLiveSyncSettings): Promise<void>;

    // Load setting from the runtime storage.
    protected abstract loadData(): Promise<ObsidianLiveSyncSettings | undefined>;

    _log: ReturnType<typeof createInstanceLogFunction>;
    constructor(context: T, dependencies: SettingServiceDependencies) {
        super(context);
        this.APIService = dependencies.APIService;
        this._log = createInstanceLogFunction("SettingService", this.APIService);
    }

    /**
     * Adjust the given settings, e.g., migrate old settings to new format.
     * @param settings The settings to adjust.
     */
    adjustSettings(settings: ObsidianLiveSyncSettings): Promise<ObsidianLiveSyncSettings> {
        // Adjust settings as needed

        // Delete this feature to avoid problems on mobile.
        settings.disableRequestURI = true;

        // GC is disabled.
        settings.gcDelay = 0;
        // So, use history is always enabled.
        settings.useHistory = true;

        if ("workingEncrypt" in settings) delete settings.workingEncrypt;
        if ("workingPassphrase" in settings) delete settings.workingPassphrase;
        // Splitter configurations have been replaced with chunkSplitterVersion.
        if (settings.chunkSplitterVersion == "") {
            if (settings.enableChunkSplitterV2) {
                if (settings.useSegmenter) {
                    settings.chunkSplitterVersion = "v2-segmenter";
                } else {
                    settings.chunkSplitterVersion = "v2";
                }
            } else {
                settings.chunkSplitterVersion = "";
            }
        } else if (!(settings.chunkSplitterVersion in ChunkAlgorithmNames)) {
            settings.chunkSplitterVersion = "";
        }
        return Promise.resolve(settings);
    }
    /**
     * Get the unique name for identify the device.
     */
    getDeviceAndVaultName(): string {
        return this.deviceAndVaultName;
    }

    /**
     * Set the unique name for identify the device.
     * @param name The unique name to set.
     */
    setDeviceAndVaultName(name: string): void {
        this.deviceAndVaultName = name;
    }

    /**
     * Save the current device and vault name to settings, aside from the main settings.
     */
    saveDeviceAndVaultName(): void {
        const lsKey =
            "obsidian-live-sync-vaultanddevicename-" +
            this.APIService.getSystemVaultName() +
            this.additionalSuffixOfDatabaseName();
        this.setItem(lsKey, this.deviceAndVaultName);
    }

    private additionalSuffixOfDatabaseName() {
        const suffix = this.settings?.additionalSuffixOfDatabaseName;
        if (typeof suffix === "undefined") {
            this._log("too early to get additionalSuffixOfDatabaseName, returning empty string");
            return "";
        }
        return `-${suffix}`;
    }
    private getKey(key: string) {
        const keyMain = this.APIService.getSystemVaultName();
        const addSuffix = this.additionalSuffixOfDatabaseName();
        return `${keyMain}${addSuffix}-${key}`;
    }

    setSmallConfig(key: string, value: string): void {
        const dbKey = this.getKey(key);
        this.setItem(dbKey, value);
    }
    getSmallConfig(key: string): string {
        const dbKey = this.getKey(key);
        return this.getItem(dbKey);
    }
    deleteSmallConfig(key: string): void {
        const dbKey = this.getKey(key);
        this.deleteItem(dbKey);
    }

    /**
     * Save the current settings to storage.
     */
    async saveSettingData() {
        this.saveDeviceAndVaultName();
        const settings = { ...this.settings };
        settings.deviceAndVaultName = "";
        if (settings.P2P_DevicePeerName && settings.P2P_DevicePeerName.trim() !== "") {
            this._log("Saving device peer name to small config");
            this.setSmallConfig(SETTING_KEY_P2P_DEVICE_NAME, settings.P2P_DevicePeerName.trim());
            settings.P2P_DevicePeerName = "";
        }
        if (this.usedPassphrase == "" && !(await this.getPassphrase(settings))) {
            this._log("Failed to retrieve passphrase. data.json contains unencrypted items!", LOG_LEVEL_NOTICE);
        } else {
            if (
                settings.couchDB_PASSWORD != "" ||
                settings.couchDB_URI != "" ||
                settings.couchDB_USER != "" ||
                settings.couchDB_DBNAME
            ) {
                const connectionSetting: CouchDBConnection & BucketSyncSetting = {
                    couchDB_DBNAME: settings.couchDB_DBNAME,
                    couchDB_PASSWORD: settings.couchDB_PASSWORD,
                    couchDB_URI: settings.couchDB_URI,
                    couchDB_USER: settings.couchDB_USER,
                    accessKey: settings.accessKey,
                    bucket: settings.bucket,
                    endpoint: settings.endpoint,
                    region: settings.region,
                    secretKey: settings.secretKey,
                    useCustomRequestHandler: settings.useCustomRequestHandler,
                    bucketCustomHeaders: settings.bucketCustomHeaders,
                    couchDB_CustomHeaders: settings.couchDB_CustomHeaders,
                    useJWT: settings.useJWT,
                    jwtKey: settings.jwtKey,
                    jwtAlgorithm: settings.jwtAlgorithm,
                    jwtKid: settings.jwtKid,
                    jwtExpDuration: settings.jwtExpDuration,
                    jwtSub: settings.jwtSub,
                    useRequestAPI: settings.useRequestAPI,
                    bucketPrefix: settings.bucketPrefix,
                    forcePathStyle: settings.forcePathStyle,
                };
                settings.encryptedCouchDBConnection = await this.encryptConfigurationItem(
                    JSON.stringify(connectionSetting),
                    settings
                );
                settings.couchDB_PASSWORD = "";
                settings.couchDB_DBNAME = "";
                settings.couchDB_URI = "";
                settings.couchDB_USER = "";
                settings.accessKey = "";
                settings.bucket = "";
                settings.region = "";
                settings.secretKey = "";
                settings.endpoint = "";
            }
            if (settings.encrypt && settings.passphrase != "") {
                settings.encryptedPassphrase = await this.encryptConfigurationItem(settings.passphrase, settings);
                settings.passphrase = "";
            }
        }
        await this.saveData(settings);
        void this.onSettingSaved(settings);
    }

    /**
     * Event triggered before realising the settings.
     * Handlers can return false to abort the realisation process.
     */
    readonly onBeforeRealiseSetting = handlers<ISettingService>().bailFirstFailure("onBeforeRealiseSetting");

    /**
     * Event triggered after the settings have been realised.
     */
    readonly onSettingRealised = handlers<ISettingService>().bailFirstFailure("onSettingRealised");

    /**
     * Event triggered to realise the settings.
     */
    readonly onRealiseSetting = handlers<ISettingService>().bailFirstFailure("onRealiseSetting");

    /**
     * Suspend all synchronisation activities and save to the settings.
     */
    readonly suspendAllSync = handlers<ISettingService>().all("suspendAllSync");

    /**
     * Suspend extra synchronisation activities, e.g., hidden files sync.
     */
    readonly suspendExtraSync = handlers<ISettingService>().all("suspendExtraSync");

    /**
     * Suggest enabling optional features to the user.
     */
    readonly suggestOptionalFeatures = handlers<ISettingService>().all("suggestOptionalFeatures");

    /**
     * Enable an optional feature and save to the settings.
     * It may also raised from `handleSuggestOptionalFeatures` if the user agrees.
     * @param mode The optional feature to enable.
     */
    readonly enableOptionalFeature = handlers<ISettingService>().all("enableOptionalFeature");
    readonly onSettingLoaded = handlers<ISettingService>().dispatchParallel("onSettingLoaded");
    readonly onSettingChanged = handlers<ISettingService>().dispatchParallel("onSettingChanged");
    readonly onSettingSaved = handlers<ISettingService>().dispatchParallel("onSettingSaved");

    /**
     * Get the current settings.
     */
    currentSettings(): ObsidianLiveSyncSettings {
        return this.settings;
    }

    // abstract importSettings(imported: Partial<ObsidianLiveSyncSettings>): Promise<boolean>;
    updateSettings(updateFn: (settings: ObsidianLiveSyncSettings) => ObsidianLiveSyncSettings): Promise<void> {
        try {
            const updated = updateFn(this.settings);
            this.settings = updated;
        } catch (ex) {
            this._log("Error in update function: " + ex, LOG_LEVEL_URGENT);
            return Promise.reject(ex);
        }
        return Promise.resolve();
    }
    applyPartial(partial: Partial<ObsidianLiveSyncSettings>): Promise<void> {
        try {
            this.settings = { ...this.settings, ...partial };
        } catch (ex) {
            this._log("Error in applying partial settings: " + ex, LOG_LEVEL_URGENT);
            return Promise.reject(ex);
        }
        return Promise.resolve();
    }
    getPassphrase(settings: ObsidianLiveSyncSettings) {
        const methods: Record<ConfigPassphraseStore, () => Promise<string | false>> = {
            "": () => Promise.resolve("*"),
            LOCALSTORAGE: () => Promise.resolve(this.getItem("ls-setting-passphrase") ?? false),
            ASK_AT_LAUNCH: () => this.APIService.confirm.askString("Passphrase", "passphrase", ""),
        };
        const method = settings.configPassphraseStore;
        const methodFunc = method in methods ? methods[method] : methods[""];
        return methodFunc();
    }

    private usedPassphrase = "";
    /**
     * Clear any used passphrase from memory.
     */
    clearUsedPassphrase(): void {
        this.usedPassphrase = "";
    }

    async decryptConfigurationItem(encrypted: string, passphrase: string) {
        const dec = await decryptString(encrypted, passphrase + SALT_OF_PASSPHRASE);
        if (dec) {
            this.usedPassphrase = passphrase;
            return dec;
        }
        return false;
    }
    async encryptConfigurationItem(src: string, settings: ObsidianLiveSyncSettings) {
        if (this.usedPassphrase != "") {
            return await encryptString(src, this.usedPassphrase + SALT_OF_PASSPHRASE);
        }

        const passphrase = await this.getPassphrase(settings);
        if (passphrase === false) {
            this._log(
                "Failed to obtain passphrase when saving data.json! Please verify the configuration.",
                LOG_LEVEL_URGENT
            );
            return "";
        }
        const dec = await encryptString(src, passphrase + SALT_OF_PASSPHRASE);
        if (dec) {
            this.usedPassphrase = passphrase;
            return dec;
        }

        return "";
    }

    /**
     * Decrypt the given settings.
     * @param settings The settings to decrypt.
     */
    async decryptSettings(settings: ObsidianLiveSyncSettings): Promise<ObsidianLiveSyncSettings> {
        const passphrase = await this.getPassphrase(settings);
        if (passphrase === false) {
            this._log("No passphrase found for data.json! Verify configuration before syncing.", LOG_LEVEL_URGENT);
        } else {
            if (settings.encryptedCouchDBConnection) {
                const keys = [
                    "couchDB_URI",
                    "couchDB_USER",
                    "couchDB_PASSWORD",
                    "couchDB_DBNAME",
                    "accessKey",
                    "bucket",
                    "endpoint",
                    "region",
                    "secretKey",
                ] as (keyof CouchDBConnection | keyof BucketSyncSetting)[];
                const decrypted = this.tryDecodeJson(
                    await this.decryptConfigurationItem(settings.encryptedCouchDBConnection, passphrase)
                ) as CouchDBConnection & BucketSyncSetting;
                if (decrypted) {
                    for (const key of keys) {
                        if (key in decrypted) {
                            //@ts-ignore
                            settings[key] = decrypted[key];
                        }
                    }
                } else {
                    this._log(
                        "Failed to decrypt passphrase from data.json! Ensure configuration is correct before syncing with remote.",
                        LOG_LEVEL_URGENT
                    );
                    for (const key of keys) {
                        //@ts-ignore
                        settings[key] = "";
                    }
                }
            }
            if (settings.encrypt && settings.encryptedPassphrase) {
                const encrypted = settings.encryptedPassphrase;
                const decrypted = await this.decryptConfigurationItem(encrypted, passphrase);
                if (decrypted) {
                    settings.passphrase = decrypted;
                } else {
                    this._log(
                        "Failed to decrypt passphrase from data.json! Ensure configuration is correct before syncing with remote.",
                        LOG_LEVEL_URGENT
                    );
                    settings.passphrase = "";
                }
            }
        }
        return settings;
    }

    async loadSettings(): Promise<void> {
        const settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData()) as ObsidianLiveSyncSettings;

        if (typeof settings.isConfigured == "undefined") {
            // If migrated, mark true
            if (JSON.stringify(settings) !== JSON.stringify(DEFAULT_SETTINGS)) {
                settings.isConfigured = true;
            } else {
                //
                const appId = this.APIService.getAppID();
                settings.additionalSuffixOfDatabaseName = appId;
                settings.isConfigured = false;
            }
        }

        this.settings = await this.decryptSettings(settings);

        // I wonder can we call here.
        setLang(this.settings.displayLanguage);

        await this.adjustSettings(this.settings);

        const lsKey =
            "obsidian-live-sync-vaultanddevicename-" +
            this.APIService.getSystemVaultName() +
            this.additionalSuffixOfDatabaseName();
        if (this.settings.deviceAndVaultName != "") {
            if (!this.getItem(lsKey)) {
                this.setDeviceAndVaultName(this.settings.deviceAndVaultName);
                this.saveDeviceAndVaultName();
                this.settings.deviceAndVaultName = "";
            }
        }
        if (isCloudantURI(this.settings.couchDB_URI) && this.settings.customChunkSize != 0) {
            this._log(
                "Configuration issues detected and automatically resolved. However, unsynchronized data may exist. Consider rebuilding if necessary.",
                LOG_LEVEL_NOTICE
            );
            this.settings.customChunkSize = 0;
        }
        this.setDeviceAndVaultName(this.getItem(lsKey) || "");
        if (this.getDeviceAndVaultName() == "") {
            if (this.settings.usePluginSync) {
                this._log("Device name missing. Disabling plug-in sync.", LOG_LEVEL_NOTICE);
                this.settings.usePluginSync = false;
            }
        }

        // this.core.ignoreFiles = this.settings.ignoreFiles.split(",").map(e => e.trim());
        // eventHub.emitEvent(EVENT_REQUEST_RELOAD_SETTING_TAB);
        const dispatch = this.settings;
        void this.onSettingLoaded(dispatch);
        void this.onSettingChanged(dispatch);
    }
    private tryDecodeJson(encoded: string | false): object | false {
        try {
            if (!encoded) return false;
            return JSON.parse(encoded);
        } catch {
            return false;
        }
    }
}
