/**
 * Compose host adapters with storage-event admission, batching, snapshotting, and processing.
 * The facade keeps host services and protected extension hooks at the runtime boundary.
 */
import {
    DEFAULT_SETTINGS,
    LOG_LEVEL_NOTICE,
    LOG_LEVEL_VERBOSE,
    type FileEventItem,
    type FilePath,
    type UXFileInfoStub,
    type UXFolderInfo,
    type UXInternalFileInfoStub,
} from "@lib/common/types";
import { fireAndForget, isRemediationModeActive } from "@lib/common/utils";
import { createCoalescingNotifier } from "octagonal-wheels/concurrency/coalescingNotifier";
import { createNotifier } from "octagonal-wheels/concurrency/notifier";
import { Semaphore } from "octagonal-wheels/concurrency/semaphore";
import { promiseWithResolvers } from "octagonal-wheels/promises";
import type { IStorageAccessManager } from "@lib/interfaces/StorageAccess";
import { StorageEventManager, type FileEvent } from "@lib/interfaces/StorageEventManager";
import type { IAPIService, IVaultService } from "@lib/services/base/IService";
import type { SettingService } from "@lib/services/base/SettingService";
import type { FileProcessingService } from "@lib/services/base/FileProcessingService";
import { createInstanceLogFunction, type LogFunction } from "@lib/services/lib/logUtils";
import type { IStorageEventManagerAdapter } from "./adapters";
import {
    isIncrementalPersistenceAdapter,
    type IStorageEventIncrementalPersistenceAdapter,
    type StorageEventSnapshotDelta,
    type StorageEventSnapshotRecord,
} from "./adapters/IStorageEventPersistenceAdapter";
import type { FileEventAttempt, OperationResult, PendingFileEvent } from "./StorageEventManager/operations";
import { admitStorageEvents, type StorageEventAdmissionEffects } from "./StorageEventManager/admission";
import {
    forwardVaultEvent,
    hasEditorChangePath,
    readEditorChangePath,
    type StorageEventWatchEffects,
} from "./StorageEventManager/watching";
import {
    addBatchWaiting,
    disposeAllBatchGates,
    finishBatchWaiting,
    initialiseFileEventBatch,
    planBatchDeadline,
    releaseFileEventBatches,
    scheduleStorageTimeout,
    type BatchGateOutcome,
    type StorageEventBatching,
    type WaitInfo,
} from "./StorageEventManager/batching";
import {
    enqueueStorageEvent,
    flushStorageEvents,
    loadStorageEventStore,
    runBufferedStorageEvents,
    type StorageEventQueueEffects,
} from "./StorageEventManager/queue";
import {
    captureFileEventAttempts,
    waitForFileEventAttempts,
    type StorageEventRetryEffects,
} from "./StorageEventManager/retry";
import {
    invalidatePendingSnapshotBatch,
    persistFileEventSnapshot,
    type StorageEventSnapshotIO,
} from "./StorageEventManager/snapshot";
import {
    handleStorageFileEvent,
    processStorageEventAttempt,
    type StorageEventAttemptEffects,
    type StorageEventHandlerEffects,
} from "./StorageEventManager/processing";
import {
    assertStoreLoaded,
    beginStoppingState,
    createStorageEventState,
    failFileEventAttempt,
    hasPendingSnapshotWork,
    hasPendingStorageEvent,
    isAcceptingEvents,
    isManagerStopped,
    isManagerStopping,
    isStoreLoaded,
    markStoppedState,
    resetStorePersistenceState,
    retainFileEvent,
    stopUnstartedAttempts,
    type FileEventItemSentinel,
    type QueuedFileEvent,
    type RunQueuedEventsOptions,
    type SnapshotCompletion,
    type StorageEventBuffer,
    type StorageEventNotifications,
} from "./StorageEventManager/state";
export type { FileEventItemSentinel, QueuedFileEvent } from "./StorageEventManager/state";
export {
    isIncrementalPersistenceAdapter,
    type IStorageEventIncrementalPersistenceAdapter,
    type StorageEventSnapshotDelta,
    type StorageEventSnapshotRecord,
};

/**
 * Bundle host services used to construct the platform-neutral storage-event manager.
 * @remarks These dependencies keep vault access, file processing, settings, and diagnostics at the adapter boundary.
 */
export interface StorageEventManagerBaseDependencies {
    /** Apply the host's admission checks to optional-file events before queuing them. */
    isTargetInternalFile?: (path: FilePath) => Promise<boolean>;
    setting: SettingService;
    vaultService: IVaultService;
    fileProcessing: FileProcessingService;
    storageAccessManager: IStorageAccessManager;
    APIService: IAPIService;
}

/**
 * Extract the host file type from a candidate adapter type.
 * @typeParam T - The candidate adapter type.
 */
export type ExtractFile<T> = T extends IStorageEventManagerAdapter<infer F, infer _Folder> ? F : never;
/**
 * Extract the host folder type from a candidate adapter type.
 * @typeParam T - The candidate adapter type.
 */
export type ExtractFolder<T> = T extends IStorageEventManagerAdapter<infer _File, infer D> ? D : never;

/**
 * Compose a host adapter with the stateful storage-event pipeline.
 * @typeParam TAdapter - The platform adapter which defines host file and folder representations.
 * @remarks
 * Public methods implement admission, flushing, restoration, and watcher lifecycle contracts.
 * Protected getters, processing hooks, and watcher callbacks are extension points for host subclasses.
 */
export abstract class StorageEventManagerBase<
    TAdapter extends IStorageEventManagerAdapter<unknown, unknown>,
> extends StorageEventManager {
    _log: LogFunction;
    protected setting: SettingService;
    protected vaultService: IVaultService;
    protected fileProcessing: FileProcessingService;
    protected storageAccess: IStorageAccessManager;
    protected adapter: TAdapter;

    protected bufferedQueuedItems: QueuedFileEvent[] = [];
    protected concurrentProcessing = Semaphore(5);
    protected _waitingMap = new Map<string, WaitInfo>();
    protected processingCount = 0;
    private readonly eventState = createStorageEventState();
    protected dispatchWindowSize = 5;
    private readonly incrementalPersistence: IStorageEventIncrementalPersistenceAdapter | undefined;
    private dispatchPaused = false;
    private readonly dispatchResumeNotifier = createNotifier();
    private readonly stopSignal = promiseWithResolvers<void>();
    private stopWatchingPromise: Promise<void> | null = null;
    private activeRestore: Promise<void> | null = null;
    private replayNeedsRetry = false;
    private readonly snapshotSchedule = createCoalescingNotifier<void>({
        maxWaitMs: 100,
        onNotify: () => this._triggerTakeSnapshot(),
        scheduleTimeout: scheduleStorageTimeout,
    });
    private readonly activeDispatches = new Set<Promise<void>>();
    private readonly buffer: StorageEventBuffer = {
        read: () => this.bufferedQueuedItems,
        replace: (events) => {
            this.bufferedQueuedItems = events;
        },
        append: (event) => {
            this.bufferedQueuedItems.push(event);
        },
        shift: () => this.bufferedQueuedItems.shift(),
    };
    private readonly log: LogFunction = (...args) => this._log(...args);
    private readonly reportStatusFailure = (error: unknown) => {
        this.log("Could not update storage event status", LOG_LEVEL_NOTICE);
        this.log(error, LOG_LEVEL_VERBOSE);
    };
    private readonly notifications: StorageEventNotifications = {
        updateStatus: () => {
            try {
                this.updateStatus();
            } catch (error) {
                this.reportStatusFailure(error);
            }
        },
        reportFailure: (error) => this.reportOperationFailure(error),
    };
    private readonly batching: StorageEventBatching = {
        waiting: () => this._waitingMap,
        operation: (event) => this.operations.get(event),
        minimumDelay: () => this.batchSaveMinimumDelay,
        maximumDelay: () => this.batchSaveMaximumDelay,
        enabled: () => this.shouldBatchSave,
        log: this.log,
        requestSnapshot: () => this.triggerTakeSnapshot(),
        updateStatus: this.notifications.updateStatus,
        proceed: (path) => this._proceedWaiting(path),
        cancel: (path) => this._cancelWaiting(path),
        add: (path, event, since) => this._addWaiting(path, event, since),
    };
    private readonly retry: StorageEventRetryEffects = {
        buffer: this.buffer,
        processOperation: (operation, attempt) => this.processOperation(operation, attempt),
        runQueuedEvents: () => this.runQueuedEvents(),
        reportFailure: this.notifications.reportFailure,
    };
    private readonly snapshotIO: StorageEventSnapshotIO = {
        save: (events) => this._saveSnapshot(events),
        waitingEvents: () => [...this._waitingMap.values()].map((waiting) => waiting.event),
        updateStatus: () => this.updateStatus(),
        reportFailure: this.reportStatusFailure,
        applyDelta: undefined,
    };
    private readonly queue: StorageEventQueueEffects = {
        ...this.notifications,
        buffer: this.buffer,
        log: this.log,
        takeSnapshot: (version) => this._takeSnapshot(version),
        loadSnapshot: () => this._loadSnapshot(),
        loadSnapshotEntries: undefined,
        incrementalMode: false,
        dispatchQueuedEvent: (event, attempt) => this.dispatchQueuedEvent(event, attempt),
        isWaiting: (event) => this._waitingMap.get(event.args.file.path)?.event === event,
        runQueuedEvents: (options) => this.runQueuedEvents(options),
        capture: (operations, before) => this.captureAttempts(operations, before),
        release: (operations) => this.releaseOperations(operations),
        wait: (attempts) => this.waitForAttempts(attempts),
        fail: (operation, error, attempt) => this.failOperation(operation, error, attempt),
        isDispatchPaused: () => this.dispatchPaused,
        dispatchWindowSize: () => this.dispatchWindowSize,
        stopSignal: this.stopSignal.promise,
    };
    private readonly admission: StorageEventAdmissionEffects = {
        settings: () => this.settings,
        isFolder: (file) => this.isFolder(file),
        isFile: (file) => this.isFile(file),
        isTarget: (path) => this.vaultService.isTargetFile(path),
        isTooLarge: (size) => this.vaultService.isFileSizeTooLarge(size),
        recentlyTouched: (file) => this.storageAccess.recentlyTouched(file),
        onStorageFileEvent: () => this.fileProcessing.onStorageFileEvent(),
        enqueue: (event) => this.enqueue(event),
        release: this.queue.release,
        reportFailure: this.notifications.reportFailure,
        log: this.log,
    };
    private readonly attempts: StorageEventAttemptEffects = {
        ...this.notifications,
        capture: this.queue.capture,
        release: this.queue.release,
        wait: this.queue.wait,
        initialise: (operation) => this.initialiseOperation(operation),
        takeSnapshot: this.queue.takeSnapshot,
        completeSnapshot: (completion) => this.persistSnapshot(completion),
        semaphore: () => this.concurrentProcessing,
        requestProcessQueue: (event) => this.dispatchFileEvent(event),
        cancelWaiting: (event) => {
            const path = event.args.file.path;
            if (this._waitingMap.get(path)?.event === event) this._cancelWaiting(path);
        },
        fail: this.queue.fail,
        isStopping: () => this.isStopping(),
        isDispatchPaused: () => this.dispatchPaused,
        waitUntilDispatchResumed: () => this.waitUntilDispatchResumed(),
    };
    private readonly handler: StorageEventHandlerEffects = {
        processing: () => this.fileProcessing,
        operation: (event) => this.operations.get(event),
        updateStatus: this.notifications.updateStatus,
    };

    private waitUntilDispatchResumed(): Promise<void> {
        if (!this.dispatchPaused || this.isStopping()) return Promise.resolve();
        return this.dispatchResumeNotifier.wait();
    }

    /** Preserve adapter receivers and virtual admission when forwarding watcher notifications. */
    private readonly watching: StorageEventWatchEffects<unknown, unknown> = {
        adapter: () => this.adapter,
        isProcessing: (path) => this.storageAccess.isFileProcessing(path),
        append: (events, ctx) => this.appendQueue(events, ctx),
    };

    /**
     * Bind the platform adapter and host services to this manager instance.
     * @param adapter - The host adapter for file conversion, persistence, status, and watching.
     * @param dependencies - Settings, vault, processing, storage-access, and API services used by the facade.
     */
    constructor(adapter: TAdapter, dependencies: StorageEventManagerBaseDependencies) {
        super();
        this.adapter = adapter;
        this.incrementalPersistence = isIncrementalPersistenceAdapter(adapter.persistence)
            ? adapter.persistence
            : undefined;
        this.queue.incrementalMode = !!this.incrementalPersistence;
        if (this.incrementalPersistence) {
            const incremental = this.incrementalPersistence;
            this.queue.loadSnapshotEntries = () => incremental.loadSnapshotEntries();
            this.snapshotIO.applyDelta = (delta) => incremental.applySnapshotDelta(delta);
        }
        this.eventState.dispatch.windowSize = this.dispatchWindowSize;
        this.setting = dependencies.setting;
        this.vaultService = dependencies.vaultService;
        this.admission.isTargetInternal = dependencies.isTargetInternalFile?.bind(dependencies);
        this.fileProcessing = dependencies.fileProcessing;
        this.storageAccess = dependencies.storageAccessManager;
        this._log = createInstanceLogFunction("StorageEventManager", dependencies.APIService);
    }

    /** Read the setting service's current settings. */
    get settings() {
        return this.setting.currentSettings();
    }
    /** Resolve whether batching is enabled from the settings active at this access. */
    protected get shouldBatchSave() {
        const settings = this.settings;
        return settings?.liveSync === true ? settings.batchSaveInLiveSync === true : settings?.batchSave;
    }
    /** Resolve the minimum batch delay from the current settings. */
    protected get batchSaveMinimumDelay(): number {
        return this.settings?.batchSaveMinimumDelay ?? DEFAULT_SETTINGS.batchSaveMinimumDelay;
    }
    /** Resolve the maximum batch delay from the current settings. */
    protected get batchSaveMaximumDelay(): number {
        return this.settings?.batchSaveMaximumDelay ?? DEFAULT_SETTINGS.batchSaveMaximumDelay;
    }
    private get operations() {
        return this.eventState.operations;
    }

    /** Save the supplied queued-event snapshot through the host adapter. */
    _saveSnapshot(snapshot: (FileEventItem | FileEventItemSentinel)[]): Promise<void> {
        return this.adapter.persistence.saveSnapshot(snapshot);
    }
    /** Load the queued-event snapshot through the host adapter. */
    _loadSnapshot(): Promise<(FileEventItem | FileEventItemSentinel)[] | null> {
        return this.adapter.persistence.loadSnapshot();
    }
    /** Ask the host adapter to classify a supplied file or folder value. */
    isFolder(
        file: UXFileInfoStub | UXInternalFileInfoStub | UXFolderInfo | ExtractFolder<TAdapter> | ExtractFile<TAdapter>
    ): boolean {
        return this.adapter.typeGuard.isFolder(file);
    }
    /** Ask the host adapter to classify a supplied file or folder value. */
    isFile(
        file: UXFileInfoStub | UXInternalFileInfoStub | UXFolderInfo | ExtractFolder<TAdapter> | ExtractFile<TAdapter>
    ): boolean {
        return this.adapter.typeGuard.isFile(file);
    }
    /** Publish the current batch, processing, and unfinished-operation counts through the adapter. */
    protected updateStatus(): void {
        this.adapter.status.updateStatus({
            batched: this._waitingMap.size,
            processing: this.processingCount,
            totalQueued: this.eventState.pendingOperationCount,
        });
    }

    /** Completes restored operations before the host starts watching. */
    snapShotRestored: Promise<void> | null = null;

    /**
     * Load the active store generation once before any durable write commits.
     * Publishes `storeLoadPromise` synchronously before invoking the adapter so re-entrant hooks share it.
     */
    private ensureStoreLoaded(allowRetry = false): Promise<void> {
        const persistence = this.eventState.persistence;
        if (persistence.storeLoaded) return Promise.resolve();
        if (persistence.storeLoadPromise) return persistence.storeLoadPromise;
        if (persistence.storeLoadError) {
            if (!allowRetry) return Promise.reject(persistence.storeLoadError.error);
            persistence.storeLoadError = undefined;
        }
        const generation = persistence.storeGeneration;
        const completion = promiseWithResolvers<void>();
        const load = completion.promise;
        persistence.storeLoadPromise = load;
        void loadStorageEventStore(this.queue, this.eventState, generation).then(
            () => {
                if (persistence.storeLoadPromise === load) persistence.storeLoadPromise = null;
                completion.resolve();
            },
            (error) => {
                if (persistence.storeGeneration === generation) {
                    if (persistence.storeLoadPromise === load) persistence.storeLoadPromise = null;
                    persistence.storeLoadError = { error };
                }
                if (this.isStopping()) completion.resolve();
                else completion.reject(error);
            }
        );
        return load;
    }

    /**
     * Start snapshot restoration and retain the promise used by watcher startup.
     * @returns A promise fulfilled after restoration and replay attempts settle; snapshot or dispatch errors reject it, while failed operation results are reported and retained.
     */
    restoreState(): Promise<void> {
        if (this.isStopping()) return Promise.resolve();
        if (this.activeRestore) {
            this.snapShotRestored = this.activeRestore;
            return this.activeRestore;
        }
        const generation = this.eventState.persistence.storeGeneration;
        const completion = promiseWithResolvers<void>();
        const restore = completion.promise;
        this.activeRestore = restore;
        this.snapShotRestored = restore;
        void this._restoreFromSnapshot(generation).then(
            () => {
                if (this.eventState.persistence.storeGeneration === generation) this.replayNeedsRetry = false;
                completion.resolve();
            },
            (error) => {
                if (this.activeRestore === restore) this.activeRestore = null;
                if (this.eventState.persistence.storeGeneration === generation && isStoreLoaded(this.eventState)) {
                    this.replayNeedsRetry = true;
                }
                if (this.isStopping()) completion.resolve();
                else completion.reject(error);
            }
        );
        return restore;
    }

    /**
     * Invalidate store-scoped persistence metadata when the backing snapshot store is replaced.
     * Retained in-memory intents remain queued and are re-marked dirty for the replacement store.
     */
    override resetPersistenceState(): void {
        invalidatePendingSnapshotBatch(this.eventState);
        resetStorePersistenceState(this.eventState);
        this.activeRestore = null;
        this.replayNeedsRetry = false;
        this.snapShotRestored = null;
    }

    /** Filter and admit host watcher events into the operation queue. */
    appendQueue(params: FileEvent[], ctx?: unknown): Promise<void> {
        return admitStorageEvents(this.eventState, params, ctx, this.admission);
    }

    /** Add an already selected event to the buffer and start background snapshotting and dispatch. */
    enqueue(event: FileEventItem): void {
        enqueueStorageEvent(this.eventState, event, this.queue);
    }

    /** Flush the admissions and operations captured when this call begins. */
    async waitForIdle(): Promise<void> {
        await flushStorageEvents(this.eventState, this.queue);
    }

    /** Pause new file-handler dispatch and wait for dispatches already in progress. */
    override async pauseDispatch(): Promise<void> {
        if (this.isStopping()) return;
        this.dispatchPaused = true;
        await Promise.all([...this.activeDispatches]);
    }

    /** Resume file-handler dispatch after a temporary pause. */
    override resumeDispatch(): void {
        if (this.isStopping() || !this.dispatchPaused) {
            return;
        }
        this.dispatchPaused = false;
        this.dispatchResumeNotifier.notify();
        fireAndForget(() => this.runQueuedEvents().catch((error) => this.reportOperationFailure(error)));
    }

    /** Install the terminal stop fence synchronously and settle pending batch gates. */
    override beginStopWatching(): void {
        if (!beginStoppingState(this.eventState)) return;
        this.stopSignal.resolve();
        this.snapshotSchedule.dispose();
        disposeAllBatchGates(this._waitingMap);
        this.dispatchResumeNotifier.notify();
        this.notifications.updateStatus();
    }

    /** Report whether this manager has entered or completed orderly shutdown (`stopping` or `stopped`). */
    override isStopping(): boolean {
        return isManagerStopping(this.eventState);
    }

    /** Retire the manager after active handlers and pending snapshot commits settle. */
    override stopWatching(): Promise<void> {
        this.beginStopWatching();
        return (this.stopWatchingPromise ??= this.retireManager());
    }

    private async retireManager(): Promise<void> {
        const state = this.eventState;
        try {
            // 1. Wait for admissions already in flight so their retained entries enter `pendingSnapshot`.
            await Promise.allSettled([...state.admissions].map((admission) => admission.completion));
            // 2. Drain active handler dispatches before settling any remaining unstarted attempts.
            await Promise.allSettled([...this.activeDispatches]);
            stopUnstartedAttempts(state);
            // 3. Wait for started handlers through their acknowledgement commits.
            await Promise.allSettled([...state.dispatch.inFlightOperations]);
            // 4. Join any serial snapshot writer loop already in progress.
            while (state.persistence.writerRunning) await state.persistence.tail;
            await state.persistence.tail;
            // 5. Flush remaining dirty intent once, or reject honestly without touching an unread store.
            if (hasPendingSnapshotWork(state)) {
                if (!isStoreLoaded(state)) {
                    throw (
                        state.persistence.storeLoadError?.error ??
                        new Error("Storage event store was not acquired before stopping")
                    );
                }
                await this._takeSnapshot();
                await state.persistence.tail;
            }
        } finally {
            markStoppedState(state);
        }
    }

    /** Check whether an unfinished event refers to this path or one of its ancestors. */
    override hasPendingFileEvent(filename: FilePath): boolean {
        return hasPendingStorageEvent(this.eventState, filename);
    }

    /** Check whether the path currently owns an unresolved batching gate. */
    isWaiting(filename: FilePath) {
        return this._waitingMap.has(filename);
    }

    private retainEvent(event: QueuedFileEvent, register = true) {
        return retainFileEvent(this.eventState, event, register);
    }
    private reportOperationFailure(error: unknown): void {
        this._log("Storage operation remains pending after a failure", LOG_LEVEL_NOTICE);
        this._log(error, LOG_LEVEL_VERBOSE);
    }
    private failOperation(operation: PendingFileEvent, error: unknown, attempt = operation.attempt): void {
        if (!failFileEventAttempt(this.eventState, attempt, error)) return;
        this.reportOperationFailure(error);
        this.notifications.updateStatus();
    }
    private captureAttempts(operations: readonly PendingFileEvent[], retryBefore = -1) {
        return captureFileEventAttempts(operations, retryBefore, this.retry);
    }
    private releaseOperations(operations: readonly PendingFileEvent[]): void {
        releaseFileEventBatches(this.batching, operations);
    }
    private waitForAttempts(attempts: Map<PendingFileEvent, FileEventAttempt>): Promise<OperationResult[]> {
        return waitForFileEventAttempts(attempts, this.queue.release);
    }
    private _proceedWaiting(path: string, requestSnapshot = true): void {
        finishBatchWaiting(this.batching, path, true, requestSnapshot);
    }
    private _cancelWaiting(path: string): void {
        finishBatchWaiting(this.batching, path, false);
        this.wakeBufferedDispatch();
    }
    private _addWaiting(path: string, event: FileEventItem, since?: number): WaitInfo {
        const waitInfo = addBatchWaiting(this.batching, path, event, since);
        this.wakeBufferedDispatch();
        return waitInfo;
    }
    private initialiseOperation(operation: PendingFileEvent): Promise<BatchGateOutcome> {
        return initialiseFileEventBatch(this.batching, operation);
    }
    private wakeBufferedDispatch(): void {
        if (
            this.isStopping() ||
            this.dispatchPaused ||
            (!this.eventState.dispatch.replayQueue?.hasPending && this.buffer.read().length === 0)
        ) {
            return;
        }
        fireAndForget(this.runQueuedEvents().catch(this.notifications.reportFailure));
    }

    private async dispatchQueuedEvent(event: FileEventItem, attempt: FileEventAttempt) {
        try {
            await this.processFileEvent(event);
        } catch (error) {
            const operation = this.operations.get(event);
            if (operation) this.failOperation(operation, error, attempt);
        }
    }

    private async processOperation(operation: PendingFileEvent, attempt: FileEventAttempt): Promise<void> {
        const work = processStorageEventAttempt(this.eventState, operation, attempt, {
            ...this.attempts,
            onHandlerStarted: () => {
                this.eventState.dispatch.inFlightOperations.add(work);
            },
        });
        try {
            await work;
        } finally {
            this.eventState.dispatch.inFlightOperations.delete(work);
            this.eventState.dispatch.dispatched.delete(operation);
            this.wakeBufferedDispatch();
        }
    }

    private async dispatchFileEvent(event: FileEventItem): Promise<void> {
        if (this.isStopping()) return;
        const done = promiseWithResolvers<void>();
        this.activeDispatches.add(done.promise);
        try {
            await this.requestProcessQueue(event);
        } finally {
            this.activeDispatches.delete(done.promise);
            done.resolve();
        }
    }

    /** Retain an event and await its current processing attempt. */
    async processFileEvent(event: FileEventItem): Promise<void> {
        if (this.isStopping()) return;
        if (!isStoreLoaded(this.eventState)) {
            await this.ensureStoreLoaded(false);
            if (this.isStopping()) return;
        }
        const operation = this.retainEvent(event).operation!;
        await this.processOperation(operation, operation.attempt);
    }

    private async persistSnapshot(completion?: SnapshotCompletion, requiredMutationVersion?: number): Promise<void> {
        const state = this.eventState;
        if (isManagerStopped(state)) return;
        const generation = state.persistence.storeGeneration;
        if (!isStoreLoaded(state)) {
            await this.ensureStoreLoaded(false);
        }
        if (state.persistence.storeGeneration !== generation) {
            throw new Error("Storage event store changed during persistence");
        }
        assertStoreLoaded(state);
        return persistFileEventSnapshot(
            this.eventState,
            this.buffer,
            this.snapshotIO,
            completion,
            requiredMutationVersion
        );
    }

    /** Wait for the next serialised snapshot write. */
    async _takeSnapshot(requiredMutationVersion?: number) {
        await this.persistSnapshot(undefined, requiredMutationVersion);
    }

    /** Load persisted events, dispatch them, and wait for their replay attempts. */
    async _restoreFromSnapshot(generation = this.eventState.persistence.storeGeneration) {
        const state = this.eventState;
        const retryReplay = this.replayNeedsRetry;
        await this.ensureStoreLoaded(true);
        if (this.isStopping() || state.persistence.storeGeneration !== generation) return;

        if (retryReplay || state.dispatch.replayQueue?.hasPending) {
            await this.runQueuedEvents({ waitForProcessing: true });
        } else if (generation > 0 && this.buffer.read().length > 0) {
            fireAndForget(this.runQueuedEvents().catch(this.notifications.reportFailure));
        }
    }

    /** Dispatch events in the buffer and optionally wait for captured processing attempts. */
    protected async runQueuedEvents(options: RunQueuedEventsOptions = {}) {
        await runBufferedStorageEvents(this.eventState, this.queue, options);
    }

    private _triggerTakeSnapshot(): void {
        if (this.isStopping()) return;
        fireAndForget(() => this._takeSnapshot().catch((error) => this.reportOperationFailure(error)));
    }

    /** Request a coalesced background snapshot write within a 100 ms trailing window. */
    triggerTakeSnapshot = (): void => {
        if (this.isStopping()) return;
        this.snapshotSchedule.update();
    };

    /** Track a handler dispatch in status and restore the processing count in a `finally` block. */
    protected async requestProcessQueue(event: FileEventItem) {
        try {
            this.processingCount++;
            this.notifications.updateStatus();
            await this.handleFileEvent(event);
        } finally {
            this.processingCount--;
            this.notifications.updateStatus();
        }
    }

    /** Delegate one event to the shared file-processing handler. */
    protected async handleFileEvent(event: FileEventItem): Promise<void> {
        await handleStorageFileEvent(event, this.handler);
    }

    /** Cancel the batch gate associated with a relative event's path. */
    protected cancelRelativeEvent(event: FileEventItem): void {
        this._cancelWaiting(event.args.file.path);
    }

    /** Wait for stored restoration to finish, then register the host watcher callbacks. */
    async beginWatch(): Promise<void> {
        let pending = this.activeRestore ?? this.eventState.persistence.storeLoadPromise ?? this.snapShotRestored;
        // Always yield one microtask so same-turn `beginStopWatching()` prevents registration.
        await pending;
        while (!this.isStopping()) {
            const next = this.activeRestore ?? this.eventState.persistence.storeLoadPromise ?? this.snapShotRestored;
            if (!next || next === pending) break;
            pending = next;
            await pending;
        }
        if (this.isStopping()) return;
        await this.adapter.watch.beginWatch({
            onCreate: (file, ctx) => this.watchVaultCreate(file, ctx),
            onChange: (file, ctx) => this.watchVaultChange(file, ctx),
            onDelete: (file, ctx) => this.watchVaultDelete(file, ctx),
            onRename: (file, oldPath, ctx) => this.watchVaultRename(file, oldPath, ctx),
            onRaw: (path) => this.watchVaultRawEvents(path),
            onEditorChange: (editor, info) => this.watchEditorChange(editor, info),
        });
    }

    /** Refresh the quiet period of the latest eligible batch gate without reading editor content. */
    protected watchEditorChange<TEditor = unknown, TInfo = unknown>(editor: TEditor, info: TInfo) {
        if (!isAcceptingEvents(this.eventState) || !hasEditorChangePath(info) || !this.shouldBatchSave) return;
        const settings = this.settings;
        if (!settings?.isConfigured || settings.suspendFileWatching || isRemediationModeActive(settings)) return;
        const path = readEditorChangePath(info, (file) => this.adapter.typeGuard.isFile(file));
        if (!path) return;
        if (this.storageAccess.isFileProcessing(path)) return;
        const waitInfo = this._waitingMap.get(path);
        if (!waitInfo) return;
        const operation = this.operations.get(waitInfo.event);
        if (!operation || operation.flushRequested || operation.attempt.result) return;
        if (operation.indexedPaths.some((indexedPath) => this.eventState.latestByPath.get(indexedPath) !== operation))
            return;
        const now = Date.now();
        const plan = planBatchDeadline(
            now,
            now,
            waitInfo.since,
            this.batchSaveMinimumDelay * 1000,
            this.batchSaveMaximumDelay * 1000
        );
        if (this._waitingMap.get(path) !== waitInfo) return;
        if (plan.expired) this._proceedWaiting(path, false);
        else waitInfo.deadline.schedule(plan.delay);
    }

    /** Forward a host create notification to facade admission. */
    protected watchVaultCreate<TFile = unknown, TCtx = unknown>(file: TFile, ctx?: TCtx) {
        forwardVaultEvent({ type: "CREATE", file }, ctx, this.watching);
    }

    /** Forward a host change notification to facade admission. */
    protected watchVaultChange<TFile = unknown, TCtx = unknown>(file: TFile, ctx?: TCtx) {
        forwardVaultEvent({ type: "CHANGED", file }, ctx, this.watching);
    }

    /** Forward a host delete notification to facade admission. */
    protected watchVaultDelete<TFile = unknown, TCtx = unknown>(file: TFile, ctx?: TCtx) {
        forwardVaultEvent({ type: "DELETE", file }, ctx, this.watching);
    }

    /** Forward a host rename as one operation with its source path. */
    protected watchVaultRename<TFile = unknown, TCtx = unknown>(file: TFile, oldPath: string, ctx?: TCtx) {
        forwardVaultEvent({ type: "RENAME", file, oldPath }, ctx, this.watching);
    }

    /** Route a raw internal-file callback to the host-specific raw-event hook. */
    protected watchVaultRawEvents(path: FilePath) {
        if (this.storageAccess.isFileProcessing(path)) {
            return;
        }
        // Only for internal files.
        if (!this.settings) return;
        if (this.settings.useIgnoreFiles) {
            // If it is one of ignore files, refresh the cached one.
            void this.vaultService.isTargetFile(path).then(() => this._watchVaultRawEvents(path));
        } else {
            void this._watchVaultRawEvents(path);
        }
    }

    /** Host extension point for platform-specific raw internal-file handling. */
    protected async _watchVaultRawEvents(path: FilePath) {
        // Override in platform-specific implementation if needed
        // For Obsidian: check syncInternalFiles, watchInternalFileChanges, etc.
    }
}
