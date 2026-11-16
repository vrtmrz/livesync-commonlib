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
     * Complete accepted work before its storage closes. Custom hosts must stop
     * their watcher admission before invoking this default implementation.
     */
    stopWatching?(): Promise<void> {
        return this.waitForIdle();
    }
}
