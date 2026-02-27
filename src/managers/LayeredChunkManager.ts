import { LOG_LEVEL_VERBOSE, Logger } from "@lib/common/logger.ts";
import { promiseWithResolvers } from "octagonal-wheels/promises";
import type { DocumentID, EntryDoc, EntryLeaf } from "@lib/common/types.ts";
import type { ChangeManager } from "@lib/managers/ChangeManager.ts";
import { EVENT_MISSING_CHUNK_REMOTE, EVENT_MISSING_CHUNKS, EVENT_CHUNK_FETCHED } from "@lib/managers/ChunkFetcher.ts";
import { DatabaseReadLayer } from "./LayeredChunkManager/DatabaseReadLayer.ts";
import { CacheLayer } from "./LayeredChunkManager/CacheLayer.ts";
import { ArrivalWaitLayer } from "./LayeredChunkManager/ArrivalWaitLayer.ts";
import { DatabaseWriteLayer } from "./LayeredChunkManager/DatabaseWriteLayer.ts";
import type { IReadLayer, IWriteLayer } from "./LayeredChunkManager/ChunkLayerInterfaces.ts";
import type {
    ChunkManagerEventMap,
    ChunkManagerOptions,
    ChunkReadOptions,
    ChunkWriteOptions,
    WriteResult,
} from "./LayeredChunkManager/types.ts";
import { unique } from "octagonal-wheels/collection";

/**
 * ChunkManager class that manages chunk operations such as reading, writing, and caching.
 * Now uses a middleware layer architecture for read and write operations.
 */
export class LayeredChunkManager {
    protected options: ChunkManagerOptions;
    protected eventTarget: EventTarget = new EventTarget();

    // Middleware layers
    private cacheLayer: CacheLayer;
    private readLayers: IReadLayer[];
    private writeLayers: IWriteLayer[];
    private arrivalWaitLayer: ArrivalWaitLayer;

    get changeManager(): ChangeManager<EntryDoc> {
        return this.options.changeManager;
    }
    get database(): PouchDB.Database<EntryDoc> {
        return this.options.database;
    }

    // Expose cache statistics
    get cacheStatistics() {
        return this.cacheLayer.getStatistics();
    }

    addListener<K extends keyof ChunkManagerEventMap>(
        type: K,
        listener: (this: LayeredChunkManager, ev: ChunkManagerEventMap[K]) => any,
        options?: boolean | AddEventListenerOptions
    ): () => void {
        const callback = (ev: CustomEvent<ChunkManagerEventMap[K]>) => {
            listener.call(this, ev.detail);
        };
        this.eventTarget.addEventListener(type, callback as EventListener, options);
        return () => {
            this.eventTarget.removeEventListener(type, callback as EventListener, options);
        };
    }
    emitEvent<K extends keyof ChunkManagerEventMap>(type: K, detail: ChunkManagerEventMap[K]): void {
        const event = new CustomEvent(type, { detail });
        this.eventTarget.dispatchEvent(event);
    }

    protected abort: AbortController = new AbortController();

    // Change listener cleanup
    protected offChangeHandler: ReturnType<typeof this.changeManager.addCallback>;

    // initialisation promise to ensure the manager is ready before processing transactions
    protected initialised = Promise.resolve();

    async _initialise() {
        Logger("ChunkManager initialised", LOG_LEVEL_VERBOSE);
        // TODO: Add chunkpack
        return await Promise.resolve();
    }

    constructor(options: ChunkManagerOptions) {
        this.options = options;
        const settings = options.settingService.currentSettings();
        const maxCacheSize = settings.hashCacheMaxCount * 10;

        // Initialize cache layer
        this.cacheLayer = new CacheLayer(maxCacheSize);

        // Initialise arrival wait layer
        this.arrivalWaitLayer = new ArrivalWaitLayer((eventName: string, data: DocumentID[]) => {
            if (eventName === "missingChunks") {
                this.emitEvent(EVENT_MISSING_CHUNKS, data);
            }
        });

        // Build read layers pipeline: Cache → Database → ArrivalWait
        // Cache layer implements IReadLayer interface
        this.readLayers = [this.cacheLayer, new DatabaseReadLayer(this.database), this.arrivalWaitLayer];

        // Build write layers pipeline: HotPack → Database → Cache
        // Cache layer implements IWriteLayer interface at the end
        this.writeLayers = [
            // new HotPackLayer(),
            new DatabaseWriteLayer(this.database),
            this.cacheLayer,
        ];

        // Set up change listener
        this.offChangeHandler = this.changeManager.addCallback(this.onChangeHandler);
        this.addListener(EVENT_CHUNK_FETCHED, this.onChunkArrivedHandler, { signal: this.abort.signal });
        this.addListener(EVENT_MISSING_CHUNK_REMOTE, this.onMissingChunkRemoteHandler, { signal: this.abort.signal });

        this.initialised = this._initialise();
    }

    destroy(): void {
        const layers = unique([...this.readLayers, ...this.writeLayers]);
        this.abort.abort();
        this.offChangeHandler();
        for (const layer of layers) {
            if (layer.tearDown) {
                layer.tearDown();
            }
        }
    }

    // Cache management methods (delegated to cacheLayer)
    getCachedChunk(id: DocumentID): EntryLeaf | false {
        return this.cacheLayer.getCachedChunk(id);
    }

    getChunkIDFromCache(data: string): DocumentID | false {
        return this.cacheLayer.getChunkIDFromCache(data);
    }

    cacheChunk(chunk: EntryLeaf): void {
        this.cacheLayer.cacheChunk(chunk);
    }

    // reorderChunk(id: DocumentID): void {
    //     this.cacheLayer.reorderChunk(id);
    // }

    // deleteCachedChunk(id: DocumentID): void {
    //     this.cacheLayer.deleteCachedChunk(id);
    // }

    clearCaches(): void {
        this.cacheLayer.clearCaches();
    }

    // Read pipeline execution
    async read(
        ids: DocumentID[],
        options: ChunkReadOptions,
        preloadedChunks?: Record<DocumentID, EntryLeaf>
    ): Promise<(EntryLeaf | false)[]> {
        const order = [...ids];
        const resultMap = new Map<DocumentID, EntryLeaf | false>(ids.map((id) => [id, false]));
        const readIds = new Set([...resultMap.keys()]);

        // Handle preloaded chunks
        if (preloadedChunks) {
            for (const [id, chunk] of Object.entries(preloadedChunks) as [DocumentID, EntryLeaf][]) {
                if (this.isChunkDoc(chunk)) {
                    this.cacheLayer.cacheChunk(chunk);
                    resultMap.set(id, chunk);
                    readIds.delete(id);
                }
            }
        }

        // Execute read pipeline
        const results = await this.executeReadPipeline([...readIds], options);

        // Merge results
        for (let i = 0; i < results.length; i++) {
            if (results[i]) {
                const chunk = results[i] as EntryLeaf;
                resultMap.set(chunk._id, chunk);
            }
        }

        // Return in original order
        return order.map((id) => resultMap.get(id) || false);
    }

    private executeReadPipeline(ids: DocumentID[], options: ChunkReadOptions): Promise<(EntryLeaf | false)[]> {
        let layerIndex = 0;
        const layers = this.readLayers;

        const executeNextLayer = (remaining: DocumentID[]): Promise<(EntryLeaf | false)[]> => {
            if (layerIndex >= layers.length) {
                return Promise.resolve(remaining.map(() => false));
            }

            const layer = layers[layerIndex];
            layerIndex++;
            return layer.read(remaining, options, executeNextLayer);
        };

        return executeNextLayer(ids);
    }

    // Write pipeline execution
    async write(chunks: EntryLeaf[], options: ChunkWriteOptions, origin: DocumentID): Promise<WriteResult> {
        const result = await this.executeWritePipeline(chunks, options, origin);
        return result;
    }

    private executeWritePipeline(
        chunks: EntryLeaf[],
        options: ChunkWriteOptions,
        origin: DocumentID
    ): Promise<WriteResult> {
        let layerIndex = 0;
        const layers = this.writeLayers;

        const executeNextLayer = (remaining: EntryLeaf[]): Promise<WriteResult> => {
            if (layerIndex >= layers.length) {
                return Promise.resolve({
                    result: true,
                    processed: {
                        cached: 0,
                        hotPack: 0,
                        written: 0,
                        duplicated: 0,
                    },
                });
            }

            const layer = layers[layerIndex];
            layerIndex++;
            return layer.write(remaining, options, origin, executeNextLayer);
        };

        return executeNextLayer(chunks);
    }

    // Helper methods
    private isChunkDoc(doc: any): doc is EntryLeaf {
        return doc && typeof doc._id === "string" && doc.type === "leaf";
    }

    // Event handlers
    private onChunkArrived(doc: EntryLeaf, deleted: boolean = false): void {
        this.arrivalWaitLayer.onChunkArrived(doc, deleted);
    }
    protected onChunkArrivedHandler = this.onChunkArrived.bind(this);

    private onChange(change: PouchDB.Core.ChangesResponseChange<EntryLeaf>): void {
        const doc = change.doc;
        if (!doc || !doc._id) {
            return;
        }

        if (doc.type !== "leaf") {
            return;
        }
        this.onChunkArrived(doc, change.deleted);
    }
    protected onChangeHandler = this.onChange.bind(this);

    onMissingChunkRemote(id: DocumentID): void {
        this.arrivalWaitLayer.onMissingChunk(id);
    }
    protected onMissingChunkRemoteHandler = this.onMissingChunkRemote.bind(this);

    // Transaction management
    protected concurrentTransactions = 0;
    protected stabilised = Promise.resolve();

    async transaction<T>(callback: () => Promise<T>): Promise<T> {
        await this.initialised;
        await this.stabilised;
        this.concurrentTransactions++;
        try {
            const result = await callback();
            return result;
        } finally {
            this.concurrentTransactions--;
            if (this.concurrentTransactions === 0) {
                Logger(`All transactions completed. Performing stabilisation.`, LOG_LEVEL_VERBOSE);
                await this._stabilise();
            } else {
                Logger(`Transaction completed. Remaining: ${this.concurrentTransactions}`, LOG_LEVEL_VERBOSE);
            }
        }
    }

    async _stabilise() {
        const pr = promiseWithResolvers<void>();
        this.stabilised = pr.promise;
        try {
            await this.__stabilise();
        } finally {
            pr.resolve();
        }
    }

    __stabilise() {
        // Called when idle; can be used to process hot pack or other tasks
        // TODO: Implement hot pack processing
        return Promise.resolve();
    }
}
