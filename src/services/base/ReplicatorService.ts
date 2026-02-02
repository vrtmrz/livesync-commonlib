import type { LiveSyncAbstractReplicator } from "@lib/replication/LiveSyncAbstractReplicator";
import { handlers } from "@lib/services/lib/HandlerUtils";
import type { IReplicatorService } from "./IService";
import { ServiceBase, type ServiceContext } from "./ServiceBase";

/**
 * The ReplicatorService provides methods for managing replication.
 */
export abstract class ReplicatorService<T extends ServiceContext = ServiceContext>
    extends ServiceBase<T>
    implements IReplicatorService
{
    /**
     * Close the active replication if any.
     * Not used currently.
     */
    readonly onCloseActiveReplication = handlers<IReplicatorService>().anySuccess("onCloseActiveReplication");

    /**
     * Get a new replicator instance based on the provided settings.
     */
    readonly getNewReplicator = handlers<IReplicatorService>().firstResult("getNewReplicator");
    /**
     * Get the currently active replicator instance.
     * If no active replicator, return undefined but that is the fatal situation (on Obsidian).
     */
    abstract getActiveReplicator(): LiveSyncAbstractReplicator | undefined;
}
