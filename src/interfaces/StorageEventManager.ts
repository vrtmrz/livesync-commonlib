import type { FileEventType, FilePath, UXFileInfoStub, UXInternalFileInfoStub } from "@lib/common/types";

export type FileEvent = {
    type: FileEventType;
    file: UXFileInfoStub | UXInternalFileInfoStub;
    oldPath?: string;
    cachedData?: string;
    skipBatchWait?: boolean;
    cancelled?: boolean;
};

export abstract class StorageEventManager {
    abstract beginWatch(): Promise<void>;

    abstract appendQueue(items: FileEvent[], ctx?: unknown): Promise<void>;

    abstract isWaiting(filename: FilePath): boolean;

    /** Compatibility hosts without an ownership view must retain content checks. */
    hasPendingFileEvent?(_filename: FilePath): boolean {
        return true;
    }
    abstract waitForIdle(): Promise<void>;
    /**
     * Pause new file-handler dispatch when the manager supports a reversible pause.
     * @returns A promise fulfilled after processing active at the call settles; pending work is not awaited.
     */
    pauseDispatch?(): Promise<void>;
    /** Resume file-handler dispatch after a supported pause. */
    resumeDispatch?(): void;
    abstract restoreState(): Promise<void>;
    /**
     * Invalidate store-scoped persistence state when the backing snapshot store is replaced.
     * Retained in-memory intents remain queued and must be persisted to the replacement store.
     */
    resetPersistenceState?(): void;
    /**
     * Synchronously install the terminal stop fence before asynchronous unload hooks run.
     * Stops admitting new events, disposes batch timers, and wakes paused or unstarted waits.
     */
    beginStopWatching?(): void;
    /**
     * Report whether this manager has entered or completed orderly shutdown (`stopping` or `stopped`).
     * Optional for compatibility hosts; absence is treated as not stopping.
     */
    isStopping?(): boolean;

    /**
     * Complete accepted work before its storage closes. Custom hosts must stop
     * their watcher admission before invoking this default implementation.
     */
    stopWatching?(): Promise<void> {
        return this.waitForIdle();
    }
}
