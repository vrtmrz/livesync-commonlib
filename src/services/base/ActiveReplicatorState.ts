import type { LiveSyncAbstractReplicator } from "@lib/replication/LiveSyncAbstractReplicator";
import type { ActiveReplicatorContext, ReplicatorProviderDefinition } from "@lib/replication/ReplicatorProvider";

export interface ActiveReplicatorPublication {
    readonly replicator: LiveSyncAbstractReplicator;
    readonly replicatorType: string;
    readonly context: ActiveReplicatorContext | undefined;
    readonly configurationIdentity: string | undefined;
}

/** Keep the published Replicator and all of its ownership metadata as one atomic state. */
export class ActiveReplicatorState {
    private publication: ActiveReplicatorPublication | undefined;

    get current(): ActiveReplicatorPublication | undefined {
        return this.publication;
    }

    publish(
        provider: ReplicatorProviderDefinition | undefined,
        replicator: LiveSyncAbstractReplicator,
        replicatorType: string,
        configurationIdentity: string | undefined
    ): void {
        this.publication = {
            replicator,
            replicatorType,
            context: provider ? { provider, replicator } : undefined,
            configurationIdentity: provider ? configurationIdentity : undefined,
        };
    }

    /** Clear the complete publication before its previous Replicator is retired. */
    take(): LiveSyncAbstractReplicator | undefined {
        const replicator = this.publication?.replicator;
        this.publication = undefined;
        return replicator;
    }

    /** Clear the publication only when it owns the supplied Replicator instance. */
    discardIfCurrent(replicator: LiveSyncAbstractReplicator): boolean {
        if (this.publication?.replicator !== replicator) {
            return false;
        }
        this.publication = undefined;
        return true;
    }
}
