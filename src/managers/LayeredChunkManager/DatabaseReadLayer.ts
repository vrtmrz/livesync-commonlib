import { Logger, LOG_LEVEL_VERBOSE } from "octagonal-wheels/common/logger";
import { LiveSyncError } from "../../common/LSError";
import type { EntryLeaf, DocumentID } from "../../common/types";
import type { IReadLayer } from "./ChunkLayerInterfaces";
import type { ChunkReadOptions } from "./types.ts";

/**
 * Database read layer - reads chunks from the database
 */

export class DatabaseReadLayer implements IReadLayer {
    constructor(private database: PouchDB.Database<any>) {}

    private isChunkDoc(doc: any): doc is EntryLeaf {
        return doc && typeof doc._id === "string" && doc.type === "leaf";
    }

    private getError(error: any) {
        if (error instanceof Error) {
            return error;
        }
        if ("error" in error && error.error instanceof Error) {
            return error.error;
        }
        return undefined;
    }

    private isMissingError(error: any): boolean {
        if ("status" in error && error.status === 404) {
            return true;
        }
        if ("error" in error && error.error === "not_found") {
            return true;
        }
        if ("error" in error) {
            return this.isMissingError(error.error);
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

        try {
            const results = await this.database.allDocs({ keys: ids, include_docs: true });

            for (const row of results.rows) {
                if ("doc" in row && row.doc && this.isChunkDoc(row.doc)) {
                    const chunk = row.doc;
                    resultMap.set(chunk._id, chunk);
                } else if (!this.isMissingError(row)) {
                    throw new LiveSyncError(`Failed to read chunk ${row.key}`, {
                        status: 404,
                        cause: this.getError(row),
                    });
                } else {
                    const idFromRow = typeof row.key === "string" ? (row.key as DocumentID) : undefined;
                    if (idFromRow) {
                        remainingIds.push(idFromRow);
                    }
                }
            }
        } catch (error) {
            if (error instanceof LiveSyncError) {
                throw error;
            }
            // For other errors, treat as database read failure
            Logger(`Database read error: ${error}`, LOG_LEVEL_VERBOSE);
            return ids.map(() => false);
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
