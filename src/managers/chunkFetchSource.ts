import type { DocumentID, EntryDoc, EntryLeaf } from "@lib/common/types.ts";

/** IO supplied by a host whose chunk source does not use the active replicator. */
export interface ChunkFetchSource {
    /** Missing identifiers are omitted; false means that this request could not retrieve chunks. */
    fetchChunks(ids: DocumentID[]): Promise<EntryLeaf[] | false>;
    /** Accept fetched chunks before notifying waiting readers. */
    storeChunks(chunks: EntryLeaf[]): Promise<void>;
}

/**
 * Read through the prepared direct database, including its decryption transforms.
 * The source already owns these documents, so accepting them performs no write.
 * Construct a new source for each database lifetime.
 */
export function createDirectChunkFetchSource(database: PouchDB.Database<EntryDoc>): ChunkFetchSource {
    return {
        async fetchChunks(ids) {
            const result = await database.allDocs({ keys: ids, include_docs: true });
            return result.rows.flatMap((row) => "doc" in row && row.doc ? [row.doc as EntryLeaf] : []);
        },
        storeChunks: () => Promise.resolve(),
    };
}
