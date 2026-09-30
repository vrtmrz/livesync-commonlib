import { delay, promiseWithResolvers } from "octagonal-wheels/promises";
import { unique } from "octagonal-wheels/collection";
import { LOG_LEVEL_VERBOSE, Logger } from "@lib/common/logger.ts";
import { DEFAULT_SETTINGS, type DocumentID, type EntryLeaf } from "@lib/common/types.ts";

import { type ChunkManager } from "./ChunkManager.ts";

import type { IReplicatorService, ISettingService } from "@lib/services/base/IService.ts";
import type { ReplicatorInstance } from "@lib/replication/ReplicatorInstance.ts";
import { compatGlobal } from "@lib/common/coreEnvFunctions.ts";
import { DEFAULT_CHUNK_DELIVERY_STALL_TIMEOUT_MS, type ChunkDeliveryClaim } from "./ChunkDeliveryCoordinator.ts";
import { chunkFetchCounts, collectingChunks } from "@lib/mock_and_interop/stores";
import {
    classifyFetchedChunks,
    decideMissingChunkAction,
    type FetchedChunkClassification,
} from "./chunkFetcher.helper.ts";

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

type PendingChunkFetch = {
    delivery: PendingChunkDelivery;
    missingResponses: number;
    nextRequestAt: number;
    inFlight: boolean;
};

interface RemoteChunkReader extends ReplicatorInstance {
    fetchRemoteChunks(missingChunks: string[], showResult: boolean): Promise<false | EntryLeaf[]>;
}

function canFetchRemoteChunks(replicator: ReplicatorInstance): replicator is RemoteChunkReader {
    return "fetchRemoteChunks" in replicator && typeof replicator.fetchRemoteChunks === "function";
}

export class ChunkFetcher {
    options: ChunkFetcherOptions;
    get chunkManager(): ChunkManager {
        return this.options.chunkManager;
    }

    queue = [] as DocumentID[];
    private readonly pendingClaims = new Map<DocumentID, PendingChunkFetch>();
    private reportedPendingCount = 0;
    private reportedFetchCounts = { initial: 0, retrying: 0 };
    private requestTimer: number | undefined;
    private requestTimerDueAt = 0;
    private finiteActivityWasActive: boolean;
    private finiteCompletionVersion = 0;
    private readonly stopObservingDelivery: () => void;
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
        this.finiteActivityWasActive = this.chunkManager.deliveryCoordinator.isFiniteReplicationActive();
        this.stopObservingDelivery = this.chunkManager.deliveryCoordinator.onChanged(() => {
            const active = this.chunkManager.deliveryCoordinator.isFiniteReplicationActive();
            const completed = this.finiteActivityWasActive && !active;
            this.finiteActivityWasActive = active;
            if (!completed) return;
            this.finiteCompletionVersion++;
            for (const pending of this.pendingClaims.values()) {
                if (pending.missingResponses > 0 && !pending.inFlight) pending.nextRequestAt = Date.now();
            }
            this.scheduleRequest();
        });
        // TODO: Confirm whether this is correctly dereferenced upon instance re-creation. EventTarget may handle this safely.
        this.chunkManager.addListener(EVENT_MISSING_CHUNKS, this.onEventHandler, {
            signal: this.abort.signal,
        });
    }
    destroy(): void {
        if (this.destroyed) return;
        this.destroyed = true;
        this.abort.abort(); // Stop accepting missing-chunk events.
        this.stopObservingDelivery();
        this.clearRequestTimer();
        this.queue = []; // Clear the queue.
        const pendingDeliveries = new Set([...this.pendingClaims.values()].map((pending) => pending.delivery));
        this.pendingClaims.clear();
        this.updatePendingCount();
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
        this.scheduleRequest(1);
    }

    private clearRequestTimer(): void {
        if (this.requestTimer !== undefined) compatGlobal.clearTimeout(this.requestTimer);
        this.requestTimer = undefined;
    }

    private scheduleRequest(minimumDelayMs = 0): void {
        if (this.destroyed || this.currentProcessing >= this.concurrency || this.queue.length === 0) {
            this.clearRequestTimer();
            return;
        }
        let nextRequestAt = Infinity;
        for (const id of this.queue) {
            const pending = this.pendingClaims.get(id);
            if (!pending?.inFlight) nextRequestAt = Math.min(nextRequestAt, pending?.nextRequestAt ?? 0);
        }
        if (nextRequestAt === Infinity) {
            this.clearRequestTimer();
            return;
        }
        const now = Date.now();
        const dueAt = Math.max(nextRequestAt, now + minimumDelayMs);
        if (this.requestTimer !== undefined && this.requestTimerDueAt <= dueAt) return;
        this.clearRequestTimer();
        this.requestTimerDueAt = dueAt;
        this.requestTimer = compatGlobal.setTimeout(() => {
            this.requestTimer = undefined;
            void this.requestMissingChunks();
        }, dueAt - now);
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
            this.pendingClaims.set(id, { delivery: pending, missingResponses: 0, nextRequestAt: 0, inFlight: false });
        }
        this.updatePendingCount();
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
            if (this.pendingClaims.get(id)?.delivery === pending) {
                this.pendingClaims.delete(id);
            }
        }
        const removed = new Set(ids);
        this.queue = this.queue.filter((id) => !(removed.has(id) && !this.pendingClaims.has(id)));
        this.updatePendingCount();
        this.scheduleRequest();
    }

    private updatePendingCount(): void {
        const nextCount = this.pendingClaims.size;
        const difference = nextCount - this.reportedPendingCount;
        // Record this fetcher's contribution before subscribers can re-enter it.
        this.reportedPendingCount = nextCount;
        if (difference !== 0) collectingChunks.value += difference;
        const nextFetchCounts = { initial: 0, retrying: 0 };
        for (const pending of this.pendingClaims.values()) {
            if (pending.missingResponses > 0) nextFetchCounts.retrying++;
            else nextFetchCounts.initial++;
        }
        const initialDifference = nextFetchCounts.initial - this.reportedFetchCounts.initial;
        const retryingDifference = nextFetchCounts.retrying - this.reportedFetchCounts.retrying;
        this.reportedFetchCounts = nextFetchCounts;
        if (initialDifference !== 0 || retryingDifference !== 0) {
            chunkFetchCounts.value = {
                initial: chunkFetchCounts.value.initial + initialDifference,
                retrying: chunkFetchCounts.value.retrying + retryingDifference,
            };
        }
    }

    private onClaimStalled(pending: PendingChunkDelivery, stalledIds: readonly DocumentID[]): void {
        pending.resolveActivityBoundary(false);
        this.removePendingDelivery(pending, stalledIds);
        Logger(`Chunk delivery stalled for the following IDs: ${stalledIds.join(", ")}`, LOG_LEVEL_VERBOSE);
    }

    private settleClaim(id: DocumentID, pending: PendingChunkFetch | undefined): void {
        if (!pending || this.pendingClaims.get(id) !== pending) return;
        this.pendingClaims.delete(id);
        pending.delivery.claim.settle(id);
        this.updatePendingCount();
    }

    private getActiveClaimIds(
        ids: readonly DocumentID[],
        claims: ReadonlyMap<DocumentID, PendingChunkFetch>
    ): DocumentID[] {
        return ids.filter((id) => claims.has(id) && this.pendingClaims.get(id) === claims.get(id));
    }

    private touchClaims(ids: readonly DocumentID[], claims: ReadonlyMap<DocumentID, PendingChunkFetch>): void {
        const pendingDeliveries = new Set(this.getActiveClaimIds(ids, claims).map((id) => claims.get(id)!.delivery));
        for (const pending of pendingDeliveries) {
            pending.claim.touch();
        }
    }

    private async waitForActivityBoundary(claims: ReadonlyMap<DocumentID, PendingChunkFetch>): Promise<DocumentID[]> {
        const pendingDeliveries = new Set([...claims.values()].map((pending) => pending.delivery));
        const entered = new Map(
            await Promise.all(
                [...pendingDeliveries].map(async (pending) => [pending, await pending.activityBoundaryEntered] as const)
            )
        );
        return [...claims].flatMap(([id, pending]) =>
            this.pendingClaims.get(id) === pending && entered.get(pending.delivery) === true ? [id] : []
        );
    }

    private async waitBeforeRemoteRequest(
        ids: readonly DocumentID[],
        claims: ReadonlyMap<DocumentID, PendingChunkFetch>,
        localCheckCompletionVersion: number
    ): Promise<DocumentID[]> {
        this.touchClaims(ids, claims);
        while (!this.destroyed) {
            const activeIds = this.getActiveClaimIds(ids, claims);
            if (activeIds.length === 0) return [];
            if (localCheckCompletionVersion !== this.finiteCompletionVersion) {
                localCheckCompletionVersion = this.finiteCompletionVersion;
                await this.resolveLocallyAvailableRetries(claims);
                continue;
            }

            const now = Date.now();
            const timeToWait = this.previousRequestTime + this.interval - now;
            // An interval at or above the claim's inactivity fuse is exceptional;
            // the safety valve may release logical ownership before this pause ends.
            if (timeToWait > 0) {
                await delay(timeToWait);
                continue;
            }
            // Reserve the start before yielding, so other waiting requests recheck against it.
            this.previousRequestTime = now;
            this.touchClaims(activeIds, claims);
            return activeIds;
        }
        return [];
    }

    private async resolveLocallyAvailableRetries(claims: ReadonlyMap<DocumentID, PendingChunkFetch>): Promise<void> {
        const retryIds = this.getActiveClaimIds([...claims.keys()], claims).filter(
            (id) => claims.get(id)!.missingResponses > 0
        );
        if (retryIds.length === 0) return;
        const localChunks = await this.chunkManager.read(retryIds, {
            preventRemoteRequest: true,
            skipCache: true,
            waitForDelivery: false,
        });
        for (const chunk of localChunks) {
            if (!chunk) continue;
            this.chunkManager.emitEvent(EVENT_CHUNK_FETCHED, chunk);
            this.settleClaim(chunk._id, claims.get(chunk._id));
        }
    }

    private logFetchedChunks(
        requestedIds: readonly DocumentID[],
        { chunks, invalidChunks }: FetchedChunkClassification
    ): void {
        if (invalidChunks.length > 0) {
            Logger(
                `Some fetched chunks are invalid and will be ignored: (${invalidChunks.length} / ${chunks.length + invalidChunks.length}).`,
                LOG_LEVEL_VERBOSE
            );
            for (const chunk of invalidChunks) {
                Logger(`Invalid chunk: ${JSON.stringify(chunk)}`, LOG_LEVEL_VERBOSE);
            }
        }
        if (chunks.length === 0) {
            Logger(`No valid chunks were found for the following IDs: ${requestedIds.join(", ")}`);
        }
    }

    private applyMissingChunkResults(
        missingIds: readonly DocumentID[],
        requestClaims: ReadonlyMap<DocumentID, PendingChunkFetch>,
        requestCompletionVersion: number
    ): void {
        for (const chunkID of this.getActiveClaimIds(missingIds, requestClaims)) {
            const pending = requestClaims.get(chunkID)!;
            const completedDuringRequest = requestCompletionVersion !== this.finiteCompletionVersion;
            const action = decideMissingChunkAction({
                missingResponses: pending.missingResponses,
                finiteReplicationActive: this.chunkManager.deliveryCoordinator.isFiniteReplicationActive(),
                completedDuringRequest,
            });
            if (action.kind === "missing") {
                this.chunkManager.emitEvent(EVENT_MISSING_CHUNK_REMOTE, chunkID);
                this.settleClaim(chunkID, pending);
            } else {
                pending.missingResponses = action.missingResponses;
                pending.inFlight = false;
                pending.nextRequestAt = Date.now() + action.delayMs;
                this.queue.push(chunkID);
                Logger(
                    `Remote chunk is not available yet; retrying ${chunkID} in ${action.delayMs} ms.`,
                    LOG_LEVEL_VERBOSE
                );
            }
        }
        this.updatePendingCount();
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
        return this.currentProcessing < this.concurrency && this.queue.some((id) => this.isReady(id));
    }

    private isReady(id: DocumentID): boolean {
        const pending = this.pendingClaims.get(id);
        return !pending || (!pending.inFlight && pending.nextRequestAt <= Date.now());
    }

    async requestMissingChunks(): Promise<void> {
        if (this.destroyed || !this.canRequestMore()) {
            // The timer's earliest identifier may have expired while later retries remain queued.
            this.scheduleRequest();
            return;
        }
        let requestIDs: DocumentID[] = [];
        const requestClaims = new Map<DocumentID, PendingChunkFetch>();
        try {
            this.currentProcessing++;
            requestIDs = unique(this.queue.filter((id) => this.isReady(id))).slice(0, BATCH_SIZE);
            const selectedIds = new Set(requestIDs);
            this.queue = this.queue.filter((id) => !selectedIds.has(id));
            this.ensureClaims(requestIDs);
            for (const id of requestIDs) {
                const pending = this.pendingClaims.get(id);
                if (pending) {
                    pending.inFlight = true;
                    requestClaims.set(id, pending);
                }
            }
            this.scheduleRequest();
            requestIDs = await this.waitForActivityBoundary(requestClaims);
            if (requestIDs.length === 0) return;

            const localCheckCompletionVersion = this.finiteCompletionVersion;
            await this.resolveLocallyAvailableRetries(requestClaims);
            let pendingIDs = await this.waitBeforeRemoteRequest(requestIDs, requestClaims, localCheckCompletionVersion);
            if (pendingIDs.length === 0) return;

            const replicator = this.options.replicatorService.getActiveReplicator();
            if (!replicator) {
                Logger("No active replicator was found to request missing chunks.");
                return;
            }
            if (!canFetchRemoteChunks(replicator)) {
                Logger("The active replicator does not support fetching individual remote chunks.");
                for (const chunkID of pendingIDs) {
                    this.chunkManager.emitEvent(EVENT_MISSING_CHUNK_REMOTE, chunkID);
                }
                return;
            }
            // A lookup begun before the latest finite completion cannot be the final probe.
            const requestCompletionVersion = this.finiteCompletionVersion;
            const fetched = await replicator.fetchRemoteChunks(pendingIDs, false);
            pendingIDs = this.getActiveClaimIds(pendingIDs, requestClaims);
            this.touchClaims(pendingIDs, requestClaims);
            if (!fetched) {
                Logger(`No chunks were found for the following IDs: ${pendingIDs.join(", ")}`);
                for (const chunkID of pendingIDs) {
                    this.chunkManager.emitEvent(EVENT_MISSING_CHUNK_REMOTE, chunkID);
                }
                return;
            }
            const classification = classifyFetchedChunks(pendingIDs, fetched);
            this.logFetchedChunks(pendingIDs, classification);
            const { chunks, missingIds, invalidIds } = classification;
            try {
                if (chunks.length > 0) {
                    Logger(`Writing fetched chunks (${chunks.length}) to the database...`);
                    const result = await this.chunkManager.write(
                        chunks,
                        {
                            skipCache: true,
                            force: true, // Force writing to ensure the chunks with existing _rev.
                        },
                        "ChunkFetcher" as DocumentID
                    );
                    this.touchClaims(pendingIDs, requestClaims);
                    if (result.result === true) {
                        Logger(`Fetched chunks were stored successfully: ${chunks.length}`, LOG_LEVEL_VERBOSE);
                    } else {
                        Logger(
                            `Fetched chunks could not be stored: ${chunks.map((chunk) => chunk._id).join(", ")}`,
                            LOG_LEVEL_VERBOSE
                        );
                    }
                }
            } catch (error) {
                Logger(`An error occurred while storing fetched chunks!`, LOG_LEVEL_VERBOSE);
                Logger(error, LOG_LEVEL_VERBOSE);
            } finally {
                // Emitting fetched chunks regardless of write success preserves the existing refetch behaviour.
                for (const chunk of chunks) {
                    this.chunkManager.emitEvent(EVENT_CHUNK_FETCHED, chunk);
                    this.settleClaim(chunk._id, requestClaims.get(chunk._id));
                }
                for (const invalidID of this.getActiveClaimIds(invalidIds, requestClaims)) {
                    this.chunkManager.emitEvent(EVENT_MISSING_CHUNK_REMOTE, invalidID);
                    this.settleClaim(invalidID, requestClaims.get(invalidID));
                }
            }

            this.applyMissingChunkResults(missingIds, requestClaims, requestCompletionVersion);
        } catch (error) {
            Logger("An error occurred while fetching remote chunks.", LOG_LEVEL_VERBOSE);
            Logger(error, LOG_LEVEL_VERBOSE);
        } finally {
            for (const [id, pending] of requestClaims) {
                if (pending.inFlight) this.settleClaim(id, pending);
            }
            this.currentProcessing--;
            this.previousRequestTime = Date.now();
            this.scheduleRequest();
        }
    }
}
