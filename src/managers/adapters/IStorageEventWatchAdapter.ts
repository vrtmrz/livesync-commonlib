import type { FilePath } from "@lib/common/types";

/**
 * Event handlers for storage events
 */
export interface IStorageEventWatchHandlers {
    onCreate: (file: any, ctx?: any) => void;
    onChange: (file: any, ctx?: any) => void;
    onDelete: (file: any, ctx?: any) => void;
    onRename: (file: any, oldPath: string, ctx?: any) => void;
    onRaw: (path: FilePath) => void;
    onEditorChange?: (editor: any, info: any) => void;
}

/**
 * Adapter interface for watching vault/storage events
 */
export interface IStorageEventWatchAdapter {
    /**
     * Begin watching for storage events
     */
    beginWatch(handlers: IStorageEventWatchHandlers): Promise<void>;
}
