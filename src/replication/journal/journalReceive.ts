import type { EntryDoc } from "@lib/common/types.ts";
import type { ProcessingEntry } from "./journalRecords.ts";

type ChunkReadRow = { id?: string; error?: string };
type WriteResult = PouchDB.Core.Error | PouchDB.Core.Response;

export function partitionJournalDocuments(entries: readonly ProcessingEntry[]) {
    const chunks: ProcessingEntry[] = [];
    const docs: ProcessingEntry[] = [];
    for (const entry of entries) {
        (entry._id.startsWith("h:") ? chunks : docs).push(entry);
    }
    return { chunks, docs };
}

/** Chunks have stable content, so only absent identifiers need a new local revision. */
export function selectChunksToSave(
    chunks: readonly ProcessingEntry[],
    rows: readonly ChunkReadRow[]
): PouchDB.Core.PutDocument<EntryDoc>[] {
    if (rows.some((row) => "error" in row && row.error !== "not_found")) {
        throw new Error("Could not inspect existing Chunks");
    }
    const existingIDs = new Set(rows.map((row) => row.id).filter((id): id is string => id !== undefined));
    return chunks
        .filter((entry) => !existingIDs.has(entry._id))
        .map((entry) => ({ ...entry, _rev: undefined as string | undefined }));
}

export function hasJournalWriteErrors(results: readonly WriteResult[]): boolean {
    return results.some((row) => "error" in row);
}

/** Report persisted Chunks even when another row failed, but require every requested Chunk for completion. */
export function assessChunkWrites<T extends PouchDB.Core.PutDocument<EntryDoc>>(
    chunks: readonly T[],
    results: readonly WriteResult[]
) {
    const persistedIDs = new Set(results.filter((row) => !("error" in row)).map((row) => row.id));
    return {
        persisted: chunks.filter((entry) => persistedIDs.has(entry._id)),
        failed: hasJournalWriteErrors(results) || chunks.some((entry) => !persistedIDs.has(entry._id)),
    };
}

export function journalMetadataRevisions(docs: readonly ProcessingEntry[]): PouchDB.Core.RevisionDiffOptions {
    return docs.reduce(
        (revisions, entry) => ({ ...revisions, [entry._id]: [...(revisions[entry._id] ?? []), entry._rev] }),
        {} as PouchDB.Core.RevisionDiffOptions
    );
}

/** Retain complete transferred Metadata, including revision ancestry, for each missing revision. */
export function selectMetadataToSave(docs: readonly ProcessingEntry[], diff: PouchDB.Core.RevisionDiffResponse) {
    return docs.filter(
        (entry) =>
            entry._id in diff &&
            "missing" in diff[entry._id] &&
            (diff[entry._id].missing?.indexOf(entry._rev) ?? 0) !== -1
    );
}
