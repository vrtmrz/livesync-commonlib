import { ReplicatorService } from "../../base/ReplicatorService";
import type { ServiceContext } from "../../base/ServiceBase";



// TODO: Remove this layer.
export class InjectableReplicatorService<T extends ServiceContext> extends ReplicatorService<T> {
    // getActiveReplicator = handlers<IReplicatorService>().binder("getActiveReplicator");
}
