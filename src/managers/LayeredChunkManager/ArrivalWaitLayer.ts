import { type PromiseWithResolvers, promiseWithResolvers } from "octagonal-wheels/promises";
import type { DocumentID, EntryLeaf } from "@lib/common/types";
import type { IReadLayer } from "./ChunkLayerInterfaces";
import type { ChunkReadOptions } from "./types.ts";
import { ChunkDeliveryCoordinator } from "@lib/managers/ChunkDeliveryCoordinator.ts";
import { LOG_LEVEL_VERBOSE, Logger } from "@lib/common/logger.ts";
import type { ContentReadFailureCause, ChunkReadFailureReason } from "@lib/replication/contentRead.ts";

type ChunkUnavailableObserver = (
    id: DocumentID,
    reason: ChunkReadFailureReason,
    cause?: ContentReadFailureCause
) => void;

export type ChunkAvailabilityRecheck = (ids: readonly DocumentID[]) => Promise<readonly (EntryLeaf | false)[]>;

/**
 * Waits only for a delivery lifecycle which is already observable when the
 * local miss is handled. It does not guess at an arrival delay.
 */
export class ArrivalWaitLayer implements IReadLayer {
    private readonly waitingMap = new Map<
        DocumentID,
        {
            resolver: PromiseWithResolvers<EntryLeaf | false>;
            observedActivity: boolean;
            activityVersion: number;
            failureReason?: ChunkReadFailureReason;
            failureCause?: ContentReadFailureCause;
            unavailableObservers: Set<ChunkUnavailableObserver>;
        }
    >();
    private readonly eventEmitter: (eventName: string, data: DocumentID[]) => void;
    private readonly deliveryCoordinator: ChunkDeliveryCoordinator;
    private readonly ownsDeliveryCoordinator: boolean;
    private readonly stopObservingActivity: () => void;

    constructor(
        eventEmitter: (eventName: string, data: DocumentID[]) => void,
        deliveryCoordinator?: ChunkDeliveryCoordinator,
        private readonly recheckAvailability?: ChunkAvailabilityRecheck
    ) {
        this.eventEmitter = eventEmitter;
        this.deliveryCoordinator = deliveryCoordinator ?? new ChunkDeliveryCoordinator();
        this.ownsDeliveryCoordinator = deliveryCoordinator === undefined;
        this.stopObservingActivity = this.deliveryCoordinator.onChanged((ids) => this.refreshActivity(ids));
    }

    private enqueueWaiting(
        id: DocumentID,
        onUnavailable?: ChunkUnavailableObserver
    ): Promise<EntryLeaf | false> {
        const previous = this.waitingMap.get(id);
        if (previous) {
            if (onUnavailable) {
                previous.unavailableObservers.add(onUnavailable);
            }
            return previous.resolver.promise;
        }

        const resolver = promiseWithResolvers<EntryLeaf | false>();
        this.waitingMap.set(id, {
            activityVersion: 0,
            observedActivity: false,
            resolver,
            unavailableObservers: new Set(onUnavailable ? [onUnavailable] : []),
        });
        return resolver.promise;
    }

    private settle(
        id: DocumentID,
        value: EntryLeaf | false,
        reason?: ChunkReadFailureReason,
        cause?: ContentReadFailureCause
    ): void {
        const queue = this.waitingMap.get(id);
        if (!queue) return;
        this.waitingMap.delete(id);
        queue.resolver.resolve(value);
        if (value) {
            return;
        }

        const failureReason = reason ?? queue.failureReason ?? "unavailable";
        const failureCause = cause ?? (reason === undefined || reason === queue.failureReason ? queue.failureCause : undefined);
        for (const observer of queue.unavailableObservers) {
            try {
                if (failureCause) {
                    observer(id, failureReason, failureCause);
                } else {
                    observer(id, failureReason);
                }
            } catch (error) {
                Logger("A chunk-read unavailability observer failed.", LOG_LEVEL_VERBOSE);
                Logger(error, LOG_LEVEL_VERBOSE);
            }
        }
    }

    private async settleAfterObservedActivity(ids: readonly DocumentID[]): Promise<void> {
        const candidates = ids.flatMap((id) => {
            const queue = this.waitingMap.get(id);
            if (!queue?.observedActivity || this.deliveryCoordinator.isActivityActiveFor(id)) return [];
            const version = ++queue.activityVersion;
            return [{ id, version }];
        });
        if (candidates.length === 0) return;

        let results: readonly (EntryLeaf | false)[];
        try {
            results = this.recheckAvailability
                ? await this.recheckAvailability(candidates.map(({ id }) => id))
                : candidates.map(() => false);
        } catch (error) {
            Logger("Could not recheck chunk availability after finite delivery activity completed.", LOG_LEVEL_VERBOSE);
            Logger(error, LOG_LEVEL_VERBOSE);
            results = candidates.map(() => false);
        }

        for (let index = 0; index < candidates.length; index++) {
            const { id, version } = candidates[index];
            const queue = this.waitingMap.get(id);
            if (!queue || queue.activityVersion !== version) continue;
            const result = results[index] ?? false;
            if (result) {
                this.settle(id, result);
            } else if (this.deliveryCoordinator.isActivityActiveFor(id)) {
                this.refreshActivity([id]);
            } else {
                this.settle(id, false, queue.failureReason, queue.failureCause);
            }
        }
    }

    private refreshActivity(ids: readonly DocumentID[] = [...this.waitingMap.keys()]): void {
        const completedActivityIds: DocumentID[] = [];
        for (const id of ids) {
            const queue = this.waitingMap.get(id);
            if (!queue) continue;
            if (this.deliveryCoordinator.isActivityActiveFor(id)) {
                queue.observedActivity = true;
                queue.activityVersion++;
            } else if (queue.observedActivity) {
                completedActivityIds.push(id);
            } else {
                this.settle(id, false, queue.failureReason, queue.failureCause);
            }
        }
        if (completedActivityIds.length > 0) {
            void this.settleAfterObservedActivity(completedActivityIds);
        }
    }

    /** Handle a chunk document becoming available. */
    onChunkArrived(doc: EntryLeaf, deleted: boolean = false): void {
        this.settle(doc._id, doc._deleted || deleted ? false : doc);
    }

    /** Record a typed producer failure until every observable producer has finished. */
    onChunkFailed(id: DocumentID, reason: ChunkReadFailureReason, cause?: ContentReadFailureCause): void {
        const queue = this.waitingMap.get(id);
        if (!queue) {
            return;
        }
        queue.failureReason ??= reason;
        queue.failureCause ??= cause;
        queue.observedActivity = true;
        queue.activityVersion++;
        this.refreshActivity([id]);
    }

    /** Handle an explicit remote-missing result. */
    onMissingChunk(id: DocumentID): void {
        const queue = this.waitingMap.get(id);
        this.settle(id, false, queue?.failureReason ?? "missing", queue?.failureCause);
    }

    async read(
        ids: DocumentID[],
        options: ChunkReadOptions,
        next: (remaining: DocumentID[]) => Promise<(EntryLeaf | false)[]>
    ): Promise<(EntryLeaf | false)[]> {
        const waitForDelivery = options.waitForDelivery ?? (options.timeout === undefined || options.timeout > 0);
        if (ids.length === 0) {
            return [];
        }
        if (!waitForDelivery) {
            for (const id of ids) {
                try {
                    options.onUnavailable?.(id, "unavailable");
                } catch (error) {
                    Logger("A chunk-read unavailability observer failed.", LOG_LEVEL_VERBOSE);
                    Logger(error, LOG_LEVEL_VERBOSE);
                }
            }
            return ids.map(() => false);
        }

        const observer = options.onUnavailable
            ? (id: DocumentID, reason: ChunkReadFailureReason, cause?: ContentReadFailureCause) => {
                  if (cause) {
                      options.onUnavailable?.(id, reason, cause);
                  } else {
                      options.onUnavailable?.(id, reason);
                  }
              }
            : undefined;
        const tasks = ids.map((id) => this.enqueueWaiting(id, observer));
        if (!options.preventRemoteRequest) {
            // EventTarget dispatch is synchronous. ChunkFetcher claims the identifiers
            // before this call returns, closing the scheduling gap without a timer.
            this.eventEmitter("missingChunks", ids);
        }
        this.refreshActivity(ids);
        return await Promise.all(tasks);
    }

    clearWaiting(): void {
        for (const id of [...this.waitingMap.keys()]) {
            this.settle(id, false, "cancelled");
        }
    }

    tearDown(): void {
        this.stopObservingActivity();
        this.clearWaiting();
        if (this.ownsDeliveryCoordinator) {
            this.deliveryCoordinator.dispose();
        }
    }

    getWaitingCount(): number {
        return this.waitingMap.size;
    }
}
