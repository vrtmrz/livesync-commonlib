import type { ObsidianLiveSyncSettings } from "@lib/common/types";
import { handlers } from "@lib/services/lib/HandlerUtils";
import type { ISettingService } from "./IService";
import { ServiceBase, type ServiceContext } from "./ServiceBase";

export abstract class SettingService<T extends ServiceContext = ServiceContext>
    extends ServiceBase<T>
    implements ISettingService
{
    /**
     * Clear any used passphrase from memory.
     */
    abstract clearUsedPassphrase(): void;

    /**
     * Apply the current settings to the system.
     * This may involve re-initialising connections, updating configurations, etc.
     */
    abstract realiseSetting(): Promise<void>;

    /**
     * Decrypt the given settings.
     * @param settings The settings to decrypt.
     */
    abstract decryptSettings(settings: ObsidianLiveSyncSettings): Promise<ObsidianLiveSyncSettings>;

    /**
     * Adjust the given settings, e.g., migrate old settings to new format.
     * @param settings The settings to adjust.
     */
    abstract adjustSettings(settings: ObsidianLiveSyncSettings): Promise<ObsidianLiveSyncSettings>;

    /**
     * Load settings from storage and apply them.
     */
    abstract loadSettings(): Promise<void>;

    /**
     * Get the unique name for identify the device.
     */
    abstract getDeviceAndVaultName(): string;

    /**
     * Set the unique name for identify the device.
     * @param name The unique name to set.
     */
    abstract setDeviceAndVaultName(name: string): void;

    /**
     * Save the current device and vault name to settings, aside from the main settings.
     */
    abstract saveDeviceAndVaultName(): void;

    /**
     * Save the current settings to storage.
     */
    abstract saveSettingData(): Promise<void>;

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

    /**
     * Get the current settings.
     */
    abstract currentSettings(): ObsidianLiveSyncSettings;

    /**
     * Check if the file system should be treated case-insensitively.
     * This is important for certain operating systems like Windows and macOS.
     */
    abstract shouldCheckCaseInsensitively(): boolean;

    abstract importSettings(imported: Partial<ObsidianLiveSyncSettings>): Promise<boolean>;
}
