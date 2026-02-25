import { shouldBeIgnored } from "@lib/string_and_binary/path.ts";
import {
    DEFAULT_SETTINGS,
    LOG_LEVEL_DEBUG,
    LOG_LEVEL_INFO,
    LOG_LEVEL_NOTICE,
    LOG_LEVEL_VERBOSE,
    type FileEventType,
    type FilePath,
    type UXFileInfoStub,
    type UXFolderInfo,
    type UXInternalFileInfoStub,
} from "@lib/common/types.ts";
import { delay, fireAndForget, throttle } from "@lib/common/utils.ts";
import { type FileEventItem } from "@lib/common/types.ts";
import { serialized, skipIfDuplicated } from "octagonal-wheels/concurrency/lock";
import { isWaitingForTimeout } from "octagonal-wheels/concurrency/task";
import { Semaphore } from "octagonal-wheels/concurrency/semaphore";
import type { IStorageAccessManager } from "@lib/interfaces/StorageAccess.ts";
import { promiseWithResolvers, type PromiseWithResolvers } from "octagonal-wheels/promises";
import { StorageEventManager, type FileEvent } from "@lib/interfaces/StorageEventManager.ts";
import type { IAPIService, IVaultService } from "@lib/services/base/IService.ts";
import type { SettingService } from "@lib/services/base/SettingService.ts";
import type { FileProcessingService } from "@lib/services/base/FileProcessingService.ts";
import { createInstanceLogFunction } from "@lib/services/lib/logUtils";

type WaitInfo = {
    since: number;
    type: FileEventType;
    canProceed: PromiseWithResolvers<boolean>;
    timerHandler: ReturnType<typeof setTimeout>;
    event: FileEventItem;
};
const TYPE_SENTINEL_FLUSH = "SENTINEL_FLUSH";
type FileEventItemSentinelFlush = {
    type: typeof TYPE_SENTINEL_FLUSH;
};
export type FileEventItemSentinel = FileEventItemSentinelFlush;
export interface StorageEventManagerBaseDependencies {
    setting: SettingService;
    vaultService: IVaultService;
    fileProcessing: FileProcessingService;
    storageAccessManager: IStorageAccessManager;
    APIService: IAPIService;
}
export abstract class StorageEventManagerBase extends StorageEventManager {
    _log: ReturnType<typeof createInstanceLogFunction>;
    protected setting: SettingService;
    protected vaultService: IVaultService;
    protected fileProcessing: FileProcessingService;
    protected storageAccess: IStorageAccessManager;

    protected get shouldBatchSave() {
        return this.settings?.batchSave && this.settings?.liveSync != true;
    }
    protected get batchSaveMinimumDelay(): number {
        return this.settings?.batchSaveMinimumDelay ?? DEFAULT_SETTINGS.batchSaveMinimumDelay;
    }
    protected get batchSaveMaximumDelay(): number {
        return this.settings?.batchSaveMaximumDelay ?? DEFAULT_SETTINGS.batchSaveMaximumDelay;
    }
    get settings() {
        return this.setting.currentSettings();
    }
    constructor(dependencies: StorageEventManagerBaseDependencies) {
        super();
        this.setting = dependencies.setting;
        this.vaultService = dependencies.vaultService;
        this.fileProcessing = dependencies.fileProcessing;
        this.storageAccess = dependencies.storageAccessManager;
        this._log = createInstanceLogFunction("StorageEventManager", dependencies.APIService);
    }

    abstract _saveSnapshot(snapshot: (FileEventItem | FileEventItemSentinel)[]): Promise<void>;
    abstract _loadSnapshot(): Promise<(FileEventItem | FileEventItemSentinel)[]>;

    // override if needed
    isFolder(file: UXFileInfoStub | UXInternalFileInfoStub | UXFolderInfo): boolean {
        return file.isFolder || false;
    }
    // override if needed,
    isFile(file: UXFileInfoStub | UXInternalFileInfoStub | UXFolderInfo): boolean {
        if (file.isFolder) {
            return false;
        }
        return true;
    }

    protected abstract updateStatus(): void;

    /**
     * Snapshot restoration promise.
     * Snapshot will be restored before starting to watch vault changes.
     * In designed time, this has been called from Initialisation process, which has been implemented on `ModuleInitializerFile.ts`.
     */
    snapShotRestored: Promise<void> | null = null;

    /**
     * Restore the previous snapshot if exists.
     * @returns
     */
    restoreState(): Promise<void> {
        this.snapShotRestored = this._restoreFromSnapshot();
        return this.snapShotRestored;
    }
    async appendQueue(params: FileEvent[], ctx?: any) {
        const settings = this.settings;
        if (!settings.isConfigured) return;
        if (settings.suspendFileWatching) return;
        if (settings.maxMTimeForReflectEvents > 0) {
            return;
        }
        this.fileProcessing.onStorageFileEvent();
        // Flag up to be reload
        for (const param of params) {
            if (shouldBeIgnored(param.file.path)) {
                continue;
            }
            const atomicKey = [0, 0, 0, 0, 0, 0].map((e) => `${Math.floor(Math.random() * 100000)}`).join("-");
            const type = param.type;
            const file = param.file;
            const oldPath = param.oldPath;
            if (type !== "INTERNAL") {
                const size = (file as UXFileInfoStub).stat.size;
                if (this.vaultService.isFileSizeTooLarge(size) && (type == "CREATE" || type == "CHANGED")) {
                    this._log(
                        `The storage file has been changed but exceeds the maximum size. Skipping: ${param.file.path}`,
                        LOG_LEVEL_NOTICE
                    );
                    continue;
                }
            }
            if (this.isFolder(file)) {
                this._log(`Folder event skipped: ${file.path}`, LOG_LEVEL_VERBOSE);
                continue;
            }
            if (!(await this.vaultService.isTargetFile(file.path))) continue;

            // Stop cache using to prevent the corruption;
            // let cache: null | string | ArrayBuffer;
            // new file or something changed, cache the changes.
            // if (file instanceof TFile && (type == "CREATE" || type == "CHANGED")) {
            // if (file instanceof TFile || !file.isFolder) {
            if (this.isFile(file)) {
                if (type == "CREATE" || type == "CHANGED") {
                    // Wait for a bit while to let the writer has marked `touched` at the file.
                    await delay(10);
                    if (
                        this.storageAccess.recentlyTouched({
                            path: file.path as FilePath,
                            stat: file.stat ?? { ctime: 0, mtime: 0, size: 0 },
                        })
                    ) {
                        continue;
                    }
                }
            }

            let cache: string | undefined = undefined;
            if (param.cachedData) {
                cache = param.cachedData;
            }
            void this.enqueue({
                type,
                args: {
                    file: file,
                    oldPath,
                    cache,
                    ctx,
                },
                skipBatchWait: param.skipBatchWait,
                key: atomicKey,
            });
        }
    }
    // Cache file and waiting to can be proceed.

    protected bufferedQueuedItems = [] as (FileEventItem | FileEventItemSentinel)[];

    enqueue(newItem: FileEventItem) {
        if (newItem.type == "DELETE") {
            // If the sentinel pushed, the runQueuedEvents will wait for idle before processing delete.
            this.bufferedQueuedItems.push({
                type: TYPE_SENTINEL_FLUSH,
            });
        }
        this.updateStatus();
        this.bufferedQueuedItems.push(newItem);

        fireAndForget(() => this._takeSnapshot().then(() => this.runQueuedEvents()));
    }

    /**
     * Immediately take snapshot.
     */
    private _triggerTakeSnapshot() {
        void this._takeSnapshot();
    }
    /**
     * Trigger taking snapshot after throttled period.
     */
    triggerTakeSnapshot = throttle(() => this._triggerTakeSnapshot(), 100);

    // Limit concurrent processing to reduce the IO load. file-processing + scheduler (1), so file events can be processed in 4 slots.
    protected concurrentProcessing = Semaphore(5);

    protected _waitingMap = new Map<string, WaitInfo>();
    private _waitForIdle: Promise<void> | null = null;

    /**
     * Wait until all queued events are processed.
     * Subsequent new events will not be waited, but new events will not be added.
     * @returns
     */
    waitForIdle(): Promise<void> {
        if (this._waitingMap.size === 0) {
            return Promise.resolve();
        }
        if (this._waitForIdle) {
            return this._waitForIdle;
        }
        const promises = [...this._waitingMap.entries()].map(([key, waitInfo]) => {
            return new Promise<void>((resolve) => {
                waitInfo.canProceed.promise
                    .then(() => {
                        this._log(`Processing ${key}: Wait for idle completed`, LOG_LEVEL_DEBUG);
                        // No op
                    })
                    .catch((e) => {
                        this._log(`Processing ${key}: Wait for idle error`, LOG_LEVEL_INFO);
                        this._log(e, LOG_LEVEL_VERBOSE);
                        //no op
                    })
                    .finally(() => {
                        resolve();
                    });
                this._proceedWaiting(key);
            });
        });
        const waitPromise = Promise.all(promises).then(() => {
            this._waitForIdle = null;
            this._log(`All wait for idle completed`, LOG_LEVEL_VERBOSE);
        });
        this._waitForIdle = waitPromise;
        return waitPromise;
    }

    /**
     * Proceed waiting for the given key immediately.
     */
    private _proceedWaiting(key: string) {
        const waitInfo = this._waitingMap.get(key);
        if (waitInfo) {
            waitInfo.canProceed.resolve(true);
            clearTimeout(waitInfo.timerHandler);
            this._waitingMap.delete(key);
        }
        this.triggerTakeSnapshot();
    }
    /**
     * Cancel waiting for the given key.
     */
    private _cancelWaiting(key: string) {
        const waitInfo = this._waitingMap.get(key);
        if (waitInfo) {
            waitInfo.canProceed.resolve(false);
            clearTimeout(waitInfo.timerHandler);
            this._waitingMap.delete(key);
        }
        this.triggerTakeSnapshot();
    }
    /**
     * Add waiting for the given key.
     * @param key
     * @param event
     * @param waitedSince Optional waited since timestamp to calculate the remaining delay.
     */
    private _addWaiting(key: string, event: FileEventItem, waitedSince?: number): WaitInfo {
        if (this._waitingMap.has(key)) {
            // Already waiting
            throw new Error(`Already waiting for key: ${key}`);
        }
        const resolver = promiseWithResolvers<boolean>();
        const now = Date.now();
        const since = waitedSince ?? now;
        const elapsed = now - since;
        const maxDelay = this.batchSaveMaximumDelay * 1000;
        const remainingDelay = Math.max(0, maxDelay - elapsed);
        const nextDelay = Math.min(remainingDelay, this.batchSaveMinimumDelay * 1000);
        // x*<------- maxDelay --------->*
        // x*<-- minDelay -->*
        // x*       x<-- nextDelay -->*
        // x*              x<-- Capped-->*
        // x*                    x.......*
        // x: event
        // *: save
        // When at event (x) At least, save (*) within maxDelay, but maintain minimum delay between saves.

        if (elapsed >= maxDelay) {
            // Already exceeded maximum delay, do not wait.
            this._log(`Processing ${key}: Batch save maximum delay already exceeded: ${event.type}`, LOG_LEVEL_DEBUG);
        } else {
            this._log(
                `Processing ${key}: Adding waiting for batch save: ${event.type} (${nextDelay}ms)`,
                LOG_LEVEL_DEBUG
            );
        }
        const waitInfo: WaitInfo = {
            since: since,
            type: event.type,
            event: event,
            canProceed: resolver,
            timerHandler: setTimeout(() => {
                this._log(`Processing ${key}: Batch save timeout reached: ${event.type}`, LOG_LEVEL_DEBUG);
                this._proceedWaiting(key);
            }, nextDelay),
        };
        this._waitingMap.set(key, waitInfo);
        this.triggerTakeSnapshot();
        return waitInfo;
    }

    /**
     * Process the given file event.
     */
    async processFileEvent(fei: FileEventItem) {
        const releaser = await this.concurrentProcessing.acquire();
        try {
            this.updateStatus();
            const filename = fei.args.file.path;
            const waitingKey = `${filename}`;
            const previous = this._waitingMap.get(waitingKey);
            let isShouldBeCancelled = fei.skipBatchWait || false;
            let previousPromise: Promise<boolean> = Promise.resolve(true);
            let waitPromise: Promise<boolean> = Promise.resolve(true);
            // 1. Check if there is previous waiting for the same file
            if (previous) {
                previousPromise = previous.canProceed.promise;
                if (isShouldBeCancelled) {
                    this._log(
                        `Processing ${filename}: Requested to perform immediately, cancelling previous waiting: ${fei.type}`,
                        LOG_LEVEL_DEBUG
                    );
                }
                if (!isShouldBeCancelled && fei.type === "DELETE") {
                    // For DELETE, cancel any previous waiting and proceed immediately
                    // That because when deleting, we cannot read the file anymore.
                    this._log(
                        `Processing ${filename}: DELETE requested, cancelling previous waiting: ${fei.type}`,
                        LOG_LEVEL_DEBUG
                    );
                    isShouldBeCancelled = true;
                }
                if (!isShouldBeCancelled && previous.type === fei.type) {
                    // For the same type, we can cancel the previous waiting and proceed immediately.
                    this._log(`Processing ${filename}: Cancelling previous waiting: ${fei.type}`, LOG_LEVEL_DEBUG);
                    isShouldBeCancelled = true;
                }
                // 2. wait for the previous to complete
                if (isShouldBeCancelled) {
                    this._cancelWaiting(waitingKey);
                    this._log(`Processing ${filename}: Previous cancelled: ${fei.type}`, LOG_LEVEL_DEBUG);
                    isShouldBeCancelled = true;
                }
                if (!isShouldBeCancelled) {
                    this._log(`Processing ${filename}: Waiting for previous to complete: ${fei.type}`, LOG_LEVEL_DEBUG);
                    this._proceedWaiting(waitingKey);
                    this._log(`Processing ${filename}: Previous completed: ${fei.type}`, LOG_LEVEL_DEBUG);
                }
            }
            await previousPromise;
            // 3. Check if shouldBatchSave is true
            if (this.shouldBatchSave && !fei.skipBatchWait) {
                // if type is CREATE or CHANGED, set waiting
                if (fei.type == "CREATE" || fei.type == "CHANGED") {
                    // 3.2. If true, set the queue, and wait for the waiting, or until timeout
                    // (since is copied from previous waiting if exists to limit the maximum wait time)
                    // console.warn(`Since:`, previous?.since);
                    const info = this._addWaiting(waitingKey, fei, previous?.since);
                    waitPromise = info.canProceed.promise;
                } else if (fei.type == "DELETE") {
                    // For DELETE, cancel any previous waiting and proceed immediately
                }
                this._log(`Processing ${filename}: Waiting for batch save: ${fei.type}`, LOG_LEVEL_DEBUG);
                const canProceed = await waitPromise;
                if (!canProceed) {
                    // 3.2.1. If cancelled by new queue, cancel subsequent process.
                    this._log(`Processing ${filename}: Cancelled by new queue: ${fei.type}`, LOG_LEVEL_DEBUG);
                    return;
                }
            }
            // await this.handleFileEvent(fei);
            await this.requestProcessQueue(fei);
        } finally {
            await this._takeSnapshot();
            releaser();
        }
    }

    async _takeSnapshot() {
        const processingEvents = [...this._waitingMap.values()].map((e) => e.event);
        const waitingEvents = this.bufferedQueuedItems;
        const snapShot = [...processingEvents, ...waitingEvents];
        await this._saveSnapshot(snapShot);
        this.updateStatus();
    }

    async _restoreFromSnapshot() {
        const snapShot = await this._loadSnapshot();
        if (snapShot && Array.isArray(snapShot) && snapShot.length > 0) {
            // console.warn(`Restoring snapshot: ${snapShot.length} items`);
            this._log(`Restoring storage operation snapshot: ${snapShot.length} items`, LOG_LEVEL_VERBOSE);
            // Restore the snapshot
            // Note: Mark all items as skipBatchWait to prevent apply the off-line batch saving.
            this.bufferedQueuedItems = snapShot.map((e) => ({ ...e, skipBatchWait: true }));
            this.updateStatus();
            await this.runQueuedEvents();
        } else {
            this._log(`No snapshot to restore`, LOG_LEVEL_VERBOSE);
            // console.warn(`No snapshot to restore`);
        }
    }

    protected runQueuedEvents() {
        return skipIfDuplicated("storage-event-manager-run-queued-events", async () => {
            do {
                if (this.bufferedQueuedItems.length === 0) {
                    break;
                }
                // 1. Get the first queued item

                const fei = this.bufferedQueuedItems.shift()!;
                await this._takeSnapshot();
                this.updateStatus();
                // 2. Consume 1 semaphore slot to enqueue processing. Then release immediately.
                // (Just to limit the total concurrent processing count, because skipping batch handles at processFileEvent).
                const releaser = await this.concurrentProcessing.acquire();
                releaser();
                this.updateStatus();
                // 3. Check if sentinel flush
                //    If sentinel, wait for idle and continue.
                if (fei.type === TYPE_SENTINEL_FLUSH) {
                    this._log(`Waiting for idle`, LOG_LEVEL_VERBOSE);
                    // Flush all waiting batch queues
                    await this.waitForIdle();
                    this.updateStatus();
                    continue;
                }
                // 4. Process the event, this should be fire-and-forget to not block the queue processing in each file.
                fireAndForget(() => this.processFileEvent(fei));
            } while (this.bufferedQueuedItems.length > 0);
        });
    }

    protected processingCount = 0;
    protected async requestProcessQueue(fei: FileEventItem) {
        try {
            this.processingCount++;
            // this.bufferedQueuedItems.remove(fei);
            this.updateStatus();
            // this.waitedSince.delete(fei.args.file.path);
            await this.handleFileEvent(fei);
            await this._takeSnapshot();
        } finally {
            this.processingCount--;
            this.updateStatus();
        }
    }
    isWaiting(filename: FilePath) {
        return isWaitingForTimeout(`storage-event-manager-batchsave-${filename}`);
    }

    protected async handleFileEvent(queue: FileEventItem): Promise<any> {
        const file = queue.args.file;
        const lockKey = `handleFile:${file.path}`;
        const ret = await serialized(lockKey, async () => {
            if (queue.cancelled) {
                this._log(`File event cancelled before processing: ${file.path}`, LOG_LEVEL_INFO);
                return;
            }
            if (queue.type == "INTERNAL" || file.isInternal) {
                await this.fileProcessing.processOptionalFileEvent(file.path as unknown as FilePath);
            } else {
                // const key = `file-last-proc-${queue.type}-${file.path}`;
                // const last = Number((await this.core.kvDB.get(key)) || 0);
                const last = 0; // TODO: When did I remove this? Check later.
                if (queue.type == "DELETE") {
                    await this.fileProcessing.processFileEvent(queue);
                } else {
                    if (file.stat.mtime == last) {
                        this._log(
                            `File has been already scanned on ${queue.type}, skip: ${file.path}`,
                            LOG_LEVEL_VERBOSE
                        );
                        // Should Cancel the relative operations? (e.g. rename)
                        // this.cancelRelativeEvent(queue);
                        return;
                    }
                    if (!(await this.fileProcessing.processFileEvent(queue))) {
                        this._log(
                            `STORAGE -> DB: Handler failed, cancel the relative operations: ${file.path}`,
                            LOG_LEVEL_INFO
                        );
                        // cancel running queues and remove one of atomic operation (e.g. rename)
                        this.cancelRelativeEvent(queue);
                        return;
                    }
                }
            }
        });
        this.updateStatus();
        return ret;
    }

    protected cancelRelativeEvent(item: FileEventItem): void {
        this._cancelWaiting(item.args.file.path);
    }

    abstract override beginWatch(): Promise<void>;
}
