import { getPath, getPathWithoutPrefix } from "@vrtmrz/livesync-commonlib/compat/string_and_binary/path";
import {
    isDeletedEntry,
    isTextDocument,
    readAsBlob,
    readContent,
} from "@vrtmrz/livesync-commonlib/compat/common/utils";
import type { DocumentID, FilePathWithPrefix } from "@vrtmrz/livesync-commonlib/compat/common/types";

const path = "note.md" as FilePathWithPrefix;
const reference = { _id: "note.md" as DocumentID, path };
const content = { path, type: "plain" as const, data: ["one", "two"] };
const resolved: FilePathWithPrefix = getPath(reference);
getPathWithoutPrefix(reference);
const deleted: boolean = isDeletedEntry({ deleted: true });
const text: boolean = isTextDocument({ path, type: "plain" });
const blob: Blob = readAsBlob(content);
readContent(content);
void [resolved, deleted, text, blob];

import {
    assertFetchedChunkPayload,
    type FileToSave,
    type FileContentView,
    type RevisionRef,
    type RawRevisionRef,
    type SplitSource,
    type CurrentFileDocument,
    type FileMetadataResponse,
    type MaterialisedFile,
    assertRawCurrentFileMetadata,
} from "@vrtmrz/livesync-commonlib/documents";

const save: FileToSave = { ...reference, ctime: 1, mtime: 2, size: 3, data: new Blob(["abc"]) };
const split: SplitSource = { path, data: save.data };
// @ts-expect-error A Metadata view does not provide content.
const incomplete: FileContentView = { path, type: "plain" };
declare const rawRevision: RawRevisionRef;
// @ts-expect-error Raw IDs have not passed through a domain codec.
const identifiedRevision: RevisionRef = rawRevision;
declare const unknownChunk: unknown;
assertFetchedChunkPayload(unknownChunk);
const rawChunkId: string = unknownChunk._id;
// @ts-expect-error A raw shape assertion does not brand the identifier.
const identifiedChunkId: DocumentID = unknownChunk._id;
void [save, split, incomplete, identifiedRevision, rawChunkId, identifiedChunkId];

declare const localDatabase: import("@vrtmrz/livesync-commonlib").DirectFileManipulator["liveSyncLocalDB"];
void localDatabase.putDBEntry(save);
void localDatabase.putDBEntryWithLiveBaseRevision(save, "1-selected");
void localDatabase.putDBEntryAsIndependentRoot(save);

declare const stored: CurrentFileDocument;
// @ts-expect-error Stored current Metadata excludes reconstructed content.
const storedWithContent: CurrentFileDocument = { ...stored, data: ["body"] };
async function checkCoreReads() {
    const metadata: false | FileMetadataResponse = await localDatabase.getFileMetadata(path);
    const file: false | MaterialisedFile = await localDatabase.getFile(path);
    if (metadata !== false) {
        const revision: string = metadata._rev;
        if (metadata.type !== "notes") {
            // @ts-expect-error Current Metadata does not promise reconstructed content.
            metadata.data;
        }
        void revision;
    }
    if (file !== false) {
        const parts: string[] = file.data;
        const revision: string = file._rev;
        void [parts, revision];
    }
}
declare const rawMetadata: unknown;
assertRawCurrentFileMetadata(rawMetadata);
const rawMetadataId: string = rawMetadata._id;
// @ts-expect-error Shape validation does not apply identity codecs.
const metadataId: DocumentID = rawMetadata._id;
void [storedWithContent, checkCoreReads, rawMetadataId, metadataId];

void localDatabase.managers.conflictManager.tryAutoMergeSensibly(path, { _rev: "2-selected" }, ["2-other"]);
