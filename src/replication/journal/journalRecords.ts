import { type DocumentID, type EntryDoc, type EntryLeaf } from "@lib/common/types.ts";
import { escapeNewLineFromString, unescapeNewLineFromString } from "@lib/common/utils.ts";

const RECORD_SPLIT = `\n`;
const UNIT_SPLIT = `\u001f`;
const te = new TextEncoder();

export type ProcessingEntry = PouchDB.Core.PutDocument<EntryDoc> & PouchDB.Core.GetMeta;

function parseJournalRecord(value: string): ProcessingEntry {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new TypeError("Invalid Journal record");
    }
    const record = parsed as Record<string, unknown>;
    if (typeof record._id !== "string" || record._id.length === 0) {
        throw new TypeError("Invalid Journal document identifier");
    }
    if (record._id.startsWith("h:")) {
        if (record._id.length <= 2 || typeof record._rev !== "string" || typeof record.data !== "string") {
            throw new TypeError("Invalid Journal Chunk record");
        }
    } else if (typeof record._rev !== "string" || record._rev.length === 0) {
        throw new TypeError("Invalid Journal Metadata revision");
    }
    return parsed as ProcessingEntry;
}

type DecodedJournalRecord = { ok: true; doc: ProcessingEntry } | { ok: false; stage: "decode" | "parse" };

function decodeCompactJournalRecord(value: string): DecodedJournalRecord {
    const separatorIndex = value.indexOf(UNIT_SPLIT);
    if (separatorIndex === -1) {
        return { ok: false, stage: "parse" };
    }
    const idPart = value.substring(1, separatorIndex);
    if (!idPart.startsWith("h:") || idPart.length <= 2) {
        return { ok: false, stage: "parse" };
    }
    const dataPart = value.substring(separatorIndex + 1);
    return {
        ok: true,
        doc: {
            _id: idPart as DocumentID,
            data: unescapeNewLineFromString(dataPart),
            type: "leaf",
            _rev: "",
        },
    };
}

function decodeJournalRecordFrame(frame: Uint8Array, decoder: TextDecoder): DecodedJournalRecord {
    let value: string;
    try {
        value = decoder.decode(frame);
    } catch {
        return { ok: false, stage: "decode" };
    }

    if (value.startsWith("~")) {
        return decodeCompactJournalRecord(value);
    }
    try {
        return { ok: true, doc: parseJournalRecord(value) };
    } catch {
        return { ok: false, stage: "parse" };
    }
}

export function serializeDoc(doc: EntryDoc): Uint8Array {
    if (doc._id.startsWith("h:")) {
        const data = (doc as EntryLeaf).data;
        const writeData = escapeNewLineFromString(data);
        return te.encode(`~${doc._id}${UNIT_SPLIT}${writeData}${RECORD_SPLIT}`);
    }
    return te.encode(JSON.stringify(doc) + RECORD_SPLIT);
}

export function decodeJournalRecords(
    data: Uint8Array
): { ok: true; docs: ProcessingEntry[] } | { ok: false; stage: "decode" | "parse" } {
    if (data.length === 0) {
        return { ok: true, docs: [] };
    }
    if (data[data.length - 1] !== 0x0a) {
        return { ok: false, stage: "parse" };
    }

    const decoder = new TextDecoder("utf-8", { fatal: true });
    let idxFrom = 0;
    const result: ProcessingEntry[] = [];
    while (idxFrom < data.length) {
        const idxTo = data.indexOf(0x0a, idxFrom);
        if (idxTo === -1 || idxTo === idxFrom) {
            return { ok: false, stage: "parse" };
        }
        const record = decodeJournalRecordFrame(data.slice(idxFrom, idxTo), decoder);
        if (record.ok === false) {
            return record;
        }
        result.push(record.doc);
        idxFrom = idxTo + 1;
    }

    return { ok: true, docs: result };
}
