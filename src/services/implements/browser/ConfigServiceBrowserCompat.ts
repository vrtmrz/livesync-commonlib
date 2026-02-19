import { ConfigService } from "@lib/services/base/ConfigService";
import type { IAPIService, ISettingService } from "@lib/services/base/IService";
import type { ServiceContext } from "@lib/services/base/ServiceBase";
import { createInstanceLogFunction } from "@lib/services/lib/logUtils";
export interface ConfigServiceBrowserCompatDependencies {
    settingService: ISettingService;
    APIService: IAPIService;
}
export class ConfigServiceBrowserCompat<T extends ServiceContext = ServiceContext> extends ConfigService<T> {
    private _settingService: ISettingService;

    _log: ReturnType<typeof createInstanceLogFunction>;
    constructor(context: T, dependencies: ConfigServiceBrowserCompatDependencies) {
        super(context);
        this._settingService = dependencies.settingService;
        this._log = createInstanceLogFunction("ConfigService", dependencies.APIService);
    }

    getSmallConfig(key: string) {
        return this._settingService.getSmallConfig(key);
    }

    setSmallConfig(key: string, value: string): void {
        return this._settingService.setSmallConfig(key, value);
    }

    deleteSmallConfig(key: string): void {
        return this._settingService.deleteSmallConfig(key);
    }
}
