import type { FilePathWithPrefix, LoadedEntry, MetaEntry, UXFileInfo, UXFileInfoStub } from "@lib/common/types";

export interface DatabaseFileAccess {
    delete: (file: UXFileInfoStub | FilePathWithPrefix, rev?: string) => Promise<boolean>;
    store: (file: UXFileInfo, force?: boolean, skipCheck?: boolean) => Promise<boolean>;
    /**
     * Store a child of the exact supplied revision, even after that branch has advanced.
     * An undefined base uses the current winner. Return the created revision, or `false`.
     */
    storeWithBaseRevision: (
        file: UXFileInfo,
        baseRevision: string | undefined,
        skipCheck?: boolean
    ) => Promise<string | false>;
    /**
     * Store a file as a child of an exact revision only while that revision remains a live leaf.
     *
     * Unlike {@link storeWithBaseRevision}, this method does not force a branch below an obsolete
     * revision. 'Live leaf' means any current revision-tree leaf, including a non-winning conflict
     * leaf or a logical-deletion leaf. In particular, it returns `false` when another writer has
     * already advanced the supplied base; ordinary target and Chunk validation can also refuse the
     * write without creating a Metadata successor.
     */
    storeWithLiveBaseRevision: (file: UXFileInfo, baseRevision: string, skipCheck?: boolean) => Promise<string | false>;
    /**
     * Preserve content of unknown ancestry as a fresh parentless revision of the same document.
     * Existing branches remain intact; no historical byte match is used as the parent.
     * Return the created revision, or `false` when no Metadata revision was stored.
     */
    storeIndependentRevision: (file: UXFileInfo, skipCheck?: boolean) => Promise<string | false>;
    storeAsConflictedRevision: (file: UXFileInfo, currentRev: string, skipCheck?: boolean) => Promise<boolean>;
    /**
     * Store a sibling of `currentRev` below its parent and return the created revision.
     * Return `false` if that parent is unavailable. Use `storeIndependentRevision`
     * when the storage content has no known ancestor.
     */
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
    /**
     * Return current, non-deleted leaf revisions whose decoded content matches the supplied bytes.
     * Include the winning and conflicting leaves, but never their ancestors. Read only locally
     * available Chunks, without requesting remote data or waiting for missing Chunks to arrive.
     *
     * A unique match can recover provenance; several matches avoid a duplicate write but leave
     * its origin ambiguous. An empty result means no match was confirmed, including when data
     * could not be read. This read neither records provenance nor reserves a leaf for a later write.
     */
    findLiveContentRevisions: (
        file: UXFileInfoStub | FilePathWithPrefix,
        content: string | string[] | Blob | ArrayBuffer
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
    /**
     * Load a revision's content, or return `false` when it cannot be loaded.
     * `localOnly` overrides `waitForReady`: missing Chunks cause failure without remote requests
     * or waiting for delivery, so provenance checks can use only content already available locally.
     */
    fetchEntry: (
        file: UXFileInfoStub | FilePathWithPrefix,
        rev?: string,
        waitForReady?: boolean,
        skipCheck?: boolean,
        localOnly?: boolean
    ) => Promise<LoadedEntry | false>;
    getConflictedRevs: (file: UXFileInfoStub | FilePathWithPrefix) => Promise<string[]>;
}
