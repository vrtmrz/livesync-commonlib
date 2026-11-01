import { describe, expect, it } from "vitest";

import type { FilePathWithPrefix } from "@lib/common/types";
import { ContentSplitterV1 } from "./ContentSplitterV1";
import { ContentSplitterV2 } from "./ContentSplitterV2";
import { ContentSplitterRabinKarp } from "./ContentSplitterRabinKarp";

describe.each([
    ["V1", ContentSplitterV1],
    ["V2", ContentSplitterV2],
    ["RabinKarp", ContentSplitterRabinKarp],
])("ContentSplitter%s direct worker", (_name, Splitter) => {
    it.each([false, true])(
        "awaits the splitter factory before opening its generator (useWorker=%s)",
        async (useWorker) => {
            const splitter = new Splitter({ settingService: {} as never });

            const generator = await splitter.processSplit({
                blob: new Blob(["alpha\nbeta"], { type: "text/plain" }),
                path: "note.md" as FilePathWithPrefix,
                pieceSize: 100,
                plainSplit: true,
                minimumChunkSize: 1,
                useWorker,
                useSegmenter: false,
            });
            const chunks: string[] = [];
            for await (const chunk of generator) chunks.push(chunk);

            expect(chunks.join("")).toContain("alpha");
            expect(chunks.join("")).toContain("beta");
        }
    );
});
