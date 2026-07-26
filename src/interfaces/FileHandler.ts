import type { FilePath, FilePathWithPrefix, MetaEntry } from "@lib/common/models/db.type";
import type { UXFileInfo, UXFileInfoStub, UXInternalFileInfoStub } from "@lib/common/models/fileaccess.type";

export interface IFileHandler {
    readFileFromStub(file: UXFileInfoStub | UXFileInfo): Promise<UXFileInfo>;

    storeFileToDB(
        info: UXFileInfoStub | UXFileInfo | UXInternalFileInfoStub | FilePathWithPrefix,
        force?: boolean,
        onlyChunks?: boolean
    ): Promise<boolean>;

    /**
     * Store the current storage content as a child of an exact live database revision.
     *
     * This explicit branch-selection boundary is intended for user-directed
     * reconciliation. It rechecks that the selected revision is still live,
     * and records the resulting revision as the storage provenance. When
     * `createIfDifferent` is false, differing storage content is rejected
     * instead of creating a child revision.
     */
    storeFileToDBWithBaseRevision(
        info: UXFileInfoStub | UXFileInfo | FilePathWithPrefix,
        baseRevision: string,
        createIfDifferent?: boolean
    ): Promise<boolean>;

    deleteFileFromDB(info: UXFileInfoStub | UXInternalFileInfoStub | FilePath): Promise<boolean>;

    renameFileInDB(info: UXFileInfoStub | UXFileInfo, oldPath: FilePath | FilePathWithPrefix): Promise<boolean>;

    /**
     * Create a logical deletion on one exact database revision.
     *
     * When device-local storage provenance names the deleted revision, the
     * implementation clears that stale provenance without changing storage.
     */
    deleteRevisionFromDB(
        info: UXFileInfoStub | FilePath | FilePathWithPrefix,
        rev: string
    ): Promise<boolean | undefined>;

    resolveConflictedByDeletingRevision(info: UXFileInfoStub | FilePath, rev: string): Promise<boolean | undefined>;

    dbToStorageWithSpecificRev(
        info: UXFileInfoStub | UXFileInfo | FilePath | FilePathWithPrefix | null,
        rev: string,
        force?: boolean
    ): Promise<boolean>;

    dbToStorage(
        entryInfo: MetaEntry | FilePathWithPrefix,
        info: UXFileInfoStub | UXFileInfo | FilePath | null,
        force?: boolean
    ): Promise<boolean>;

    createAllChunks(showingNotice?: boolean): Promise<void>;
}
