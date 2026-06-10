import { ReplicationService } from "@lib/services/base/ReplicationService";
import type { ServiceContext } from "@lib/services/base/ServiceBase";

export class InjectableReplicationService<T extends ServiceContext> extends ReplicationService<T> {}
