import type { IVaultService } from "../../base/IService";
import type { ServiceContext } from "../../base/ServiceBase";
import { VaultService } from "../../base/VaultService";
import { handlers } from "../../lib/HandlerUtils";

export class InjectableVaultService<T extends ServiceContext> extends VaultService<T> {
    getVaultName = handlers<IVaultService>().binder("getVaultName");
    scanVault = handlers<IVaultService>().binder("scanVault");
    isIgnoredByIgnoreFile = handlers<IVaultService>().binder("isIgnoredByIgnoreFile");
    isTargetFile = handlers<IVaultService>().binder("isTargetFile");
    isFileSizeTooLarge = handlers<IVaultService>().binder("isFileSizeTooLarge");
    getActiveFilePath = handlers<IVaultService>().binder("getActiveFilePath");
    markFileListPossiblyChanged = handlers<IVaultService>().binder("markFileListPossiblyChanged");
    isStorageInsensitive = handlers<IVaultService>().binder("isStorageInsensitive");
    vaultName = handlers<IVaultService>().binder("vaultName");
}
