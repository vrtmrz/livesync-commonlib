import type { ReactiveSource } from "octagonal-wheels/dataobject/reactive";
import { promiseWithResolvers } from "octagonal-wheels/promises";
import { compatGlobal } from "@lib/common/coreEnvFunctions";
import type { DocumentID } from "@lib/common/types";

/**
 * A last-resort leak fuse for an accepted delivery claim which reports no
 * observable progress. It releases logical ownership so a waiter, and an
 * entered bounded activity with its Wake Lock and indicator, cannot be retained
 * forever by a stalled transport or never-settling Promise.
 *
 * Five minutes is a conservative operational ceiling, not a normal
 * chunk-arrival budget, evidence of remote absence, or a transport deadline.
 * The transport contract cannot yet abort the underlying request when it fires.
 */
export const DEFAULT_CHUNK_DELIVERY_STALL_TIMEOUT_MS = 5 * 60 * 1000;

export type ActivityCountSource = Pick<ReactiveSource<number>, "value" | "onChanged" | "offChanged">;

export type ChunkDeliveryClaimOptions = {
    stallTimeoutMs?: number;
    onStalled?: (ids: readonly DocumentID[]) => void;
};

export type ChunkDeliveryChangeListener = (ids?: readonly DocumentID[]) => void;

/** A finite claim that keeps chunk arrival waiters paused until every owned identifier settles. */
export interface ChunkDeliveryClaim {
    readonly done: Promise<void>;
    readonly pendingIds: readonly DocumentID[];
    release(): void;
    settle(id: DocumentID): void;
    touch(): void;
}

/**
 * Coordinates on-demand chunk ownership with broader finite remote activity.
 *
 * `ChunkFetcher` owns claims. `ArrivalWaitLayer` observes only whether an
 * identifier may still be delivered, so it does not depend on a replicator
 * service or on fetch scheduling details.
 */
export class ChunkDeliveryCoordinator {
    private readonly activeClaimCounts = new Map<DocumentID, number>();
    private readonly claimReleases = new Set<() => void>();
    private readonly listeners = new Set<ChunkDeliveryChangeListener>();
    private finiteActivityWasActive = false;
    private readonly finiteActivityChanged = () => {
        const active = (this.finiteReplicationActivity?.value ?? 0) > 0;
        if (active === this.finiteActivityWasActive) return;
        this.finiteActivityWasActive = active;
        this.notifyChanged();
    };
    private disposed = false;

    constructor(private readonly finiteReplicationActivity?: ActivityCountSource) {
        this.finiteActivityWasActive = (finiteReplicationActivity?.value ?? 0) > 0;
        this.finiteReplicationActivity?.onChanged(this.finiteActivityChanged);
    }

    claim(ids: readonly DocumentID[], options: ChunkDeliveryClaimOptions = {}): ChunkDeliveryClaim {
        if (this.disposed) {
            throw new Error("Cannot claim chunk delivery activity after the coordinator has been disposed.");
        }

        const pending = new Set(ids);
        const resolver = promiseWithResolvers<void>();
        if (pending.size === 0) {
            resolver.resolve();
            return {
                done: resolver.promise,
                pendingIds: [],
                release: () => undefined,
                settle: () => undefined,
                touch: () => undefined,
            };
        }
        const stallTimeoutMs = options.stallTimeoutMs ?? DEFAULT_CHUNK_DELIVERY_STALL_TIMEOUT_MS;
        let timer: number | undefined;
        let released = false;

        const clearTimer = () => {
            if (timer === undefined) return;
            compatGlobal.clearTimeout(timer);
            timer = undefined;
        };
        const removeActiveIds = (activeIds: readonly DocumentID[]) => {
            for (const id of activeIds) {
                const count = this.activeClaimCounts.get(id) ?? 0;
                if (count <= 1) {
                    this.activeClaimCounts.delete(id);
                } else {
                    this.activeClaimCounts.set(id, count - 1);
                }
            }
        };
        const release = () => {
            if (released) return;
            released = true;
            clearTimer();
            const activeIds = [...pending];
            pending.clear();
            removeActiveIds(activeIds);
            this.claimReleases.delete(release);
            resolver.resolve();
            if (activeIds.length > 0) {
                this.notifyChanged(activeIds);
            }
        };
        const armStallTimer = () => {
            clearTimer();
            if (released || pending.size === 0 || stallTimeoutMs <= 0) return;
            timer = compatGlobal.setTimeout(() => {
                timer = undefined;
                const stalledIds = [...pending];
                release();
                options.onStalled?.(stalledIds);
            }, stallTimeoutMs);
        };
        const settle = (id: DocumentID) => {
            if (released || !pending.delete(id)) return;
            removeActiveIds([id]);
            this.notifyChanged([id]);
            if (pending.size === 0) {
                release();
            } else {
                armStallTimer();
            }
        };

        for (const id of pending) {
            this.activeClaimCounts.set(id, (this.activeClaimCounts.get(id) ?? 0) + 1);
        }
        this.claimReleases.add(release);
        this.notifyChanged([...pending]);
        armStallTimer();

        return {
            done: resolver.promise,
            get pendingIds() {
                return [...pending];
            },
            release,
            settle,
            touch: armStallTimer,
        };
    }

    isActivityActiveFor(id: DocumentID): boolean {
        return this.isClaimActiveFor(id) || this.isFiniteReplicationActive();
    }

    isClaimActiveFor(id: DocumentID): boolean {
        return this.activeClaimCounts.has(id);
    }

    isFiniteReplicationActive(): boolean {
        return (this.finiteReplicationActivity?.value ?? 0) > 0;
    }

    onChanged(listener: ChunkDeliveryChangeListener): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        this.finiteReplicationActivity?.offChanged(this.finiteActivityChanged);
        for (const release of [...this.claimReleases]) {
            release();
        }
        this.listeners.clear();
    }

    private notifyChanged(ids?: readonly DocumentID[]): void {
        for (const listener of this.listeners) {
            listener(ids);
        }
    }
}
