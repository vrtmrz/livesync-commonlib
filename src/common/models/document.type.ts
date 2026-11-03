import type {
    DocumentID,
    DatabaseEntry,
    EntryWithEden,
    EntryTypeNotes,
    EntryTypeNotesWithLegacy,
    FilePathWithPrefix,
    NewEntry,
    PlainEntry,
    NoteEntry,
} from "./db.type";

/** A branded database identity without file properties or content. */
export interface DocumentIdentity {
    _id: DocumentID;
}

/** Identity and logical path required by path-resolution operations. */
export interface DocumentPathRef extends DocumentIdentity {
    path: FilePathWithPrefix;
}

/** Deletion markers without content or authority to mutate a file. */
export interface DeletionState {
    deleted?: boolean;
    _deleted?: boolean;
}

/** Recorded file attributes; these do not prove content equality. */
export interface FileProperties {
    ctime: number;
    mtime: number;
    size: number;
}

/** Fields used by existing document-content interpretation. */
export interface ContentDescription {
    path: FilePathWithPrefix;
    type?: EntryTypeNotesWithLegacy;
    datatype?: EntryTypeNotes;
}

/** Content and its interpretation fields without database response metadata. */
export interface FileContentView extends ContentDescription {
    data: string | string[];
}

/** Path and Blob content required by a content splitter. */
export interface SplitSource {
    path: FilePathWithPrefix;
    data: Blob;
}

/** Target identity, file attributes, and Blob content before Chunk references exist. */
export interface FileToSave extends DocumentPathRef, FileProperties, SplitSource {}

/** A document identity and revision without a freshness or availability guarantee. */
export interface RevisionRef extends DocumentIdentity {
    _rev: string;
}

/** Raw retrieval fields; an absent or unexpected type remains acceptable. */
export interface FetchedChunkPayload {
    _id: string;
    data: string;
}

/** Raw string fields before identity codecs or revision-state verification. */
export interface RawRevisionRef {
    _id: string;
    _rev: string;
}

/** Current stored file Metadata; content is held in separate Chunks. */
export type CurrentFileMetadata = NewEntry | PlainEntry;

/** Current Metadata with ordered content parts, as required by DFM callbacks. */
export type CurrentFileContent = CurrentFileMetadata & { data: string[] };

/** Metadata for a supported file format, including inline legacy content. */
export type FileMetadata = CurrentFileMetadata | (NoteEntry & { children: string[] });

/** A successful content reconstruction result; it does not prove persistence. */
export type MaterialisedFile = CurrentFileContent & RevisionRef & { datatype: EntryTypeNotes };

/** A body-less database deletion associated with its requested logical path. */
export interface DeletedFileRef extends DocumentPathRef, RevisionRef {
    deleted: true;
    _deleted: true;
}

/** Metadata obtained from one explicit database revision. */
export type FileMetadataResponse = FileMetadata & RevisionRef;

/** Optional fields accepted from existing save callers; the writer derives its Metadata. */
export type CompatibleFileToSave = FileToSave &
    Partial<
        DatabaseEntry &
            EntryWithEden &
            DeletionState & {
                type: EntryTypeNotesWithLegacy;
                datatype: EntryTypeNotes;
                children: string[];
            }
    >;

/** A file change which identifies feature-owned work without supplying its content. */
export interface FileChangeRef extends DocumentPathRef, DeletionState {
    _rev?: string;
}

/** Metadata required to select ordinary file reflection; content is re-read by its owner. */
export interface FileMetadataNotification extends FileChangeRef, FileProperties {
    _conflicts?: string[];
}

/** Persisted current file fields; reconstructed content belongs in a separate value. */
export type CurrentFileDocument = CurrentFileMetadata & { data?: never; datatype?: never };
