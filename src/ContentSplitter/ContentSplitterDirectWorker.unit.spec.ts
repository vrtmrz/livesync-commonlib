import { describe, expect, it } from "vitest";

import type { FilePathWithPrefix } from "@lib/common/types";
import { ContentSplitterV1 } from "./ContentSplitterV1";
import { ContentSplitterV2 } from "./ContentSplitterV2";

describe.each([
    ["V1", ContentSplitterV1],
    ["V2", ContentSplitterV2],
])("ContentSplitter%s direct worker", (_name, Splitter) => {
    it("awaits the direct splitter factory before opening its generator", async () => {
        const splitter = new Splitter({ settingService: {} as never });

        const generator = await splitter.processSplit({
            blob: new Blob(["alpha\nbeta"], { type: "text/plain" }),
            path: "note.md" as FilePathWithPrefix,
            pieceSize: 100,
            plainSplit: true,
            minimumChunkSize: 1,
            useWorker: true,
            useSegmenter: false,
        });
        const chunks: string[] = [];
        for await (const chunk of generator) chunks.push(chunk);

        expect(chunks.join("")).toContain("alpha");
        expect(chunks.join("")).toContain("beta");
    });
});
