import type {
    AnyEntry,
    FilePath,
    FilePathWithPrefix,
    UXFileInfo,
    UXFileInfoStub,
    UXFolderInfo,
    UXInternalFileInfoStub,
} from "@lib/common/types";

import { stripAllPrefixes } from "@lib/string_and_binary/path";

import type { FileHandlerContext } from "./context";

/**
 * Resolve an entry through the captured host path service.
 *
 * @param ctx - The captured services, per-instance state, and dynamic host seams.
 * @param entry - The database metadata being processed.
 * @returns The path reported by the captured path service.
 * @remarks This helper acquires no document lock. Storage and path access retain the dynamic public host seams where the original operation used them.
 */
export function getFileEntryPath(ctx: FileHandlerContext, entry: AnyEntry): FilePathWithPrefix {
    return ctx.path.getPath(entry);
}

/**
 * Resolve a storage path through the path service and remove its namespace prefix.
 *
 * @param ctx - The captured services, per-instance state, and dynamic host seams.
 * @param entry - The database metadata being processed.
 * @returns The path without a storage namespace prefix.
 * @remarks This helper acquires no document lock. Storage and path access retain the dynamic public host seams where the original operation used them.
 */
export function getFileStoragePath(ctx: FileHandlerContext, entry: AnyEntry): FilePathWithPrefix {
    return stripAllPrefixes(ctx.path.getPath(entry));
}

/**
 * Reuse a supplied body or acquire the current content through storage.
 *
 * @param ctx - The captured services, per-instance state, and dynamic host seams.
 * @param file - The supplied storage observation; its body is reused when present.
 * @returns The supplied or acquired complete file; missing content rejects the operation.
 * @remarks This helper acquires no document lock. Storage and path access retain the dynamic public host seams where the original operation used them.
 */
export async function readStorageFile(ctx: FileHandlerContext, file: UXFileInfoStub | UXFileInfo) {
    if ("body" in file && file.body) {
        return file;
    }
    const readFile = await ctx.host.storage().readStubContent(file);
    if (!readFile) {
        throw new Error(`File ${file.path} is not exist on the storage`);
    }
    return readFile;
}

/**
 * Resolve a path or retain the supplied file observation without reading its body.
 *
 * @param ctx - The captured services, per-instance state, and dynamic host seams.
 * @param info - The supplied file observation or path.
 * @typeParam T - The supplied file observation type retained by the resolver.
 * @returns The supplied or current file stub, or null when the path is absent.
 * @remarks This helper acquires no document lock. Storage and path access retain the dynamic public host seams where the original operation used them.
 */
export async function infoToStub<T extends UXFileInfoStub | UXFileInfo | UXInternalFileInfoStub>(
    ctx: FileHandlerContext,
    info: null | T | FilePathWithPrefix | FilePath
): Promise<T | UXFileInfoStub | null> {
    if (info == null) return null;
    const file = typeof info === "string" ? await ctx.host.storage().getFileStub(info) : info;
    return file;
}

/**
 * Extract a parent directory using storage path separators.
 *
 * @param path - The affected file or provenance path.
 * @returns The parent path, or the empty root path.
 * @remarks This helper acquires no document lock. Storage and path access retain the dynamic public host seams where the original operation used them.
 */
export function getParentPath(path: string): string {
    const lastSeparator = path.lastIndexOf("/");
    return lastSeparator < 0 ? "" : path.slice(0, lastSeparator);
}

/**
 * Narrow a nullable storage observation to a folder.
 *
 * @param info - The supplied file observation or path.
 * @returns Whether the observation is a folder.
 * @remarks This helper acquires no document lock. Storage and path access retain the dynamic public host seams where the original operation used them.
 */
export function isFolderInfo(info: UXFileInfoStub | UXFolderInfo | null): info is UXFolderInfo {
    return info?.isFolder === true;
}
