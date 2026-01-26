import type { IReplicationService } from "../../base/IService";
import { ReplicationService } from "../../base/ReplicationService";
import type { ServiceContext } from "../../base/ServiceBase";
import { handlers } from "../../lib/HandlerUtils";

export class InjectableReplicationService<T extends ServiceContext> extends ReplicationService<T> {
    parseSynchroniseResult = handlers<IReplicationService>().binder("parseSynchroniseResult");
    isReplicationReady = handlers<IReplicationService>().binder("isReplicationReady");
    replicate = handlers<IReplicationService>().binder("replicate");
    replicateByEvent = handlers<IReplicationService>().binder("replicateByEvent");
}
