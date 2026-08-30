import type { ReplicatorInstance } from "@lib/replication/ReplicatorInstance";
import type { ActiveReplicatorContext, ReplicatorProviderDefinition } from "@lib/replication/ReplicatorProvider";

export interface ActiveReplicatorPublication {
    readonly replicator: ReplicatorInstance;
    readonly replicatorType: string;
    readonly context: ActiveReplicatorContext | undefined;
    readonly configurationIdentity: string | undefined;
}

/** One admitted use of an exact active publication. */
export interface ActiveReplicatorReservation {
    readonly context: ActiveReplicatorContext;
    /** Release this reservation. Repeated calls have no effect. */
    release(): void;
}

/** Private service-side control over one fenced publication. */
export interface ActiveReplicatorRetirement {
    readonly publication: ActiveReplicatorPublication;
    /** Wait until every use admitted before the fence has settled. */
    waitForDemandSettlement(): Promise<void>;
    /** Mark physical close complete. Repeated calls have no effect. */
    complete(): void;
}

class ActiveReplicatorPublicationOwner {
    private accepting = true;
    private demandCount = 0;
    private demandSettlement: Promise<void> | undefined;
    private settleDemand: (() => void) | undefined;

    constructor(readonly publication: ActiveReplicatorPublication) {}

    reserve(): ActiveReplicatorReservation | undefined {
        const context = this.publication.context;
        if (!this.accepting || !context) {
            return undefined;
        }

        this.demandCount++;
        let released = false;
        return {
            context,
            release: () => {
                if (released) return;
                released = true;
                this.demandCount--;
                if (this.demandCount === 0) {
                    this.settleDemand?.();
                    this.settleDemand = undefined;
                }
            },
        };
    }

    stopAccepting(): void {
        this.accepting = false;
    }

    waitForDemandSettlement(): Promise<void> {
        if (this.demandCount === 0) {
            return Promise.resolve();
        }
        this.demandSettlement ??= new Promise<void>((resolve) => {
            this.settleDemand = resolve;
        });
        return this.demandSettlement;
    }

    get hasDemand(): boolean {
        return this.demandCount !== 0;
    }
}

/**
 * Keep active publication, admission, and quiescing retirement as one state.
 *
 * The publication object itself is the generation identity. Retirement first
 * removes it from `current`, then waits only for reservations captured from
 * that object. A replacement cannot be published until physical retirement is
 * explicitly completed.
 */
export class ActiveReplicatorState {
    private activeOwner: ActiveReplicatorPublicationOwner | undefined;
    private retiringOwner: ActiveReplicatorPublicationOwner | undefined;
    private retirement: ActiveReplicatorRetirement | undefined;

    get current(): ActiveReplicatorPublication | undefined {
        return this.activeOwner?.publication;
    }

    publish(
        provider: ReplicatorProviderDefinition | undefined,
        replicator: ReplicatorInstance,
        replicatorType: string,
        configurationIdentity: string | undefined
    ): void {
        if (this.activeOwner) {
            throw new Error("Cannot replace an active Replicator without beginning retirement.");
        }
        if (this.retiringOwner) {
            throw new Error("Cannot publish an active Replicator before retirement has completed.");
        }
        this.activeOwner = new ActiveReplicatorPublicationOwner({
            replicator,
            replicatorType,
            context: provider ? { provider, replicator } : undefined,
            configurationIdentity: provider ? configurationIdentity : undefined,
        });
    }

    /** Reserve the current typed publication, or reject admission while quiescing. */
    reserve(): ActiveReplicatorReservation | undefined {
        return this.activeOwner?.reserve();
    }

    /**
     * Fence the current publication and begin its explicit quiescing transition.
     *
     * Completion is separate from demand settlement so callers cannot publish a
     * replacement between draining admitted work and physically closing the old
     * Replicator.
     */
    beginRetirement(): ActiveReplicatorRetirement | undefined {
        if (this.retirement) return this.retirement;

        const owner = this.activeOwner;
        if (!owner) return undefined;

        owner.stopAccepting();
        this.activeOwner = undefined;
        this.retiringOwner = owner;
        let completed = false;
        const retirement: ActiveReplicatorRetirement = {
            publication: owner.publication,
            waitForDemandSettlement: () => owner.waitForDemandSettlement(),
            complete: () => {
                if (completed) return;
                if (owner.hasDemand) {
                    throw new Error("Cannot complete active Replicator retirement while admitted work remains.");
                }
                if (this.retiringOwner !== owner) {
                    throw new Error("Active Replicator retirement no longer owns the quiescing state.");
                }
                completed = true;
                this.retiringOwner = undefined;
                this.retirement = undefined;
            },
        };
        this.retirement = retirement;
        return retirement;
    }
}
