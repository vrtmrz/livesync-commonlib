import { stripAllPrefixes } from "@lib/string_and_binary/path";
import type { DocumentID, FilePath, FilePathWithPrefix } from "./models/db.type";
import { CHeader, ICHeader, ICHeaderLength, ICXHeader, PSCHeader } from "./models/fileaccess.const";
import type { UXFileInfoStub } from "./types";

/** Path conversion requires identity only; internal files need no storage statistics. */
type FilePathInput = string | Pick<UXFileInfoStub, "path" | "isInternal">;

/**
 * returns is internal chunk of file
 * @param id ID
 * @returns
 */
export function isInternalMetadata(id: FilePath | FilePathWithPrefix | DocumentID): boolean {
    return id.startsWith(ICHeader);
}

/**
 * Identify the internal namespace from a path or file identity.
 * @param file - A path or identity whose optional internal flag is retained.
 * @returns Whether the path namespace or explicit flag denotes an internal file.
 */
export function isInternalFile(file: FilePathInput) {
    if (typeof file == "string") return isInternalMetadata(file as FilePathWithPrefix);
    if (file.isInternal) return true;
    return false;
}
export function stripInternalMetadataPrefix<T extends FilePath | FilePathWithPrefix | DocumentID>(id: T): T {
    return id.substring(ICHeaderLength) as T;
}
export function id2InternalMetadataId(id: DocumentID): DocumentID {
    return (ICHeader + id) as DocumentID;
}

// const CHeaderLength = CHeader.length;
export function isChunk(str: string): boolean {
    return str.startsWith(CHeader);
}

export function isPluginMetadata(str: string): boolean {
    return str.startsWith(PSCHeader);
}
export function isCustomisationSyncMetadata(str: string): boolean {
    return str.startsWith(ICXHeader);
}

/**
 * Read the supplied path without changing its namespace or spelling.
 * @param file - A path or file identity; storage statistics are not required.
 * @returns The original path, including any namespace prefix.
 */
export function getPathFromUXFileInfo(file: FilePathInput) {
    if (typeof file == "string") return file as FilePathWithPrefix;
    return file.path;
}
/**
 * Resolve a physical storage path from a path or file identity.
 * @param file - A path or file identity; internal observations may omit statistics.
 * @returns The path with recognised database namespace prefixes removed.
 */
export function getStoragePathFromUXFileInfo(file: FilePathInput) {
    if (typeof file == "string") return stripAllPrefixes(file as FilePathWithPrefix);
    return stripAllPrefixes(file.path);
}
/**
 * Resolve the database namespace from a path or file identity.
 * @param file - A path or identity carrying its optional internal flag.
 * @returns The existing customisation path or the path with its internal namespace applied.
 */
export function getDatabasePathFromUXFileInfo(file: FilePathInput) {
    if (typeof file == "string" && file.startsWith(ICXHeader)) return file as FilePathWithPrefix;
    const prefix = isInternalFile(file) ? ICHeader : "";
    if (typeof file == "string") return (prefix + stripAllPrefixes(file as FilePathWithPrefix)) as FilePathWithPrefix;
    return (prefix + stripAllPrefixes(file.path)) as FilePathWithPrefix;
}
