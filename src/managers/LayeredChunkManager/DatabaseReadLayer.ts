import { ContentReadError } from "@lib/common/LSError";
import type { EntryLeaf, DocumentID, EntryDoc } from "@lib/common/types";
import type { IReadLayer } from "./ChunkLayerInterfaces";
import type { ChunkReadOptions } from "./types.ts";

/**
 * Database read layer - reads chunks from the database
 */

export class DatabaseReadLayer implements IReadLayer {
    constructor(private database: PouchDB.Database<EntryDoc>) {}

    private isChunkDoc(doc: EntryDoc): doc is EntryLeaf {
        return doc && typeof doc._id === "string" && doc.type === "leaf";
    }

    private isMissingError(error: unknown): boolean {
        if (typeof error !== "object" || error === null) {
            return false;
        }
        if ("status" in error && error.status === 404) {
            return true;
        }
        if ("error" in error && error.error === "not_found") {
            return true;
        }
        return false;
    }

    async read(
        ids: DocumentID[],
        options: ChunkReadOptions,
        next: (remaining: DocumentID[]) => Promise<(EntryLeaf | false)[]>
    ): Promise<(EntryLeaf | false)[]> {
        if (ids.length === 0) {
            return [];
        }

        const resultMap = new Map<DocumentID, EntryLeaf | false>();
        const remainingIds: DocumentID[] = [];

        let results: PouchDB.Core.AllDocsWithKeysResponse<EntryDoc>;
        try {
            results = await this.database.allDocs({ keys: ids, include_docs: true });
        } catch (error) {
            const localFailure = new ContentReadError({
                documentId: ids[0],
                resources: ["local-database"],
                cause: error,
            });
            try {
                const fallback = await next(ids);
                if (fallback.every(Boolean)) {
                    return fallback;
                }
            } catch (fallbackError) {
                const resources = fallbackError instanceof ContentReadError ? fallbackError.failure.resources : [];
                throw new ContentReadError({
                    documentId: ids[0],
                    resources: resources.length === 0 ? [] : [...new Set(["local-database" as const, ...resources])],
                    cause: new AggregateError([error, fallbackError], "Local and fallback Chunk reads failed"),
                });
            }
            throw localFailure;
        }

        for (const row of results.rows) {
            if ("doc" in row && row.doc && this.isChunkDoc(row.doc)) {
                const chunk = row.doc;
                resultMap.set(chunk._id, chunk);
            } else if (!this.isMissingError(row)) {
                throw new ContentReadError({ documentId: row.key as DocumentID, resources: [], cause: row });
            } else {
                const idFromRow = typeof row.key === "string" ? (row.key as DocumentID) : undefined;
                if (idFromRow) {
                    remainingIds.push(idFromRow);
                }
            }
        }

        // If all chunks were found, return immediately
        if (remainingIds.length === 0) {
            return ids.map((id) => resultMap.get(id) ?? false);
        }

        // Get remaining chunks from next layer
        const nextResults = await next(remainingIds);
        const nextResultMap = new Map(remainingIds.map((id, index) => [id, nextResults[index]]));

        // Merge results
        const mergedResults = [...ids.map((id) => resultMap.get(id) ?? nextResultMap.get(id) ?? false)];
        // console.log("DatabaseReadLayer: Merged results for read", { ids, mergedResults });
        return mergedResults;
    }
}
