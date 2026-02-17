import { ConfigService } from "@lib/services/base/ConfigService";
import type { IAPIService, ISettingService, IVaultService } from "@lib/services/base/IService";
import type { ServiceContext } from "@lib/services/base/ServiceBase";
import { createInstanceLogFunction } from "@lib/services/lib/logUtils";
import { LOG_LEVEL_VERBOSE } from "octagonal-wheels/common/logger";
export interface ConfigServiceBrowserCompatDependencies {
    vaultService: IVaultService;
    settingService: ISettingService;
    APIService: IAPIService;
}
export class ConfigServiceBrowserCompat<T extends ServiceContext = ServiceContext> extends ConfigService<T> {
    private _vaultService: IVaultService;
    private _settingService: ISettingService;

    _log: ReturnType<typeof createInstanceLogFunction>;
    constructor(context: T, dependencies: ConfigServiceBrowserCompatDependencies) {
        super(context);
        this._vaultService = dependencies.vaultService;
        this._settingService = dependencies.settingService;
        this._log = createInstanceLogFunction("ConfigService", dependencies.APIService);
    }
    get vaultName() {
        try {
            if (this._settingService.currentSettings() === undefined) {
                this._log(
                    "Settings are not ready yet. This may be caused by accessing the service too early.",
                    LOG_LEVEL_VERBOSE
                );
                return "";
            }
            return this._vaultService.getVaultName();
        } catch (ex) {
            this._log(
                "Error getting vault name, using empty string. This may be caused by accessing the service too early.",
                LOG_LEVEL_VERBOSE
            );
            this._log(ex, LOG_LEVEL_VERBOSE);
            return "";
        }
    }
    getSmallConfig(key: string) {
        const vaultName = this.vaultName;
        if (!vaultName) {
            this._log(
                " (getSmallConfig) Cannot get vault name, it may be caused too early access to the service. Using default vault name."
            );
        }
        const dbKey = `${vaultName}-${key}`;
        return localStorage.getItem(dbKey);
    }

    setSmallConfig(key: string, value: string): void {
        const vaultName = this.vaultName;
        if (!vaultName) {
            this._log(
                " (setSmallConfig) Cannot get vault name, it may be caused too early access to the service. Using default vault name."
            );
        }
        const dbKey = `${vaultName}-${key}`;
        localStorage.setItem(dbKey, value);
    }

    deleteSmallConfig(key: string): void {
        const vaultName = this.vaultName;
        if (!vaultName) {
            this._log(
                " (deleteSmallConfig) Cannot get vault name, it may be caused too early access to the service. Using default vault name."
            );
        }
        const dbKey = `${vaultName}-${key}`;
        localStorage.removeItem(dbKey);
    }
}
