import type { ISettingService } from "../../base/IService";
import type { ServiceContext } from "../../base/ServiceBase";
import { SettingService } from "../../base/SettingService";
import { handlers } from "../../lib/HandlerUtils";

export class InjectableSettingService<T extends ServiceContext> extends SettingService<T> {
    clearUsedPassphrase = handlers<ISettingService>().binder("clearUsedPassphrase");
    realiseSetting = handlers<ISettingService>().binder("realiseSetting");
    decryptSettings = handlers<ISettingService>().binder("decryptSettings");
    adjustSettings = handlers<ISettingService>().binder("adjustSettings");
    saveDeviceAndVaultName = handlers<ISettingService>().binder("saveDeviceAndVaultName");
    saveSettingData = handlers<ISettingService>().binder("saveSettingData");
    loadSettings = handlers<ISettingService>().binder("loadSettings");
    currentSettings = handlers<ISettingService>().binder("currentSettings");
    importSettings = handlers<ISettingService>().binder("importSettings");
}
