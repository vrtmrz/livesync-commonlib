import { ChunkAlgorithms } from "../../common/types";
import { splitPieces2V2 } from "../../string_and_binary/chunks";
import { splitPieces2WorkerV2 } from "../../worker/bgWorker";
import type { ContentSplitterOptions, SplitOptions } from "./ContentSplitter";
import { ContentSplitterBase } from "./ContentSplitterBase";

/**
 * Content splitter for version 2, which supports segmenter-based splitting.
 */
export class ContentSplitterV2 extends ContentSplitterBase {
    static isAvailableFor(setting: ContentSplitterOptions): boolean {
        return (
            setting.settings.chunkSplitterVersion === ChunkAlgorithms.V2 ||
            setting.settings.chunkSplitterVersion === ChunkAlgorithms.V2Segmenter
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
