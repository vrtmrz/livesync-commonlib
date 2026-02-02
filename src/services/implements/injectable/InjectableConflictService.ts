import { ConflictService } from "../../base/ConflictService";
import type { IConflictService } from "../../base/IService";
import type { ServiceContext } from "../../base/ServiceBase";
import { handlers } from "../../lib/HandlerUtils";

export class InjectableConflictService<T extends ServiceContext> extends ConflictService<T> {
    queueCheckForIfOpen = handlers<IConflictService>().binder("queueCheckForIfOpen");
    queueCheckFor = handlers<IConflictService>().binder("queueCheckFor");
    ensureAllProcessed = handlers<IConflictService>().binder("ensureAllProcessed");
    resolveByDeletingRevision = handlers<IConflictService>().binder("resolveByDeletingRevision");
    resolve = handlers<IConflictService>().binder("resolve");
    resolveByNewest = handlers<IConflictService>().binder("resolveByNewest");
}
