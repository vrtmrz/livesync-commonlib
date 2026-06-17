import { ConflictService } from "@lib/services/base/ConflictService";
import type { IConflictService } from "@lib/services/base/IService";
import type { ServiceContext } from "@lib/services/base/ServiceBase";
import { handlers } from "@lib/services/lib/HandlerUtils";

export class InjectableConflictService<T extends ServiceContext> extends ConflictService<T> {
    queueCheckForIfOpen = handlers<IConflictService>().binder("queueCheckForIfOpen");
    queueCheckFor = handlers<IConflictService>().binder("queueCheckFor");
    ensureAllProcessed = handlers<IConflictService>().binder("ensureAllProcessed");
    resolveByDeletingRevision = handlers<IConflictService>().binder("resolveByDeletingRevision");
    resolve = handlers<IConflictService>().binder("resolve");
    resolveByNewest = handlers<IConflictService>().binder("resolveByNewest");
    resolveAllConflictedFilesByNewerOnes = handlers<IConflictService>().binder("resolveAllConflictedFilesByNewerOnes");
}
