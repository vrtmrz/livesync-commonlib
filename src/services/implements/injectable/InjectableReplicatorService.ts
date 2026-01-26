import type { IReplicatorService } from "../../base/IService";
import { ReplicatorService } from "../../base/ReplicatorService";
import type { ServiceContext } from "../../base/ServiceBase";
import { handlers } from "../../lib/HandlerUtils";

export class InjectableReplicatorService<T extends ServiceContext> extends ReplicatorService<T> {
    getActiveReplicator = handlers<IReplicatorService>().binder("getActiveReplicator");
}
