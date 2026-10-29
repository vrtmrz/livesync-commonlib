import { ChunkAlgorithms } from "@lib/common/types.ts";
import { splitPiecesRabinKarp } from "@lib/string_and_binary/chunks.ts";
import { splitPieces2WorkerRabinKarp } from "#worker";
import type { ContentSplitterOptions, SplitOptions } from "./ContentSplitter.ts";
import { ContentSplitterBase } from "./ContentSplitterBase.ts";
/**
 * Rabin-Karp content splitter for efficient chunking
 */
export class ContentSplitterRabinKarp extends ContentSplitterBase {
    static override isAvailableFor(setting: ContentSplitterOptions): boolean {
        const settings = setting.settingService.currentSettings();
        return settings.chunkSplitterVersion === ChunkAlgorithms.RabinKarp;
    }
    async processSplit(
        options: SplitOptions
    ): Promise<AsyncGenerator<string, void, unknown> | Generator<string, void, unknown>> {
        const split = options.useWorker ? splitPieces2WorkerRabinKarp : splitPiecesRabinKarp;
        return (
            await split(options.blob, options.pieceSize, options.plainSplit, options.minimumChunkSize, options.path)
        )();
    }
}
