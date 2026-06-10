import { isValidFilenameInWidows } from "@lib/string_and_binary/path";
import type { IVaultService } from "@lib/services/base/IService";
import type { ServiceContext } from "@lib/services/base/ServiceBase";
import { VaultService } from "@lib/services/base/VaultService";
import { handlers } from "@lib/services/lib/HandlerUtils";

export abstract class InjectableVaultService<T extends ServiceContext> extends VaultService<T> {
    // scanVault = handlers<IVaultService>().binder("scanVault");
    // isIgnoredByIgnoreFile = handlers<IVaultService>().binder("isIgnoredByIgnoreFile");
    // isTargetFile = handlers<IVaultService>().bailFirstFailure("isTargetFile");
    // markFileListPossiblyChanged = handlers<IVaultService>().binder("markFileListPossiblyChanged");
}

export class InjectableVaultServiceCompat<T extends ServiceContext> extends InjectableVaultService<T> {
    isStorageInsensitive = handlers<IVaultService>().binder("isStorageInsensitive");
    getActiveFilePath = handlers<IVaultService>().binder("getActiveFilePath");
    override isValidPath(path: string): boolean {
        // Most strict rule.
        return isValidFilenameInWidows(path);
    }
}
