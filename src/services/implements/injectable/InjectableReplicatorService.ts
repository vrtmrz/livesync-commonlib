import { ReplicatorService } from "@lib/services/base/ReplicatorService";
import type { ServiceContext } from "@lib/services/base/ServiceBase";

// TODO: Remove this layer.
export class InjectableReplicatorService<T extends ServiceContext> extends ReplicatorService<T> {
    // getActiveReplicator = handlers<IReplicatorService>().binder("getActiveReplicator");
}
