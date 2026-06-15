import { type PromiseWithResolvers, promiseWithResolvers } from "octagonal-wheels/promises";
import type { DocumentID, EntryLeaf } from "../../common/types";
import type { IReadLayer } from "./ChunkLayerInterfaces";
import type { ChunkReadOptions } from "./types.ts";
import { compatGlobal } from "@lib/common/coreEnvFunctions.ts";
import type { IReplicatorService } from "@lib/services/base/IService.ts";
import { LOG_LEVEL_VERBOSE, Logger } from "@lib/common/logger.ts";

/**
 * Arrival wait layer - emits events for fetcher, and waits for chunks to arrive
 */

export class ArrivalWaitLayer implements IReadLayer {
    private waitingMap = new Map<
        DocumentID,
        {
            resolver: PromiseWithResolvers<EntryLeaf | false>;
        }
    >();
    private readonly DEFAULT_TIMEOUT = 15000;
    private readonly eventEmitter: (eventName: string, data: DocumentID[]) => void;
    private replicatorService?: IReplicatorService;
    private disposers: (() => void)[] = [];

    constructor(eventEmitter: (eventName: string, data: DocumentID[]) => void, replicatorService?: IReplicatorService) {
        this.eventEmitter = eventEmitter;
        this.replicatorService = replicatorService;

        if (this.replicatorService) {
            // Listen to the online activity status reactively. If online activity
            // (replication or active fetching) becomes inactive, immediately time out
            // and resolve any pending chunk wait promises to false. This prevents
            // UI hangs during network loss or pause.
            const listener = () => {
                if (!this.replicatorService!.isOnlineActivityActive.value) {
                    if (this.waitingMap.size > 0) {
                        Logger(
                            `Online activity is inactive. Timing out ${this.waitingMap.size} waiting chunks immediately.`,
                            LOG_LEVEL_VERBOSE
                        );
                        this.clearWaiting();
                    }
                }
            };
            this.replicatorService.isOnlineActivityActive.onChanged(listener);
            this.disposers.push(() => {
                this.replicatorService!.isOnlineActivityActive.offChanged(listener);
            });
        }
    }

    private enqueueWaiting(id: DocumentID, timeout: number): Promise<EntryLeaf | false> {
        // If online activity is already inactive, return false immediately to avoid waiting.
        if (this.replicatorService && !this.replicatorService.isOnlineActivityActive.value) {
            return Promise.resolve(false);
        }

        const previous = this.waitingMap.get(id);
        if (previous) {
            return previous.resolver.promise;
        }

        const resolver = promiseWithResolvers<EntryLeaf | false>();
        this.waitingMap.set(id, { resolver });

        return this.withTimeout(resolver.promise, timeout, () => {
            const current = this.waitingMap.get(id);
            if (current && current.resolver === resolver) {
                this.waitingMap.delete(id);
            }
            return false;
        });
    }

    private withTimeout<T>(proc: Promise<T>, timeout: number, onTimedOut: () => T): Promise<T> {
        return new Promise((resolve, reject) => {
            const timer = compatGlobal.setTimeout(() => {
                resolve(onTimedOut());
            }, timeout);
            proc.then(resolve)
                .catch(reject)
                .finally(() => {
                    compatGlobal.clearTimeout(timer);
                });
        });
    }

    /**
     * Handle chunk arrival (called when a chunk document arrives)
     */
    onChunkArrived(doc: EntryLeaf, deleted: boolean = false): void {
        const id = doc._id;
        if (this.waitingMap.has(id)) {
            const queue = this.waitingMap.get(id)!;
            this.waitingMap.delete(id);
            if (doc._deleted || deleted) {
                queue.resolver.resolve(false);
            } else {
                queue.resolver.resolve(doc);
            }
        }
    }

    /**
     * Handle missing chunk (called when a chunk is confirmed missing)
     */
    onMissingChunk(id: DocumentID): void {
        if (this.waitingMap.has(id)) {
            const queue = this.waitingMap.get(id)!;
            this.waitingMap.delete(id);
            queue.resolver.resolve(false);
        }
    }

    async read(
        ids: DocumentID[],
        options: ChunkReadOptions,
        next: (remaining: DocumentID[]) => Promise<(EntryLeaf | false)[]>
    ): Promise<(EntryLeaf | false)[]> {
        const timeout = options.timeout ?? this.DEFAULT_TIMEOUT;

        if (timeout <= 0 || ids.length === 0) {
            return ids.map(() => false);
        }

        // Wait for chunks to arrive
        const tasks = ids.map((id) => this.enqueueWaiting(id, timeout));

        if (!options.preventRemoteRequest) {
            this.eventEmitter("missingChunks", ids);
        }

        const results = await Promise.all(tasks);
        return results;
    }

    /**
     * Clear all waiting requests
     */
    clearWaiting(): void {
        for (const [, queue] of this.waitingMap.entries()) {
            queue.resolver.resolve(false);
        }
        this.waitingMap.clear();
    }

    tearDown(): void {
        this.clearWaiting();
        for (const dispose of this.disposers) {
            dispose();
        }
        this.disposers = [];
    }
    /**
     * Get count of waiting chunks
     */
    getWaitingCount(): number {
        return this.waitingMap.size;
    }
}
