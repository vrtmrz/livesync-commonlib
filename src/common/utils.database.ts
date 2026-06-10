import { isPlainText } from "@lib/string_and_binary/path.ts";
import { arrayBufferToBase64Single, decodeBinary, writeString } from "@lib/string_and_binary/convert.ts";
import type { AnyEntry, DatabaseEntry, EntryLeaf, SyncInfo, LoadedEntry, SavingEntry, NewEntry, PlainEntry } from "@lib/common/models/db.type";
import { PREFIX_ENCRYPTED_CHUNK, PREFIX_OBFUSCATED } from "@lib/common/models/shared.const.behabiour";
import { SYNCINFO_ID } from "@lib/common/models/db.const";
import { concatUInt8Array } from "octagonal-wheels/binary";
import { BASE_IS_NEW, EVEN, TARGET_IS_NEW } from "./models/shared.const.symbols.ts";
import { compatGlobal } from "./coreEnvFunctions";

export function getDocData(doc: string | string[]) {
    return typeof doc == "string" ? doc : doc.join("");
}
export function getDocDataAsArray(doc: string | string[]) {
    return typeof doc == "string" ? [doc] : doc;
}

export function getDocDataAsArrayBuffer(doc: string | string[] | ArrayBuffer) {
    if (doc instanceof ArrayBuffer) return new Uint8Array(doc);
    const docData = getDocDataAsArray(doc);
    const s = docData.map((e) => writeString(e));
    return concatUInt8Array(s);
}

export function isTextBlob(blob: Blob) {
    return blob.type === "text/plain";
}
export function createTextBlob(data: string | string[]) {
    const d = Array.isArray(data) ? data : [data];
    return new Blob(d, { endings: "transparent", type: "text/plain" });
}
export function createBinaryBlob(data: Uint8Array<ArrayBuffer> | ArrayBuffer) {
    return new Blob([data], { endings: "transparent", type: "application/octet-stream" });
}
export function createBlob(data: string | string[] | Uint8Array<ArrayBuffer> | ArrayBuffer | Blob) {
    if (data instanceof Blob) return data;
    if (data instanceof Uint8Array || data instanceof ArrayBuffer) return createBinaryBlob(data);
    return createTextBlob(data);
}

export function isTextDocument(doc: LoadedEntry) {
    if (doc.type == "plain") return true;
    if (doc.datatype == "plain") return true;
    if (isPlainText(doc.path)) return true;
    return false;
}

export function readAsBlob(doc: LoadedEntry) {
    if (isTextDocument(doc)) {
        return createTextBlob(doc.data);
    } else {
        return createBinaryBlob(decodeBinary(doc.data));
    }
}
export function readContent(doc: LoadedEntry) {
    if (isTextDocument(doc)) {
        return getDocData(doc.data);
    } else {
        return decodeBinary(doc.data);
    }
}

const isIndexDBCmpExist = typeof compatGlobal?.indexedDB?.cmp !== "undefined";

export async function isDocContentSame(
    docA: string | string[] | Blob | ArrayBuffer,
    docB: string | string[] | Blob | ArrayBuffer
) {
    const blob1 = createBlob(docA);
    const blob2 = createBlob(docB);
    if (blob1.size != blob2.size) return false;
    if (isIndexDBCmpExist) {
        return compatGlobal.indexedDB.cmp(await blob1.arrayBuffer(), await blob2.arrayBuffer()) === 0;
    }
    const checkQuantum = 10000;
    const length = blob1.size;

    let i = 0;

    while (i < length) {
        const ab1 = await blob1.slice(i, i + checkQuantum).arrayBuffer();
        const ab2 = await blob2.slice(i, i + checkQuantum).arrayBuffer();
        i += checkQuantum;
        if ((await arrayBufferToBase64Single(ab1)) != (await arrayBufferToBase64Single(ab2))) return false;
    }
    return true;
}

export function isObfuscatedEntry(doc: DatabaseEntry): doc is AnyEntry {
    if (doc._id.startsWith(PREFIX_OBFUSCATED)) {
        return true;
    }
    return false;
}

export function isEncryptedChunkEntry(doc: DatabaseEntry): doc is EntryLeaf {
    if (doc._id.startsWith(PREFIX_ENCRYPTED_CHUNK)) {
        return true;
    }
    return false;
}

export function isSyncInfoEntry(doc: DatabaseEntry): doc is SyncInfo {
    if (doc._id == SYNCINFO_ID) {
        return true;
    }
    return false;
}

export function determineTypeFromBlob(data: Blob): "newnote" | "plain" {
    return isTextBlob(data) ? "plain" : "newnote";
}
export function determineType(
    path: string,
    data: string | string[] | Uint8Array | ArrayBuffer | Blob
): "newnote" | "plain" {
    if (data instanceof Blob) {
        return determineTypeFromBlob(data);
    }
    if (isPlainText(path)) return "plain";
    if (data instanceof Uint8Array) return "newnote";
    if (data instanceof ArrayBuffer) return "newnote";
    // string | string[]
    return "plain";
}

export function isAnyNote(doc: DatabaseEntry): doc is NewEntry | PlainEntry {
    return "type" in doc && (doc.type == "newnote" || doc.type == "plain");
}
export function isLoadedEntry(doc: DatabaseEntry): doc is LoadedEntry {
    return "type" in doc && (doc.type == "newnote" || doc.type == "plain") && "data" in doc;
}

export function isDeletedEntry(doc: LoadedEntry): boolean {
    return doc._deleted || doc.deleted || false;
}
export function createSavingEntryFromLoadedEntry(doc: LoadedEntry): SavingEntry {
    const data = readAsBlob(doc);
    const type = determineType(doc.path, data);
    return {
        ...doc,
        data: data,
        datatype: type,
        type,
        children: [],
    };
}

const resolution = 2000;
export function compareMTime(
    baseMTime: number,
    targetMTime: number
): typeof BASE_IS_NEW | typeof TARGET_IS_NEW | typeof EVEN {
    const truncatedBaseMTime = ~~(baseMTime / resolution) * resolution;
    const truncatedTargetMTime = ~~(targetMTime / resolution) * resolution;
    if (truncatedBaseMTime == truncatedTargetMTime) return EVEN;
    if (truncatedBaseMTime > truncatedTargetMTime) return BASE_IS_NEW;
    if (truncatedBaseMTime < truncatedTargetMTime) return TARGET_IS_NEW;
    throw new Error("Unexpected error");
}
