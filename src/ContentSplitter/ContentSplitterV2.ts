import { ChunkAlgorithms } from "../common/types.ts";
import { splitPieces2V2 } from "../string_and_binary/chunks.ts";
import { splitPieces2WorkerV2 } from "@lib/worker/bgWorker.ts";
import type { ContentSplitterOptions, SplitOptions } from "./ContentSplitter.ts";
import { ContentSplitterBase } from "./ContentSplitterBase.ts";

/**
 * Content splitter for version 2, which supports segmenter-based splitting.
 */
export class ContentSplitterV2 extends ContentSplitterBase {
    static override isAvailableFor(setting: ContentSplitterOptions): boolean {
        const settings = setting.settingService.currentSettings();
        return (
            settings.chunkSplitterVersion === ChunkAlgorithms.V2 ||
            settings.chunkSplitterVersion === ChunkAlgorithms.V2Segmenter
        );
    }
    async processSplit(
        options: SplitOptions
    ): Promise<AsyncGenerator<string, void, unknown> | Generator<string, void, unknown>> {
        if (options.useWorker) {
            return splitPieces2WorkerV2(
                options.blob,
                options.pieceSize,
                options.plainSplit,
                options.minimumChunkSize,
                options.path,
                options.useSegmenter
            )();
        } else {
            return (
                await splitPieces2V2(
                    options.blob,
                    options.pieceSize,
                    options.plainSplit,
                    options.minimumChunkSize,
                    options.path,
                    options.useSegmenter
                )
            )();
        }
    }
}
