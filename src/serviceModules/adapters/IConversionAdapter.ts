import type { UXFileInfoStub, UXFolderInfo } from "@lib/common/types.ts";

/**
 * Conversion adapter interface
 * Converts between native file system types and universal types
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- For type extraction.
export interface IConversionAdapter<TNativeFile = any, TNativeFolder = any> {
    /**
     * Convert a native file object to a universal file info stub
     */
    nativeFileToUXFileInfoStub(file: TNativeFile): UXFileInfoStub;

    /**
     * Convert a native folder object to a universal folder info
     */
    nativeFolderToUXFolder(folder: TNativeFolder): UXFolderInfo;
}
