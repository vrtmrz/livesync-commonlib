import type { IVaultService } from "../../base/IService";
import type { ServiceContext } from "../../base/ServiceBase";
import { VaultService } from "../../base/VaultService";
import { handlers } from "../../lib/HandlerUtils";

export abstract class InjectableVaultService<T extends ServiceContext> extends VaultService<T> {
    scanVault = handlers<IVaultService>().binder("scanVault");
    isIgnoredByIgnoreFile = handlers<IVaultService>().binder("isIgnoredByIgnoreFile");
    isTargetFile = handlers<IVaultService>().bailFirstFailure("isTargetFile");
    markFileListPossiblyChanged = handlers<IVaultService>().binder("markFileListPossiblyChanged");
}

export class InjectableVaultServiceCompat<T extends ServiceContext> extends InjectableVaultService<T> {
    vaultName = handlers<IVaultService>().binder("vaultName");
    isStorageInsensitive = handlers<IVaultService>().binder("isStorageInsensitive");
    getActiveFilePath = handlers<IVaultService>().binder("getActiveFilePath");
    // shouldCheckCaseInsensitively = handlers<IVaultService>().binder("shouldCheckCaseInsensitively");
}
