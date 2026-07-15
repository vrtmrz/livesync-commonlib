import { delay, promiseWithResolvers } from "octagonal-wheels/promises";
import { unique } from "octagonal-wheels/collection";
import { LOG_LEVEL_VERBOSE, Logger } from "@lib/common/logger.ts";
import { DEFAULT_SETTINGS, type DocumentID, type EntryLeaf } from "@lib/common/types.ts";

import { type ChunkManager } from "./ChunkManager.ts";

import type { IReplicatorService, ISettingService } from "@lib/services/base/IService.ts";
import { compatGlobal } from "@lib/common/coreEnvFunctions.ts";
import { DEFAULT_CHUNK_DELIVERY_STALL_TIMEOUT_MS, type ChunkDeliveryClaim } from "./ChunkDeliveryCoordinator.ts";

export const EVENT_MISSING_CHUNKS = "missingChunks";
export const EVENT_MISSING_CHUNK_REMOTE = "missingChunkRemote";
export const EVENT_CHUNK_FETCHED = "chunkFetched"; // Event for chunk arrival
export type ChunkFetcherOptions = {
    settingService: ISettingService;
    chunkManager: ChunkManager;
    replicatorService: IReplicatorService;
    deliveryStallTimeoutMs?: number;
};
const BATCH_SIZE = 100; // Number of chunks to fetch in one request

type PendingChunkDelivery = {
    activityBoundaryEntered: Promise<boolean>;
    claim: ChunkDeliveryClaim;
    resolveActivityBoundary: (entered: boolean) => void;
};

export class ChunkFetcher {
    options: ChunkFetcherOptions;
    get chunkManager(): ChunkManager {
        return this.options.chunkManager;
    }

    queue = [] as DocumentID[];
    private readonly pendingClaims = new Map<DocumentID, PendingChunkDelivery>();
    private destroyed = false;

    get interval(): number {
        const settings = this.options.settingService.currentSettings();
        return settings.minimumIntervalOfReadChunksOnline || DEFAULT_SETTINGS.minimumIntervalOfReadChunksOnline;
    }

    get concurrency(): number {
        const settings = this.options.settingService.currentSettings();
        return settings.concurrencyOfReadChunksOnline || DEFAULT_SETTINGS.concurrencyOfReadChunksOnline;
    }

    abort: AbortController = new AbortController();
    constructor(options: ChunkFetcherOptions) {
        this.options = options;
        // TODO: Confirm whether this is correctly dereferenced upon instance re-creation. EventTarget may handle this safely.
        this.chunkManager.addListener(EVENT_MISSING_CHUNKS, this.onEventHandler, {
            signal: this.abort.signal,
        });
    }
    destroy(): void {
        if (this.destroyed) return;
        this.destroyed = true;
        this.abort.abort(); // Stop accepting missing-chunk events.
        this.queue = []; // Clear the queue.
        const pendingDeliveries = new Set(this.pendingClaims.values());
        this.pendingClaims.clear();
        for (const pending of pendingDeliveries) {
            pending.resolveActivityBoundary(false);
            pending.claim.release();
        }
    }
    onEventHandler = this.onEvent.bind(this);

    onEvent(ids: DocumentID[]): void {
        if (this.destroyed) return;
        const claimedIds = this.ensureClaims(ids);
        this.queue = unique([...this.queue, ...claimedIds]);
        if (this.canRequestMore()) {
            compatGlobal.setTimeout(() => void this.requestMissingChunks(), 1);
        }
    }

    private ensureClaims(ids: readonly DocumentID[]): DocumentID[] {
        const unclaimedIds = unique(ids.filter((id) => !this.pendingClaims.has(id)));
        if (unclaimedIds.length === 0) return [];

        let pending!: PendingChunkDelivery;
        const activityBoundary = promiseWithResolvers<boolean>();
        const claim = this.chunkManager.deliveryCoordinator.claim(unclaimedIds, {
            stallTimeoutMs: this.options.deliveryStallTimeoutMs ?? DEFAULT_CHUNK_DELIVERY_STALL_TIMEOUT_MS,
            onStalled: (stalledIds) => this.onClaimStalled(pending, stalledIds),
        });
        pending = {
            activityBoundaryEntered: activityBoundary.promise,
            claim,
            resolveActivityBoundary: activityBoundary.resolve,
        };
        for (const id of unclaimedIds) {
            this.pendingClaims.set(id, pending);
        }
        void this.options.replicatorService
            .runBoundedRemoteActivity(
                () => {
                    pending.claim.touch();
                    pending.resolveActivityBoundary(true);
                    return claim.done;
                },
                { label: "chunk-fetch" }
            )
            .catch((error) => {
                const abandonedIds = claim.pendingIds;
                pending.resolveActivityBoundary(false);
                this.removePendingDelivery(pending, abandonedIds);
                claim.release();
                Logger("The chunk-delivery activity runner rejected before the claim settled.", LOG_LEVEL_VERBOSE);
                Logger(error, LOG_LEVEL_VERBOSE);
            });
        return unclaimedIds;
    }

    private removePendingDelivery(pending: PendingChunkDelivery, ids: readonly DocumentID[]): void {
        for (const id of ids) {
            if (this.pendingClaims.get(id) === pending) {
                this.pendingClaims.delete(id);
            }
        }
        const removed = new Set(ids);
        this.queue = this.queue.filter((id) => !(removed.has(id) && !this.pendingClaims.has(id)));
    }

    private onClaimStalled(pending: PendingChunkDelivery, stalledIds: readonly DocumentID[]): void {
        pending.resolveActivityBoundary(false);
        this.removePendingDelivery(pending, stalledIds);
        Logger(`Chunk delivery stalled for the following IDs: ${stalledIds.join(", ")}`, LOG_LEVEL_VERBOSE);
    }

    private settleClaim(id: DocumentID): void {
        const pending = this.pendingClaims.get(id);
        if (!pending) return;
        this.pendingClaims.delete(id);
        pending.claim.settle(id);
    }

    private touchClaims(ids: readonly DocumentID[]): void {
        const pendingDeliveries = new Set(
            ids.map((id) => this.pendingClaims.get(id)).filter((pending) => pending !== undefined)
        );
        for (const pending of pendingDeliveries) {
            pending.claim.touch();
        }
    }

    private async waitForActivityBoundary(ids: readonly DocumentID[]): Promise<DocumentID[]> {
        const pendingDeliveries = new Set(
            ids.map((id) => this.pendingClaims.get(id)).filter((pending) => pending !== undefined)
        );
        const entered = new Map(
            await Promise.all(
                [...pendingDeliveries].map(async (pending) => [pending, await pending.activityBoundaryEntered] as const)
            )
        );
        return ids.filter((id) => {
            const pending = this.pendingClaims.get(id);
            return pending !== undefined && entered.get(pending) === true;
        });
    }

    /**
     * Processing requests
     */
    currentProcessing = 0;
    /**
     * Time of the last request to the remote server.
     * This is used to manage the interval between requests.
     * Even if concurrency allows, every start of a request will ensure that the interval is respected.
     */
    previousRequestTime = 0;

    canRequestMore(): boolean {
        return this.currentProcessing < this.concurrency && this.queue.length > 0;
    }

    async requestMissingChunks(): Promise<void> {
        if (this.destroyed || !this.canRequestMore()) {
            return; // Do not proceed if the concurrency limit is reached or the queue is empty.
        }
        let requestIDs: DocumentID[] = [];
        try {
            // Logger(`Requesting missing chunks: ${this.queue.join(", ")}`);
            this.currentProcessing++;
            requestIDs = this.queue.splice(0, BATCH_SIZE);
            this.ensureClaims(requestIDs);
            requestIDs = await this.waitForActivityBoundary(requestIDs);
            if (requestIDs.length === 0) return;
            this.touchClaims(requestIDs);
            const now = Date.now();
            const timeSinceLastRequest = now - this.previousRequestTime;
            this.previousRequestTime = now;
            const timeToWait = Math.max(this.interval - timeSinceLastRequest, 0);
            // An interval at or above the claim's inactivity fuse is exceptional;
            // the safety valve may release logical ownership before this pause ends.
            if (timeToWait > 0) await delay(timeToWait);
            this.touchClaims(requestIDs);
            const replicator = this.options.replicatorService.getActiveReplicator();
            if (!replicator) {
                Logger("No active replicator was found to request missing chunks.");
                return;
            }
            // Request the replicator to fetch the missing chunks.
            const fetched = await replicator.fetchRemoteChunks(requestIDs, false);
            this.touchClaims(requestIDs);
            if (!fetched) {
                Logger(`No chunks were found for the following IDs: ${requestIDs.join(", ")}`);
                for (const chunkID of requestIDs) {
                    this.chunkManager.emitEvent(EVENT_MISSING_CHUNK_REMOTE, chunkID);
                }
                return;
            }
            // Validate fetched chunks (Now I am wondering why it happened...)
            function isValidChunk(chunk: Partial<EntryLeaf>): chunk is EntryLeaf {
                return chunk && typeof chunk?._id === "string" && typeof chunk?.data === "string";
            }
            const chunks = fetched.filter((chunk) => isValidChunk(chunk));
            if (chunks.length !== fetched.length) {
                Logger(
                    `Some fetched chunks are invalid and will be ignored: (${fetched.length - chunks.length} / ${fetched.length}).`,
                    LOG_LEVEL_VERBOSE
                );
                for (const chunk of fetched) {
                    if (!isValidChunk(chunk)) {
                        Logger(`Invalid chunk: ${JSON.stringify(chunk)}`, LOG_LEVEL_VERBOSE);
                    }
                }
            }
            if (chunks.length === 0) {
                Logger(`No valid chunks were found for the following IDs: ${requestIDs.join(", ")}`);
            }
            const missingIDs = requestIDs.filter((id) => !chunks.some((chunk) => chunk._id === id));
            try {
                if (chunks.length === 0) {
                    return;
                }
                Logger(`Writing fetched chunks (${chunks.length}) to the database...`);
                const result = await this.chunkManager.write(
                    chunks,
                    {
                        skipCache: true,
                        force: true, // Force writing to ensure the chunks with existing _rev.
                    },
                    "ChunkFetcher" as DocumentID
                );
                this.touchClaims(requestIDs);
                if (result.result === true) {
                    // Successfully written to the database
                    Logger(`Fetched chunks were stored successfully: ${chunks.length}`, LOG_LEVEL_VERBOSE);
                } else {
                    Logger(
                        `Fetched chunks could not be stored: ${chunks.map((chunk) => chunk._id).join(", ")}`,
                        LOG_LEVEL_VERBOSE
                    );
                }
            } catch (error) {
                Logger(`An error occurred while storing fetched chunks!`, LOG_LEVEL_VERBOSE);
                Logger(error, LOG_LEVEL_VERBOSE);
            } finally {
                // Emitting fetched chunks and missing IDs regardless of write success (just only refetch will be triggered).
                for (const chunk of chunks) {
                    this.chunkManager.emitEvent(EVENT_CHUNK_FETCHED, chunk);
                }
                for (const chunkID of missingIDs) {
                    this.chunkManager.emitEvent(EVENT_MISSING_CHUNK_REMOTE, chunkID);
                }
            }
            // The queue is cleared after requesting.
        } catch (error) {
            Logger("An error occurred while fetching remote chunks.", LOG_LEVEL_VERBOSE);
            Logger(error, LOG_LEVEL_VERBOSE);
        } finally {
            for (const id of requestIDs) {
                this.settleClaim(id);
            }
            this.currentProcessing--;
            this.previousRequestTime = Date.now();
            if (this.queue.length > 0) {
                // If there are remaining items in the queue, trigger the next process.
                // Use setTimeout to release the call stack once.
                compatGlobal.setTimeout(() => void this.requestMissingChunks(), 0);
            }
        }
    }
}
