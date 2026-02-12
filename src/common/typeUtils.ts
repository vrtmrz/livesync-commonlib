import type { DocumentID, FilePath, FilePathWithPrefix } from "./models/db.type";
import { CHeader, ICHeader, ICHeaderLength, ICXHeader, PSCHeader } from "./models/fileaccess.const";
import type { UXFileInfoStub } from "./types";

/**
 * returns is internal chunk of file
 * @param id ID
 * @returns
 */
export function isInternalMetadata(id: FilePath | FilePathWithPrefix | DocumentID): boolean {
    return id.startsWith(ICHeader);
}

export function isInternalFile(file: UXFileInfoStub | string | FilePathWithPrefix) {
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
