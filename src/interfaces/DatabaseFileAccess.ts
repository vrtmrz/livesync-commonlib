import type { FilePathWithPrefix, LoadedEntry, MetaEntry, UXFileInfo, UXFileInfoStub } from "@lib/common/types";

export interface DatabaseFileAccess {
    delete: (file: UXFileInfoStub | FilePathWithPrefix, rev?: string) => Promise<boolean>;
    store: (file: UXFileInfo, force?: boolean, skipCheck?: boolean) => Promise<boolean>;
    /** Store a file as a child of an exact revision and return the created revision. */
    storeWithBaseRevision: (
        file: UXFileInfo,
        baseRevision: string | undefined,
        skipCheck?: boolean
    ) => Promise<string | false>;
    storeAsConflictedRevision: (file: UXFileInfo, currentRev: string, skipCheck?: boolean) => Promise<boolean>;
    /** Preserve unknown storage content as a conflict and return its exact revision. */
    storeAsConflictedRevisionWithResult: (
        file: UXFileInfo,
        currentRev: string,
        skipCheck?: boolean
    ) => Promise<string | false>;
    /** Store a user deletion as a visible logical-deletion child of an exact revision. */
    storeDeletionWithBaseRevision: (
        file: UXFileInfoStub | FilePathWithPrefix,
        baseRevision: string
    ) => Promise<string | false>;
    storeContent(path: FilePathWithPrefix, content: string): Promise<boolean>;
    createChunks: (file: UXFileInfo, force?: boolean, skipCheck?: boolean) => Promise<boolean>;
    hasContentInRevisionHistory: (
        file: UXFileInfoStub | FilePathWithPrefix,
        content: string | string[] | Blob | ArrayBuffer,
        currentRev?: string
    ) => Promise<boolean>;
    /** Return every available revision whose content exactly matches the supplied bytes. */
    findContentRevisions: (
        file: UXFileInfoStub | FilePathWithPrefix,
        content: string | string[] | Blob | ArrayBuffer,
        currentRev?: string
    ) => Promise<string[]>;
    fetch: (
        file: UXFileInfoStub | FilePathWithPrefix,
        rev?: string,
        waitForReady?: boolean,
        skipCheck?: boolean
    ) => Promise<UXFileInfo | false>;
    fetchEntryFromMeta: (meta: MetaEntry, waitForReady?: boolean, skipCheck?: boolean) => Promise<LoadedEntry | false>;
    fetchEntryMeta: (
        file: UXFileInfoStub | FilePathWithPrefix,
        rev?: string,
        skipCheck?: boolean
    ) => Promise<MetaEntry | false>;
    fetchEntry: (
        file: UXFileInfoStub | FilePathWithPrefix,
        rev?: string,
        waitForReady?: boolean,
        skipCheck?: boolean
    ) => Promise<LoadedEntry | false>;
    getConflictedRevs: (file: UXFileInfoStub | FilePathWithPrefix) => Promise<string[]>;
}
