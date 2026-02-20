import { ReplicationService } from "../../base/ReplicationService";
import type { ServiceContext } from "../../base/ServiceBase";

export class InjectableReplicationService<T extends ServiceContext> extends ReplicationService<T> {}
