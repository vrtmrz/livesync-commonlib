import type { FilePath } from "@lib/common/types.ts";

/**
 * Path operations adapter interface
 * Handles path normalization and extraction
 */
export interface IPathAdapter<TNativeAbstractFile = any> {
    /**
     * Get the path from a file object or return the path string as-is
     */
    getPath(file: TNativeAbstractFile | string): FilePath;

    /**
     * Normalize a path according to the platform's conventions
     */
    normalisePath(path: string): string;
}
