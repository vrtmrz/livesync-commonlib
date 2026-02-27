import type { EntryLeaf, DocumentID } from "../../common/types";
import type { IWriteLayer } from "./ChunkLayerInterfaces";
import type { ChunkWriteOptions, WriteResult } from "./types.ts";

/**
 * Hot pack layer - placeholder for hot pack processing
 */

export class HotPackLayer implements IWriteLayer {
    write(
        chunks: EntryLeaf[],
        options: ChunkWriteOptions,
        origin: DocumentID,
        next: (remaining: EntryLeaf[]) => Promise<WriteResult>
    ): Promise<WriteResult> {
        // TODO: Implement hot pack processing
        // For now, just pass through
        return next(chunks);
    }
}
