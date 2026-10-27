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
    abstract restoreState(): Promise<void>;

    /**
     * Complete accepted work before its storage closes. Custom hosts must stop
     * their watcher admission before invoking this default implementation.
     */
    stopWatching?(): Promise<void> {
        return this.waitForIdle();
    }
}
