/**
 * Information views and raw shape checks for document operations.
 *
 * These functions are synchronous, have no host dependencies, and own no
 * resources. Shape validation does not decode content, classify namespaces,
 * or establish revision freshness or persistence. Assertion wrappers throw
 * TypeError; inspection reports invalid field shapes as structured failures.
 */
export type {
    DocumentIdentity,
    CurrentFileDocument,
    CurrentFileMetadata,
    CurrentFileContent,
    FileMetadata,
    FileMetadataResponse,
    MaterialisedFile,
    DeletedFileRef,
    DocumentPathRef,
    DeletionState,
    FileProperties,
    ContentDescription,
    FileContentView,
    SplitSource,
    FileToSave,
    CompatibleFileToSave,
    FileChangeRef,
    FileMetadataNotification,
    RevisionRef,
    FetchedChunkPayload,
    RawRevisionRef,
} from "./common/models/document.type";
export {
    inspectFetchedChunkPayload,
    isFetchedChunkPayload,
    assertFetchedChunkPayload,
    inspectRawRevisionRef,
    isRawRevisionRef,
    assertRawRevisionRef,
    type InvalidFieldReason,
    type InvalidField,
    type ValidationInspection,
} from "./common/documentValidation";
export {
    inspectRawCurrentFileMetadata,
    isRawCurrentFileMetadata,
    assertRawCurrentFileMetadata,
    type RawCurrentFileMetadata,
} from "./common/currentMetadataValidation";
