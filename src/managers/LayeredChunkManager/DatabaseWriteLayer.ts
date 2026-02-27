import { LiveSyncError } from "../../common/LSError";
import type { EntryLeaf, DocumentID } from "../../common/types";
import type { IWriteLayer } from "./ChunkLayerInterfaces";
import type { ChunkWriteOptions, WriteResult } from "./types.ts";

/**
 * Database write layer - writes chunks to the database
 */

export class DatabaseWriteLayer implements IWriteLayer {
    constructor(private database: PouchDB.Database<any>) {}

    async write(
        chunks: EntryLeaf[],
        options: ChunkWriteOptions | undefined = undefined,
        origin: DocumentID,
        next: (remaining: EntryLeaf[]) => Promise<WriteResult>
    ): Promise<WriteResult> {
        if (chunks.length === 0) {
            return next([]);
        }

        try {
            const result = await this.database.bulkDocs(chunks, { new_edits: !options?.force });
            const failed = result.filter((res) => "error" in res) as PouchDB.Core.Error[];

            // Check for non-409 errors
            if (failed.some((res) => res.status !== 409)) {
                throw new LiveSyncError(`Failed to write chunks: ${failed.map((res) => res.error).join(", ")}`, {
                    status: 500,
                });
            }

            // Handle 409 conflicts
            const conflictedChunkIDs = failed
                .filter((res) => typeof res.id === "string")
                .map((res) => res.id as DocumentID);

            // Pass chunks to next layer (e.g., CacheLayer)
            const nextResult = await next(chunks);

            // Merge results
            const writeResult: WriteResult = {
                result: true,
                processed: {
                    cached: nextResult.processed.cached,
                    hotPack: nextResult.processed.hotPack,
                    written: result.length - failed.length,
                    duplicated: conflictedChunkIDs.length,
                },
            };

            if (conflictedChunkIDs.length > 0) {
                // TODO: Handle conflict resolution if needed
            }

            return writeResult;
        } catch (error) {
            if (error instanceof LiveSyncError) {
                throw error;
            }
            throw new LiveSyncError(`Database write layer error: ${error}`, { status: 500, cause: error as Error });
        }
    }
}
