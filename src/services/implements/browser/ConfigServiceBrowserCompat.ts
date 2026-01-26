import { ConfigService } from "@lib/services/base/ConfigService";
import type { IVaultService } from "@lib/services/base/IService";
import type { ServiceContext } from "@lib/services/base/ServiceBase";

export class ConfigServiceBrowserCompat<T extends ServiceContext = ServiceContext> extends ConfigService<T> {
    private _vaultService: IVaultService;
    constructor(context: T, vaultService: IVaultService) {
        super(context);
        this._vaultService = vaultService;
    }
    getSmallConfig(key: string) {
        const vaultName = this._vaultService.getVaultName();
        const dbKey = `${vaultName}-${key}`;
        return localStorage.getItem(dbKey);
    }

    setSmallConfig(key: string, value: string): void {
        const vaultName = this._vaultService.getVaultName();
        const dbKey = `${vaultName}-${key}`;
        localStorage.setItem(dbKey, value);
    }

    deleteSmallConfig(key: string): void {
        const vaultName = this._vaultService.getVaultName();
        const dbKey = `${vaultName}-${key}`;
        localStorage.removeItem(dbKey);
    }
}
