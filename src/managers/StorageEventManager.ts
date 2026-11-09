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
import { fireAndForget, throttle } from "@lib/common/utils";
import { Semaphore } from "octagonal-wheels/concurrency/semaphore";
import type { IStorageAccessManager } from "@lib/interfaces/StorageAccess";
import { StorageEventManager, type FileEvent } from "@lib/interfaces/StorageEventManager";
import type { IAPIService, IVaultService } from "@lib/services/base/IService";
import type { SettingService } from "@lib/services/base/SettingService";
import type { FileProcessingService } from "@lib/services/base/FileProcessingService";
import { createInstanceLogFunction, type LogFunction } from "@lib/services/lib/logUtils";
import type { IStorageEventManagerAdapter } from "./adapters";
import type { FileEventAttempt, OperationResult, PendingFileEvent } from "./StorageEventManager/operations";
import { admitStorageEvents, type StorageEventAdmissionEffects } from "./StorageEventManager/admission";
import {
    forwardVaultEvent,
    hasEditorChangePath,
    readEditorFileChange,
    type StorageEventWatchEffects,
} from "./StorageEventManager/watching";
import {
    addBatchWaiting,
    finishBatchWaiting,
    initialiseFileEventBatch,
    releaseFileEventBatches,
    type StorageEventBatching,
    type WaitInfo,
} from "./StorageEventManager/batching";
import {
    enqueueStorageEvent,
    flushStorageEvents,
    restoreStorageEvents,
    runBufferedStorageEvents,
    type StorageEventQueueEffects,
} from "./StorageEventManager/queue";
import {
    captureFileEventAttempts,
    waitForFileEventAttempts,
    type StorageEventRetryEffects,
} from "./StorageEventManager/retry";
import { persistFileEventSnapshot, type StorageEventSnapshotIO } from "./StorageEventManager/snapshot";
import {
    handleStorageFileEvent,
    processStorageEventAttempt,
    type StorageEventAttemptEffects,
    type StorageEventHandlerEffects,
} from "./StorageEventManager/processing";
import {
    createStorageEventState,
    failFileEventAttempt,
    hasPendingStorageEvent,
    retainFileEvent,
    type FileEventItemSentinel,
    type QueuedFileEvent,
    type RunQueuedEventsOptions,
    type SnapshotCompletion,
    type StorageEventBuffer,
    type StorageEventNotifications,
} from "./StorageEventManager/state";
export type { FileEventItemSentinel } from "./StorageEventManager/state";

/**
 * Bundle host services used to construct the platform-neutral storage-event manager.
 * @remarks These dependencies keep vault access, file processing, settings, and diagnostics at the adapter boundary.
 */
export interface StorageEventManagerBaseDependencies {
    setting: SettingService;
    vaultService: IVaultService;
    fileProcessing: FileProcessingService;
    storageAccessManager: IStorageAccessManager;
    APIService: IAPIService;
}

/**
 * Extract the host file type from a candidate adapter type.
 * @typeParam T - The candidate adapter type.
 * @remarks The conditional type resolves to `never` for non-adapter inputs; this is a compile-time type result, separate from any runtime type-guard outcome.
 */
export type ExtractFile<T> = T extends IStorageEventManagerAdapter<infer F, infer _Folder> ? F : never;
/**
 * Extract the host folder type from a candidate adapter type.
 * @typeParam T - The candidate adapter type.
 * @remarks The conditional type resolves to `never` for non-adapter inputs; this is a compile-time type result, separate from any runtime type-guard outcome.
 */
export type ExtractFolder<T> = T extends IStorageEventManagerAdapter<infer _File, infer D> ? D : never;

/**
 * Compose a host adapter with the stateful storage-event pipeline.
 * @typeParam TAdapter - The platform adapter which defines host file and folder representations.
 * @remarks
 * Public methods implement admission, flushing, restoration, and watcher lifecycle contracts.
 * Protected getters, processing hooks, and watcher callbacks are extension points for host subclasses.
 * Watcher callbacks remain protected so platform overrides continue to run while their base implementations share conversion through `forwardVaultEvent`.
 * Private methods and effect objects are internal composition details of this facade.
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
    private readonly notifications: StorageEventNotifications = {
        updateStatus: () => this.updateStatus(),
        reportFailure: (error) => this.reportOperationFailure(error),
    };
    private readonly log: LogFunction = (...args) => this._log(...args);
    private readonly batching: StorageEventBatching = {
        waiting: () => this._waitingMap,
        operation: (event) => this.operations.get(event),
        minimumDelay: () => this.batchSaveMinimumDelay,
        maximumDelay: () => this.batchSaveMaximumDelay,
        enabled: () => this.shouldBatchSave,
        log: this.log,
        requestSnapshot: () => this.triggerTakeSnapshot(),
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
        updateStatus: this.notifications.updateStatus,
    };
    private readonly queue: StorageEventQueueEffects = {
        ...this.notifications,
        buffer: this.buffer,
        log: this.log,
        takeSnapshot: () => this._takeSnapshot(),
        loadSnapshot: () => this._loadSnapshot(),
        processFileEvent: (event) => this.processFileEvent(event),
        runQueuedEvents: (options) => this.runQueuedEvents(options),
        capture: (operations, before) => this.captureAttempts(operations, before),
        release: (operations) => this.releaseOperations(operations),
        wait: (attempts) => this.waitForAttempts(attempts),
        fail: (operation, error, attempt) => this.failOperation(operation, error, attempt),
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
        requestProcessQueue: (event) => this.requestProcessQueue(event),
        cancelWaiting: (event) => {
            const path = event.args.file.path;
            if (this._waitingMap.get(path)?.event === event) this._cancelWaiting(path);
        },
        fail: this.queue.fail,
    };
    private readonly handler: StorageEventHandlerEffects = {
        processing: () => this.fileProcessing,
        operation: (event) => this.operations.get(event),
        updateStatus: this.notifications.updateStatus,
    };

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
        this.setting = dependencies.setting;
        this.vaultService = dependencies.vaultService;
        this.fileProcessing = dependencies.fileProcessing;
        this.storageAccess = dependencies.storageAccessManager;
        this._log = createInstanceLogFunction("StorageEventManager", dependencies.APIService);
    }

    /**
     * Read the setting service's current settings.
     * @returns The current settings value; each access can observe live changes.
     */
    get settings() {
        return this.setting.currentSettings();
    }
    /**
     * Resolve whether batching is enabled from the settings active at this access.
     * @returns The live-sync batching value while LiveSync is active, or the general batching value otherwise.
     * @remarks Protected so a host subclass can provide its batching policy.
     */
    protected get shouldBatchSave() {
        const settings = this.settings;
        return settings?.liveSync === true ? settings.batchSaveInLiveSync === true : settings?.batchSave;
    }
    /**
     * Resolve the minimum batch delay from the current settings.
     * @returns The configured delay value, or the default when the setting is absent.
     */
    protected get batchSaveMinimumDelay(): number {
        return this.settings?.batchSaveMinimumDelay ?? DEFAULT_SETTINGS.batchSaveMinimumDelay;
    }
    /**
     * Resolve the maximum batch delay from the current settings.
     * @returns The configured delay value, or the default when the setting is absent.
     */
    protected get batchSaveMaximumDelay(): number {
        return this.settings?.batchSaveMaximumDelay ?? DEFAULT_SETTINGS.batchSaveMaximumDelay;
    }
    /**
     * Expose the manager's event-to-operation identity map to its internal effects.
     * @returns The weak map used to find an operation from its event object.
     */
    private get operations() {
        return this.eventState.operations;
    }

    /**
     * Save the supplied queued-event snapshot through the host adapter.
     * @param snapshot - File events and flush sentinels to persist.
     * @returns A promise fulfilled when the adapter saves the snapshot; adapter failures reject it.
     */
    _saveSnapshot(snapshot: (FileEventItem | FileEventItemSentinel)[]): Promise<void> {
        return this.adapter.persistence.saveSnapshot(snapshot);
    }
    /**
     * Load the queued-event snapshot through the host adapter.
     * @returns A promise for the saved events, or `null` when no snapshot exists; adapter failures reject it.
     */
    _loadSnapshot(): Promise<(FileEventItem | FileEventItemSentinel)[] | null> {
        return this.adapter.persistence.loadSnapshot();
    }
    /**
     * Ask the host adapter to classify a supplied file or folder value.
     * @param file - A host value or one of the shared file and folder representations.
     * @returns Whether the adapter recognises the value as a folder.
     */
    isFolder(
        file: UXFileInfoStub | UXInternalFileInfoStub | UXFolderInfo | ExtractFolder<TAdapter> | ExtractFile<TAdapter>
    ): boolean {
        return this.adapter.typeGuard.isFolder(file);
    }
    /**
     * Ask the host adapter to classify a supplied file or folder value.
     * @param file - A host value or one of the shared file and folder representations.
     * @returns Whether the adapter recognises the value as a file.
     */
    isFile(
        file: UXFileInfoStub | UXInternalFileInfoStub | UXFolderInfo | ExtractFolder<TAdapter> | ExtractFile<TAdapter>
    ): boolean {
        return this.adapter.typeGuard.isFile(file);
    }
    /**
     * Publish the current batch, processing, and unfinished-operation counts through the adapter.
     * @returns Nothing; the adapter's status surface is updated synchronously.
     */
    protected updateStatus(): void {
        this.adapter.status.updateStatus({
            batched: this._waitingMap.size,
            processing: this.processingCount,
            totalQueued: [...this.eventState.pendingSnapshot.values()].filter(
                (entry) => entry.operation && !entry.completed
            ).length,
        });
    }

    /** Completes restored operations before the host starts watching. */
    snapShotRestored: Promise<void> | null = null;
    /**
     * Start snapshot restoration and retain the promise used by watcher startup.
     * @returns A promise fulfilled after restoration and replay attempts settle; snapshot or dispatch errors reject it, while failed operation results are reported and retained.
     */
    restoreState(): Promise<void> {
        this.snapShotRestored = this._restoreFromSnapshot();
        return this.snapShotRestored;
    }
    /**
     * Filter and admit host watcher events into the operation queue.
     * @param params - The watcher events to select and enqueue.
     * @param ctx - Optional host context forwarded with each admitted event.
     * @returns A promise for filtering and queue admission, not for file-handler completion; admission failures are reported and reject it.
     * @remarks The promise may resolve while admitted handlers are still pending. Use `waitForIdle` for the captured processing boundary.
     */
    appendQueue(params: FileEvent[], ctx?: unknown): Promise<void> {
        return admitStorageEvents(this.eventState, params, ctx, this.admission);
    }
    /**
     * Add an already selected event to the buffer and start background snapshotting and dispatch.
     * @param event - The event which has already passed host admission checks.
     * @returns Nothing; processing and persistence failures are reported through manager effects.
     */
    enqueue(event: FileEventItem): void {
        enqueueStorageEvent(this.eventState, event, this.queue);
    }
    /**
     * Flush the admissions and operations captured when this call begins.
     * @returns A promise fulfilled when those attempts settle; it rejects with an admission or operation failure.
     * @remarks Later admissions are outside this flush boundary. Batch gates in the captured work are released before waiting.
     */
    async waitForIdle(): Promise<void> {
        await flushStorageEvents(this.eventState, this.queue);
    }
    /**
     * Stop accepting events, flush current work, and persist the remaining snapshot.
     * @returns A promise fulfilled after the final snapshot write; a flush failure is logged, while a final snapshot failure rejects it.
     */
    override async stopWatching(): Promise<void> {
        this.eventState.acceptingEvents = false;
        try {
            await this.waitForIdle();
        } catch (error) {
            this.reportOperationFailure(error);
        }
        await this._takeSnapshot();
    }
    /**
     * Check whether an unfinished event refers to this path or one of its ancestors.
     * @param filename - The vault-relative path to check.
     * @returns Whether a pending event names the path, an ancestor, or either side of a rename.
     */
    override hasPendingFileEvent(filename: FilePath): boolean {
        return hasPendingStorageEvent(this.eventState, filename);
    }
    /**
     * Check whether the path currently owns an unresolved batching gate.
     * @param filename - The vault-relative path to check.
     * @returns Whether a batch gate is present; this does not indicate whether a handler is still running.
     */
    isWaiting(filename: FilePath) {
        return this._waitingMap.has(filename);
    }

    /**
     * Reuse or create the snapshot entry for a queued event.
     * @param event - A file event or flush sentinel to retain.
     * @param register - Whether to register path-ordering relationships for a file event; defaults to `true`.
     * @returns The retained snapshot entry for the event.
     */
    private retainEvent(event: QueuedFileEvent, register = true) {
        return retainFileEvent(this.eventState, event, register);
    }
    /**
     * Log an operation failure which remains pending for retry or recovery.
     * @param error - The failure reported by admission, processing, or persistence.
     * @returns Nothing; the error is logged at notice and verbose levels.
     */
    private reportOperationFailure(error: unknown): void {
        this._log("Storage operation remains pending after a failure", LOG_LEVEL_NOTICE);
        this._log(error, LOG_LEVEL_VERBOSE);
    }
    /**
     * Record an unsettled attempt as failed and refresh the manager status.
     * @param operation - The pending operation associated with the attempt.
     * @param error - The failure to retain and report.
     * @param attempt - The attempt to fail; defaults to the operation's current attempt.
     * @returns Nothing; an already settled attempt is left unchanged.
     */
    private failOperation(operation: PendingFileEvent, error: unknown, attempt = operation.attempt): void {
        if (!failFileEventAttempt(this.eventState, attempt, error)) return;
        this.reportOperationFailure(error);
        this.updateStatus();
    }
    /**
     * Capture attempts for a finite set of operations and start eligible retries.
     * @param operations - The operations whose current attempts form the capture boundary.
     * @param retryBefore - The latest failure sequence eligible for retry; defaults to no prior failure.
     * @returns The operation-to-attempt map for this boundary.
     */
    private captureAttempts(operations: readonly PendingFileEvent[], retryBefore = -1) {
        return captureFileEventAttempts(operations, retryBefore, this.retry);
    }
    /**
     * Mark the supplied operations for flushing and release their current batch gates.
     * @param operations - The operations to release.
     * @returns Nothing; no handler completion is awaited here.
     */
    private releaseOperations(operations: readonly PendingFileEvent[]): void {
        releaseFileEventBatches(this.batching, operations);
    }
    /**
     * Release and await the attempts in the supplied capture.
     * @param attempts - The operation-to-attempt capture to settle.
     * @returns A promise for one success or failure result per captured attempt.
     */
    private waitForAttempts(attempts: Map<PendingFileEvent, FileEventAttempt>): Promise<OperationResult[]> {
        return waitForFileEventAttempts(attempts, this.queue.release);
    }
    /**
     * Resolve the current gate for a path as eligible to proceed.
     * @param path - The event path whose gate should proceed.
     * @returns Nothing; the gate is resolved and a snapshot is requested.
     */
    private _proceedWaiting(path: string): void {
        finishBatchWaiting(this.batching, path, true);
    }
    /**
     * Resolve the current gate for a path as cancelled.
     * @param path - The event path whose gate should be cancelled.
     * @returns Nothing; a coalesced successor may take over the cancelled attempt.
     */
    private _cancelWaiting(path: string): void {
        finishBatchWaiting(this.batching, path, false);
    }
    /**
     * Create a timed batch gate for an event, optionally inheriting a predecessor's wait start.
     * @param path - The path used as the gate key.
     * @param event - The event which owns the gate.
     * @param since - Optional inherited time from which the maximum delay is measured.
     * @returns The gate, including its deadline and proceed promise.
     * @throws An error if another gate already exists for the path.
     */
    private _addWaiting(path: string, event: FileEventItem, since?: number): WaitInfo {
        return addBatchWaiting(this.batching, path, event, since);
    }
    /**
     * Initialise predecessor ordering and obtain this operation's batch-gate result.
     * @param operation - The operation whose predecessors and gate are being prepared.
     * @returns A promise resolving to the gate's proceed or cancel result, not handler completion.
     */
    private initialiseOperation(operation: PendingFileEvent): Promise<boolean> {
        return initialiseFileEventBatch(this.batching, operation);
    }
    /**
     * Run one attempt through gate preparation, ordering, handler dispatch, and snapshot completion.
     * @param operation - The pending event operation to process.
     * @param attempt - The captured attempt whose completion is being driven.
     * @returns A promise fulfilled on successful completion; attempt failures are recorded and rethrown.
     */
    private async processOperation(operation: PendingFileEvent, attempt: FileEventAttempt) {
        await processStorageEventAttempt(this.eventState, operation, attempt, this.attempts);
    }
    /**
     * Retain an event and await its current processing attempt.
     * @param event - The already selected event to process.
     * @returns A promise fulfilled when the attempt completes; a failed attempt rejects it.
     */
    async processFileEvent(event: FileEventItem) {
        const operation = this.retainEvent(event).operation!;
        await this.processOperation(operation, operation.attempt);
    }
    /**
     * Persist the manager snapshot and optionally acknowledge one attempt in that snapshot.
     * @param completion - Optional entry and attempt whose completion should be committed.
     * @returns A promise for the serialised save; snapshot I/O failures reject it.
     */
    private persistSnapshot(completion?: SnapshotCompletion): Promise<void> {
        return persistFileEventSnapshot(this.eventState, this.buffer, this.snapshotIO, completion);
    }
    /**
     * Wait for the next serialised snapshot write.
     * @returns A promise fulfilled after persistence; save failures reject it.
     */
    async _takeSnapshot() {
        await this.persistSnapshot();
    }
    /**
     * Load persisted events, dispatch them, and wait for their replay attempts.
     * @returns A promise for restoration; storage or dispatch errors reject it, while failed attempt results are reported and retained.
     */
    async _restoreFromSnapshot() {
        await restoreStorageEvents(this.queue);
    }
    /**
     * Dispatch events in the buffer and optionally wait for captured processing attempts.
     * @param options - Queue-run options, including whether to wait for processing.
     * @returns A promise for dispatch; with `waitForProcessing`, failed attempt results are reported rather than thrown as operation errors.
     */
    protected async runQueuedEvents(options: RunQueuedEventsOptions = {}) {
        await runBufferedStorageEvents(this.eventState, this.queue, options);
    }
    /**
     * Start a background snapshot write and report any persistence failure.
     * @returns Nothing; the write is deliberately not awaited by the caller.
     */
    private _triggerTakeSnapshot(): void {
        fireAndForget(() => this._takeSnapshot().catch((error) => this.reportOperationFailure(error)));
    }
    /**
     * Throttled callback for requesting a background snapshot write.
     * @returns The callback bound to `_triggerTakeSnapshot` with a 100 ms throttle interval.
     */
    triggerTakeSnapshot = throttle(() => this._triggerTakeSnapshot(), 100);
    /**
     * Track a handler dispatch in status and restore the processing count in a `finally` block.
     * @param event - The event passed to the host processing hook.
     * @returns A promise fulfilled after handling; handler or status-update failures reject it.
     */
    protected async requestProcessQueue(event: FileEventItem) {
        try {
            this.processingCount++;
            this.updateStatus();
            await this.handleFileEvent(event);
        } finally {
            this.processingCount--;
            this.updateStatus();
        }
    }
    /**
     * Delegate one event to the shared file-processing handler.
     * @param event - The event to process.
     * @returns A promise fulfilled after handling; processing failures propagate to the attempt.
     * @remarks Protected so hosts can override event handling while retaining the queue lifecycle.
     */
    protected async handleFileEvent(event: FileEventItem): Promise<void> {
        await handleStorageFileEvent(event, this.handler);
    }
    /**
     * Cancel the batch gate associated with a relative event's path.
     * @param event - The event whose path identifies the gate.
     * @returns Nothing; cancelling the gate does not itself complete the operation.
     */
    protected cancelRelativeEvent(event: FileEventItem): void {
        this._cancelWaiting(event.args.file.path);
    }

    /**
     * Wait for stored restoration to finish, then register the host watcher callbacks.
     * @returns A promise fulfilled when watcher registration finishes; a restoration failure prevents registration and rejects it.
     */
    async beginWatch(): Promise<void> {
        await this.snapShotRestored;

        await this.adapter.watch.beginWatch({
            onCreate: (file, ctx) => this.watchVaultCreate(file, ctx),
            onChange: (file, ctx) => this.watchVaultChange(file, ctx),
            onDelete: (file, ctx) => this.watchVaultDelete(file, ctx),
            onRename: (file, oldPath, ctx) => this.watchVaultRename(file, oldPath, ctx),
            onRaw: (path) => this.watchVaultRawEvents(path),
            onEditorChange: (editor, info) => this.watchEditorChange(editor, info),
        });
    }

    /**
     * Admit an editor change for a selected file with an active batch gate.
     * @typeParam TEditor - The platform editor type carried by the watcher callback.
     * @typeParam TInfo - The platform editor-change payload type.
     * @param editor - The editor callback value, retained for the host watcher signature.
     * @param info - The editor-change envelope used to resolve file, path, and cached text.
     * @returns Nothing; invalid payloads, disabled batching, active processing, and absent gates are skipped, and admission is not awaited.
     * @remarks Protected so host subclasses can customise editor watcher handling.
     */
    protected watchEditorChange<TEditor = unknown, TInfo = unknown>(editor: TEditor, info: TInfo) {
        if (!hasEditorChangePath(info) || !this.shouldBatchSave) return;
        const change = readEditorFileChange(info, (file) => this.adapter.typeGuard.isFile(file));
        if (!change) return;
        if (this.storageAccess.isFileProcessing(change.path)) return;
        if (!this.isWaiting(change.path)) return;
        const event: FileEvent = {
            type: "CHANGED",
            file: this.adapter.converter.toFileInfo(change.file),
            cachedData: change.data,
        };
        void this.appendQueue([event]);
    }

    /**
     * Forward a host create notification to facade admission.
     * @typeParam TFile - The host file payload type.
     * @typeParam TCtx - The host watcher context type.
     * @param file - The untrusted host notification payload.
     * @param ctx - Optional host context forwarded to admission.
     * @returns Nothing; unrecognised payloads and paths reported as already processing are skipped, and admission is not awaited.
     * @remarks This remains a protected override point; the base implementation shares validation and conversion through `forwardVaultEvent`.
     */
    protected watchVaultCreate<TFile = unknown, TCtx = unknown>(file: TFile, ctx?: TCtx) {
        forwardVaultEvent({ type: "CREATE", file }, ctx, this.watching);
    }

    /**
     * Forward a host change notification to facade admission.
     * @typeParam TFile - The host file payload type.
     * @typeParam TCtx - The host watcher context type.
     * @param file - The untrusted host notification payload.
     * @param ctx - Optional host context forwarded to admission.
     * @returns Nothing; unrecognised payloads and paths reported as already processing are skipped, and admission is not awaited.
     * @remarks This remains a protected override point; the base implementation shares validation and conversion through `forwardVaultEvent`.
     */
    protected watchVaultChange<TFile = unknown, TCtx = unknown>(file: TFile, ctx?: TCtx) {
        forwardVaultEvent({ type: "CHANGED", file }, ctx, this.watching);
    }

    /**
     * Forward a host delete notification to facade admission.
     * @typeParam TFile - The host file payload type.
     * @typeParam TCtx - The host watcher context type.
     * @param file - The untrusted host notification payload.
     * @param ctx - Optional host context forwarded to admission.
     * @returns Nothing; unrecognised payloads and paths reported as already processing are skipped, and admission is not awaited.
     * @remarks This remains a protected override point; the base implementation shares validation and conversion through `forwardVaultEvent`.
     */
    protected watchVaultDelete<TFile = unknown, TCtx = unknown>(file: TFile, ctx?: TCtx) {
        forwardVaultEvent({ type: "DELETE", file }, ctx, this.watching);
    }

    /**
     * Forward a host rename as one operation with its source path.
     * @typeParam TFile - The host file payload type.
     * @typeParam TCtx - The host watcher context type.
     * @param file - The untrusted host notification payload.
     * @param oldPath - The path the file was renamed from.
     * @param ctx - Optional host context forwarded to admission.
     * @returns Nothing; unrecognised payloads are skipped, and admission is not awaited.
     * @remarks Rename bypasses processing-path suppression and batching. This protected hook remains overridable by host subclasses.
     */
    protected watchVaultRename<TFile = unknown, TCtx = unknown>(file: TFile, oldPath: string, ctx?: TCtx) {
        forwardVaultEvent({ type: "RENAME", file, oldPath }, ctx, this.watching);
    }

    /**
     * Route a raw internal-file callback to the host-specific raw-event hook.
     * @param path - The vault-relative path reported by the host watcher.
     * @returns Nothing; while ignore-file handling is enabled, the target check is started before the hook.
     * @remarks Protected so platform subclasses can provide their raw-event policy.
     */
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

    /**
     * Host extension point for platform-specific raw internal-file handling.
     * @param path - The vault-relative internal-file path to inspect.
     * @returns A resolved promise in the base implementation; subclasses may perform asynchronous handling.
     */
    protected async _watchVaultRawEvents(path: FilePath) {
        // Override in platform-specific implementation if needed
        // For Obsidian: check syncInternalFiles, watchInternalFileChanges, etc.
    }
}
