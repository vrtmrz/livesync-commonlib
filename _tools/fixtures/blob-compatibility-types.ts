import {
    createBinaryBlob,
    createBlob,
    createTextBlob,
    isDocContentSame,
    readAsBlob,
} from "@vrtmrz/livesync-commonlib/compat/common/utils";
import type { LoadedEntry } from "@vrtmrz/livesync-commonlib/compat/common/types";

const bytes = new Uint8Array([0, 128, 255]);
const text: Blob = createTextBlob(["first", "second"]);
const binary: Blob = createBinaryBlob(bytes);
const existing: Blob = createBlob(text);
const buffer: Blob = createBlob(bytes.buffer);
declare const entry: LoadedEntry;
const document: Blob = readAsBlob(entry);
type ExistingContentInput = string | string[] | Blob | ArrayBuffer;
const existingComparison: (docA: ExistingContentInput, docB: ExistingContentInput) => Promise<boolean> =
    isDocContentSame;
void [text, binary, existing, buffer, document, existingComparison];
