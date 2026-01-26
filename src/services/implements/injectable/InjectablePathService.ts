import type { IPathService } from "../../base/IService";
import { PathService } from "../../base/PathService";
import type { ServiceContext } from "../../base/ServiceBase";
import { handlers } from "../../lib/HandlerUtils";

export class InjectablePathService<T extends ServiceContext> extends PathService<T> {
    id2path = handlers<IPathService>().binder("id2path");
    path2id = handlers<IPathService>().binder("path2id");
}
