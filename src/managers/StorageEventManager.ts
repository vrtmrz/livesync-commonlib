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
import { delay, fireAndForget, isRemediationModeActive, throttle } from "@lib/common/utils.ts";
import { type FileEventItem } from "@lib/common/types.ts";
import { serialized } from "octagonal-wheels/concurrency/lock";
import { Semaphore } from "octagonal-wheels/concurrency/semaphore";
import type { IStorageAccessManager } from "@lib/interfaces/StorageAccess.ts";
import { promiseWithResolvers, type PromiseWithResolvers } from "octagonal-wheels/promises";
import { StorageEventManager, type FileEvent } from "@lib/interfaces/StorageEventManager.ts";
import type { IAPIService, IVaultService } from "@lib/services/base/IService.ts";
import type { SettingService } from "@lib/services/base/SettingService.ts";
import type { FileProcessingService } from "@lib/services/base/FileProcessingService.ts";
import { createInstanceLogFunction } from "@lib/services/lib/logUtils";
import type { IStorageEventManagerAdapter } from "./adapters";
import { compatGlobal, type CompatTimeoutHandle } from "@lib/common/coreEnvFunctions";

type WaitInfo = {
    since: number;
    type: FileEventType;
    canProceed: PromiseWithResolvers<boolean>;
    timerHandler: CompatTimeoutHandle;
    event: FileEventItem;
};
const TYPE_SENTINEL_FLUSH = "SENTINEL_FLUSH";
type FileEventItemSentinelFlush = {
    type: typeof TYPE_SENTINEL_FLUSH;
};
export type FileEventItemSentinel = FileEventItemSentinelFlush;
type OperationResult = { ok: true } | { ok: false; error: unknown };
type PendingFileEvent = {
    event: FileEventItem;
    sequence: number;
    acceptedAt: number;
    completion: PromiseWithResolvers<OperationResult>;
    prerequisites: Set<PendingFileEvent>;
    started: boolean;
    flushRequested: boolean;
    flushSignal?: PromiseWithResolvers<void>;
    successor?: PendingFileEvent;
    result?: OperationResult;
};
type EventAdmission = {
    acceptedAt: number;
    completion: Promise<void>;
    operations: PendingFileEvent[];
    flushRequested: boolean;
};
type PendingSnapshotEntry = {
    event: FileEventItem | FileEventItemSentinel;
    sequence: number;
    completed: boolean;
    operation?: PendingFileEvent;
};
type RunQueuedEventsOptions = {
    waitForProcessing?: boolean;
};
export interface StorageEventManagerBaseDependencies {
    setting: SettingService;
    vaultService: IVaultService;
    fileProcessing: FileProcessingService;
    storageAccessManager: IStorageAccessManager;
    APIService: IAPIService;
}

/**
 * Type helper to extract the file type from a storage event manager adapter
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- This is a type helper for type extraction. Not actually interested to TFolder.
export type ExtractFile<T> = T extends IStorageEventManagerAdapter<infer F, any> ? F : never;

/**
 * Type helper to extract the folder type from a storage event manager adapter
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- This is a type helper for type extraction. Not actually interested to TFile.
export type ExtractFolder<T> = T extends IStorageEventManagerAdapter<any, infer D> ? D : never;

/**
 * Base class for storage event management
 * Uses adapter pattern for platform-specific implementations
 *
 * @template TAdapter - The storage event manager adapter type
 */
export abstract class StorageEventManagerBase<
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- For type extraction.
    TAdapter extends IStorageEventManagerAdapter<any, any>,
> extends StorageEventManager {
    _log: ReturnType<typeof createInstanceLogFunction>;
    protected setting: SettingService;
    protected vaultService: IVaultService;
    protected fileProcessing: FileProcessingService;
    protected storageAccess: IStorageAccessManager;
    protected adapter: TAdapter;

    protected get shouldBatchSave() {
        const settings = this.settings;
        return settings?.liveSync === true ? settings.batchSaveInLiveSync === true : settings?.batchSave;
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
    constructor(adapter: TAdapter, dependencies: StorageEventManagerBaseDependencies) {
        super();
        this.adapter = adapter;
        this.setting = dependencies.setting;
        this.vaultService = dependencies.vaultService;
        this.fileProcessing = dependencies.fileProcessing;
        this.storageAccess = dependencies.storageAccessManager;
        this._log = createInstanceLogFunction("StorageEventManager", dependencies.APIService);
    }

    // Delegated methods to adapter
    _saveSnapshot(snapshot: (FileEventItem | FileEventItemSentinel)[]): Promise<void> {
        return this.adapter.persistence.saveSnapshot(snapshot);
    }

    _loadSnapshot(): Promise<(FileEventItem | FileEventItemSentinel)[] | null> {
        return this.adapter.persistence.loadSnapshot();
    }

    // Type guard methods delegated to adapter
    isFolder(
        file: UXFileInfoStub | UXInternalFileInfoStub | UXFolderInfo | ExtractFolder<TAdapter> | ExtractFile<TAdapter>
    ): boolean {
        return this.adapter.typeGuard.isFolder(file);
    }

    isFile(
        file: UXFileInfoStub | UXInternalFileInfoStub | UXFolderInfo | ExtractFolder<TAdapter> | ExtractFile<TAdapter>
    ): boolean {
        return this.adapter.typeGuard.isFile(file);
    }

    protected updateStatus(): void {
        this.adapter.status.updateStatus({
            batched: this._waitingMap.size,
            processing: this.processingCount,
            totalQueued: [...this.pendingSnapshot.values()].filter((entry) => entry.operation && !entry.completed).length,
        });
    }

    /**
     * Snapshot restoration promise.
     * It resolves after the restored file operations have finished, before Vault watching begins.
     */
    snapShotRestored: Promise<void> | null = null;

    /**
     * Restore and complete the previous storage-event snapshot when it exists.
     */
    restoreState(): Promise<void> {
        this.snapShotRestored = this._restoreFromSnapshot();
        return this.snapShotRestored;
    }
    private acceptingEvents = true;
    private admissions = new Set<EventAdmission>();

    appendQueue(params: FileEvent[], ctx?: unknown): Promise<void> {
        if (!this.acceptingEvents) return Promise.resolve();
        const admission: EventAdmission = { acceptedAt: Date.now(), completion: Promise.resolve(), operations: [], flushRequested: false };
        this.admissions.add(admission);
        admission.completion = this.appendQueueInternal(params, ctx, admission);
        void admission.completion.then(
            () => this.admissions.delete(admission),
            (error) => {
                this.admissions.delete(admission);
                this.reportOperationFailure(error);
            }
        );
        return admission.completion;
    }

    private async appendQueueInternal(params: FileEvent[], ctx: unknown, admission: EventAdmission) {
        const settings = this.settings;
        if (!settings.isConfigured) return;
        if (settings.suspendFileWatching) return;
        if (isRemediationModeActive(settings)) {
            return;
        }
        this.fileProcessing.onStorageFileEvent();
        // Flag up to be reload
        for (const param of params) {
            const atomicKey = [0, 0, 0, 0, 0, 0].map((e) => `${Math.floor(Math.random() * 100000)}`).join("-");
            let type = param.type;
            let file = param.file;
            const oldPath = param.oldPath;

            if (this.isFolder(file)) {
                this._log(`Folder event skipped: ${file.path}`, LOG_LEVEL_VERBOSE);
                continue;
            }

            const isTargetPath = async (path: string): Promise<boolean> => {
                if (shouldBeIgnored(path)) return false;
                if (!settings.syncInternalFiles && path.startsWith(".")) return false;
                return await this.vaultService.isTargetFile(path);
            };

            if (type === "RENAME") {
                const renamedFile = file as UXFileInfoStub;
                if (!oldPath || !this.isFile(file) || !renamedFile.stat) {
                    this._log(`Invalid rename event skipped: ${file.path}`, LOG_LEVEL_VERBOSE);
                    continue;
                }
                const oldPathIsTarget = await isTargetPath(oldPath);
                let newPathIsTarget = await isTargetPath(file.path);
                if (newPathIsTarget && this.vaultService.isFileSizeTooLarge(renamedFile.stat.size)) {
                    this._log(
                        `The storage file has been changed but exceeds the maximum size. Skipping: ${param.file.path}`,
                        LOG_LEVEL_NOTICE
                    );
                    newPathIsTarget = false;
                }
                if (!oldPathIsTarget && !newPathIsTarget) {
                    continue;
                }
                if (oldPathIsTarget && !newPathIsTarget) {
                    type = "DELETE";
                    file = {
                        path: oldPath as FilePath,
                        name: oldPath.split("/").pop() ?? file.name,
                        stat: renamedFile.stat,
                        deleted: true,
                    };
                } else if (!oldPathIsTarget && newPathIsTarget) {
                    type = "CREATE";
                }
            } else {
                if (!(await isTargetPath(file.path))) continue;
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
            }

            // Stop cache using to prevent the corruption;
            // let cache: null | string | ArrayBuffer;
            // new file or something changed, cache the changes.
            // if (file instanceof TFile && (type == "CREATE" || type == "CHANGED")) {
            // if (file instanceof TFile || !file.isFolder) {
            if (this.isFile(file)) {
                if (type == "CREATE" || type == "CHANGED" || type == "RENAME") {
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
            const item: FileEventItem = {
                type,
                args: {
                    file: file,
                    oldPath: type === "RENAME" ? oldPath : undefined,
                    ...(param.type === "RENAME" && type === "DELETE" ? { renameTarget: param.file.path } : {}),
                    cache,
                    ctx,
                },
                skipBatchWait: param.skipBatchWait,
                key: atomicKey,
            };
            this.enqueue(item);
            const operation = this.operations.get(item);
            if (operation) {
                operation.acceptedAt = admission.acceptedAt;
                if (admission.flushRequested) this.releaseOperations([operation]);
                admission.operations.push(operation);
            }
        }
    }
    // Cache file and waiting to can be proceed.

    protected bufferedQueuedItems = [] as (FileEventItem | FileEventItemSentinel)[];
    private pendingSnapshot = new Map<FileEventItem | FileEventItemSentinel, PendingSnapshotEntry>();
    private operations = new WeakMap<FileEventItem, PendingFileEvent>();
    private latestByPath = new Map<string, PendingFileEvent>();
    private nextSequence = 0;
    private snapshotTail: Promise<void> = Promise.resolve();
    private dispatching: Promise<void> | null = null;

    private retainEvent(event: FileEventItem | FileEventItemSentinel): PendingSnapshotEntry {
        const existing = this.pendingSnapshot.get(event);
        if (existing) return existing;
        const entry: PendingSnapshotEntry = { event, sequence: ++this.nextSequence, completed: false };
        if (event.type !== TYPE_SENTINEL_FLUSH) {
            const operation = this.operations.get(event) ?? {
                event,
                sequence: entry.sequence,
                acceptedAt: Date.now(),
                completion: promiseWithResolvers<OperationResult>(),
                prerequisites: new Set<PendingFileEvent>(),
                started: false,
                flushRequested: false,
            };
            entry.operation = operation;
            this.operations.set(event, operation);
        }
        this.pendingSnapshot.set(event, entry);
        return entry;
    }

    private reportOperationFailure(error: unknown) {
        this._log("Storage operation remains pending after a failure", LOG_LEVEL_NOTICE);
        this._log(error, LOG_LEVEL_VERBOSE);
    }

    private failOperation(operation: PendingFileEvent, error: unknown) {
        if (operation.result) return;
        operation.result = { ok: false, error };
        operation.completion.resolve(operation.result);
        this.reportOperationFailure(error);
        this.updateStatus();
    }

    enqueue(newItem: FileEventItem) {
        if (newItem.type === "DELETE" || newItem.type === "RENAME") {
            const sentinel: FileEventItemSentinel = { type: TYPE_SENTINEL_FLUSH };
            this.retainEvent(sentinel);
            this.bufferedQueuedItems.push(sentinel);
        }
        const operation = this.retainEvent(newItem).operation!;
        this.bufferedQueuedItems.push(newItem);
        this.updateStatus();
        fireAndForget(async () => {
            try {
                await this._takeSnapshot();
                await this.runQueuedEvents();
            } catch (error) {
                this.failOperation(operation, error);
            }
        });
    }

    private _triggerTakeSnapshot() {
        fireAndForget(() => this._takeSnapshot().catch((error) => this.reportOperationFailure(error)));
    }
    triggerTakeSnapshot = throttle(() => this._triggerTakeSnapshot(), 100);

    // Waiting timers do not occupy a processing slot.
    protected concurrentProcessing = Semaphore(5);
    protected _waitingMap = new Map<string, WaitInfo>();

    private pendingOperations(before = Number.POSITIVE_INFINITY): PendingFileEvent[] {
        return [...this.pendingSnapshot.values()].flatMap((entry) =>
            entry.operation && entry.sequence < before ? [entry.operation] : []
        );
    }

    private releaseOperations(operations: PendingFileEvent[]) {
        for (const operation of operations) {
            operation.flushRequested = true;
            operation.flushSignal?.resolve();
            const path = operation.event.args.file.path;
            if (this._waitingMap.get(path)?.event === operation.event) this._proceedWaiting(path);
        }
    }

    private async waitForOperations(operations: PendingFileEvent[]): Promise<OperationResult[]> {
        this.releaseOperations(operations);
        return await Promise.all(operations.map((operation) => operation.completion.promise));
    }

    /**
     * Complete the finite set of operations accepted before this call.
     * Later edits cannot replace or extend that set while it is being flushed.
     */
    async waitForIdle(): Promise<void> {
        const admissions = [...this.admissions];
        for (const admission of admissions) admission.flushRequested = true;
        for (const item of this.bufferedQueuedItems) this.retainEvent(item);
        const operations = this.pendingOperations();
        this.releaseOperations(operations);
        const admitted = await Promise.allSettled(admissions.map((admission) => admission.completion));
        const boundary = [...new Set([...operations, ...admissions.flatMap((admission) => admission.operations)])];
        this.releaseOperations(boundary);
        fireAndForget(this.runQueuedEvents().catch((error) => this.reportOperationFailure(error)));
        const results = await this.waitForOperations(boundary);
        const admissionFailure = admitted.find((result) => result.status === "rejected");
        if (admissionFailure?.status === "rejected") throw admissionFailure.reason;
        const failure = results.find((result) => !result.ok);
        if (failure?.ok === false) throw failure.error;
    }

    /** Stop watcher admission before draining or preserving accepted work. */
    override async stopWatching(): Promise<void> {
        this.acceptingEvents = false;
        try {
            await this.waitForIdle();
        } catch (error) {
            this.reportOperationFailure(error);
        }
        await this._takeSnapshot();
    }

    /**
     * Proceed waiting for the given key immediately.
     */
    private _proceedWaiting(key: string) {
        const waitInfo = this._waitingMap.get(key);
        if (waitInfo) {
            waitInfo.canProceed.resolve(true);
            compatGlobal.clearTimeout(waitInfo.timerHandler);
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
            compatGlobal.clearTimeout(waitInfo.timerHandler);
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
        const acceptedAt = this.operations.get(event)?.acceptedAt ?? now;
        const since = waitedSince ?? acceptedAt;
        const elapsed = now - since;
        const maxDelay = this.batchSaveMaximumDelay * 1000;
        const remainingDelay = Math.max(0, maxDelay - elapsed);
        const quietDelay = Math.max(0, this.batchSaveMinimumDelay * 1000 - (now - acceptedAt));
        const nextDelay = Math.min(remainingDelay, quietDelay);
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
            timerHandler: compatGlobal.setTimeout(() => {
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
        const entry = this.retainEvent(fei);
        const operation = entry.operation!;
        if (operation.started || operation.result) {
            const result = await operation.completion.promise;
            if (result.ok === false) throw result.error;
            return;
        }
        operation.started = true;
        const path = fei.args.file.path;
        const relatedPath = fei.type === "RENAME" ? fei.args.oldPath : fei.args.renameTarget;
        const paths = relatedPath ? [path, relatedPath] : [path];
        const waiting = this._waitingMap.get(path);
        let since = operation.acceptedAt;
        for (const eventPath of paths) {
            const previous = this.latestByPath.get(eventPath);
            if (!previous || previous.result?.ok) continue;
            const canReplace = waiting?.event === previous.event && !previous.flushRequested &&
                (previous.event.type === fei.type || fei.type === "DELETE");
            if (canReplace) {
                since = waiting.since;
                previous.successor = operation;
                for (const dependency of previous.prerequisites) operation.prerequisites.add(dependency);
                this._cancelWaiting(eventPath);
            } else {
                operation.prerequisites.add(previous);
                if (this._waitingMap.get(eventPath)?.event === previous.event) this._proceedWaiting(eventPath);
            }
        }
        // Direct callers may have supplied a waiting gate without dispatching its
        // event. Keep that gate ordered too; ordinary events have an owner above.
        if (this._waitingMap.get(path) === waiting && waiting) this._proceedWaiting(path);
        for (const eventPath of paths) this.latestByPath.set(eventPath, operation);
        if (operation.flushRequested) this.releaseOperations([...operation.prerequisites]);
        const shouldWait = this.shouldBatchSave && !fei.skipBatchWait && !operation.flushRequested &&
            (fei.type === "CREATE" || fei.type === "CHANGED");
        const gate = shouldWait ? this._addWaiting(path, fei, since).canProceed.promise : Promise.resolve(true);
        try {
            // Persist admission before any handler can change the database.
            await this._takeSnapshot();
            const canProceed = await gate;
            if (!canProceed) {
                if (!operation.successor) throw new Error(`Storage operation cancelled without a successor: ${path}`);
                const result = await operation.successor.completion.promise;
                if (result.ok === false) throw result.error;
            } else {
                for (const prerequisite of operation.prerequisites) {
                    const result = await prerequisite.completion.promise;
                    if (result.ok === false) throw result.error;
                }
                const release = await this.concurrentProcessing.acquire();
                try {
                    await this.requestProcessQueue(fei);
                } finally {
                    release();
                }
            }
            entry.completed = true;
            try {
                await this._takeSnapshot();
            } catch (error) {
                entry.completed = false;
                throw error;
            }
            operation.result = { ok: true };
            operation.completion.resolve(operation.result);
            for (const eventPath of paths) {
                if (this.latestByPath.get(eventPath) === operation) this.latestByPath.delete(eventPath);
            }
        } catch (error) {
            if (this._waitingMap.get(path)?.event === fei) this._cancelWaiting(path);
            this.failOperation(operation, error);
            throw error;
        } finally {
            this.updateStatus();
        }
    }

    async _takeSnapshot() {
        // Register entries supplied by snapshot restoration before dispatch.
        for (const event of this.bufferedQueuedItems) this.retainEvent(event);
        for (const waiting of this._waitingMap.values()) this.retainEvent(waiting.event);
        const save = this.snapshotTail.then(async () => {
            const entries = [...this.pendingSnapshot.values()];
            const completed = entries.filter((entry) => entry.completed);
            const snapshot = entries.filter((entry) => !entry.completed).map((entry) => entry.event);
            await this._saveSnapshot(snapshot);
            for (const entry of completed) this.pendingSnapshot.delete(entry.event);
            this.updateStatus();
        });
        // A failed adapter write must not break ordering for later attempts.
        this.snapshotTail = save.catch(() => {});
        await save;
    }

    async _restoreFromSnapshot() {
        const snapShot = await this._loadSnapshot();
        if (snapShot && Array.isArray(snapShot) && snapShot.length > 0) {
            // console.warn(`Restoring snapshot: ${snapShot.length} items`);
            this._log(`Restoring storage operation snapshot: ${snapShot.length} items`, LOG_LEVEL_VERBOSE);
            // Restore the snapshot
            // Note: Mark all items as skipBatchWait to prevent apply the off-line batch saving.
            this.bufferedQueuedItems = snapShot.map((event) =>
                event.type === TYPE_SENTINEL_FLUSH
                    ? event
                    : { ...event, restoredFromPreviousRuntime: true, skipBatchWait: true }
            );
            this.updateStatus();
            // A restored snapshot is part of start-up reconciliation. Wait until its
            // actual file operations finish so that the following full scan observes
            // their results rather than racing with fire-and-forget work.
            await this.runQueuedEvents({ waitForProcessing: true });
        } else {
            this._log(`No snapshot to restore`, LOG_LEVEL_VERBOSE);
            // console.warn(`No snapshot to restore`);
        }
    }

    /**
     * Dispatch buffered storage events.
     *
     * Ordinary watcher events retain the existing fire-and-forget behaviour.
     * Snapshot restoration requests completion so its caller can use the replay as
     * a lifecycle boundary. In that mode, a sentinel also waits for every operation
     * dispatched before it, preserving the ordering represented by the snapshot.
     * An individual restored operation failure is logged but does not prevent the
     * following Offline Scanner from reconciling the resulting current state.
     */
    protected async runQueuedEvents(options: RunQueuedEventsOptions = {}) {
        for (const event of this.bufferedQueuedItems) this.retainEvent(event);
        const accepted = this.pendingOperations();
        if (!this.dispatching) {
            const dispatch = async () => {
                while (this.bufferedQueuedItems.length > 0) {
                    const event = this.bufferedQueuedItems.shift()!;
                    const entry = this.retainEvent(event);
                    if (event.type === TYPE_SENTINEL_FLUSH) {
                        // This boundary includes predecessors only. Waiting for
                        // global idleness here would include its own successors.
                        const results = await this.waitForOperations(this.pendingOperations(entry.sequence));
                        if (results.every((result) => result.ok)) {
                            entry.completed = true;
                            try {
                                await this._takeSnapshot();
                            } catch (error) {
                                entry.completed = false;
                                this.reportOperationFailure(error);
                            }
                        }
                    } else if (!entry.operation!.result) {
                        fireAndForget(this.processFileEvent(event).catch(() => {}));
                    }
                }
            };
            this.dispatching = dispatch().finally(() => { this.dispatching = null; });
        }
        await this.dispatching;
        if (options.waitForProcessing) {
            const results = await this.waitForOperations(accepted);
            for (const result of results) {
                if (result.ok === false) this.reportOperationFailure(result.error);
            }
        }
    }

    protected processingCount = 0;
    protected async requestProcessQueue(fei: FileEventItem) {
        try {
            this.processingCount++;
            this.updateStatus();
            await this.handleFileEvent(fei);
        } finally {
            this.processingCount--;
            this.updateStatus();
        }
    }
    isWaiting(filename: FilePath) {
        return this._waitingMap.has(filename);
    }

    protected async handleFileEvent(queue: FileEventItem): Promise<void> {
        const file = queue.args.file;
        await serialized(`handleFile:${file.path}`, async () => {
            if (queue.cancelled) throw new Error(`Storage operation has no confirmed result: ${file.path}`);
            if (queue.type === "INTERNAL" || file.isInternal) {
                const handler = this.fileProcessing.processOptionalFileEventWithResult;
                if (handler && handler.hasHandlers !== false) {
                    const operation = this.operations.get(queue);
                    let whenFlushRequested: Promise<void> | undefined;
                    if (operation) {
                        operation.flushSignal ??= promiseWithResolvers<void>();
                        if (operation.flushRequested) operation.flushSignal.resolve();
                        whenFlushRequested = operation.flushSignal.promise;
                    }
                    const outcome = await handler(file.path as FilePath, { whenFlushRequested });
                    if (outcome.kind === "veto") {
                        throw new Error(`Optional storage operation declined: ${file.path} (${outcome.value})`);
                    }
                } else {
                    // Legacy providers report notification handling, not persistence.
                    await this.fileProcessing.processOptionalFileEvent(file.path as FilePath);
                }
            } else if (!(await this.fileProcessing.processFileEvent(queue))) {
                throw new Error(`Storage operation failed: ${file.path}`);
            }
        });
        this.updateStatus();
    }

    protected cancelRelativeEvent(item: FileEventItem): void {
        this._cancelWaiting(item.args.file.path);
    }

    /**
     * Begin watching for storage events
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
     * Platform-agnostic event handlers
     */
    protected watchEditorChange<TEditor = unknown, TInfo = unknown>(editor: TEditor, info: TInfo) {
        if (typeof info !== "object" || info === null) {
            return;
        }
        if (!("path" in info)) {
            return;
        }
        if (!this.shouldBatchSave) {
            return;
        }
        if (!("file" in info)) {
            return;
        }
        const file = info?.file;
        if (!file) return;
        const path = this.adapter.typeGuard.isFile(file) ? (file as { path?: string }).path : info.path;
        if (!path) return;

        if (this.storageAccess.isFileProcessing(path as FilePath)) {
            return;
        }
        if (!this.isWaiting(path as FilePath)) {
            return;
        }
        const data = (info as { data?: string })?.data as string;
        const fi: FileEvent = {
            type: "CHANGED",
            file: this.adapter.converter.toFileInfo(file),
            cachedData: data,
        };
        void this.appendQueue([fi]);
    }

    protected watchVaultCreate<TFile = unknown, TCtx = unknown>(file: TFile, ctx?: TCtx) {
        if (this.adapter.typeGuard.isFolder(file)) return;
        const path = (file as { path: string }).path as FilePath;
        if (this.storageAccess.isFileProcessing(path)) {
            return;
        }
        const fileInfo = this.adapter.converter.toFileInfo(file);
        void this.appendQueue([{ type: "CREATE", file: fileInfo }], ctx);
    }

    protected watchVaultChange<TFile = unknown, TCtx = unknown>(file: TFile, ctx?: TCtx) {
        if (this.adapter.typeGuard.isFolder(file)) return;
        const path = (file as { path: string }).path as FilePath;
        if (this.storageAccess.isFileProcessing(path)) {
            return;
        }
        const fileInfo = this.adapter.converter.toFileInfo(file);
        void this.appendQueue([{ type: "CHANGED", file: fileInfo }], ctx);
    }

    protected watchVaultDelete<TFile = unknown, TCtx = unknown>(file: TFile, ctx?: TCtx) {
        if (this.adapter.typeGuard.isFolder(file)) return;
        const path = (file as { path: string }).path as FilePath;
        if (this.storageAccess.isFileProcessing(path)) {
            return;
        }
        const fileInfo = this.adapter.converter.toFileInfo(file, true);
        void this.appendQueue([{ type: "DELETE", file: fileInfo }], ctx);
    }

    protected watchVaultRename<TFile = unknown, TCtx = unknown>(file: TFile, oldPath: string, ctx?: TCtx) {
        if (this.adapter.typeGuard.isFile(file)) {
            const fileInfo = this.adapter.converter.toFileInfo(file);
            void this.appendQueue(
                [
                    {
                        type: "RENAME",
                        file: fileInfo,
                        oldPath,
                        skipBatchWait: true,
                    },
                ],
                ctx
            );
        }
    }

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

    protected async _watchVaultRawEvents(path: FilePath) {
        // Override in platform-specific implementation if needed
        // For Obsidian: check syncInternalFiles, watchInternalFileChanges, etc.
    }
}
