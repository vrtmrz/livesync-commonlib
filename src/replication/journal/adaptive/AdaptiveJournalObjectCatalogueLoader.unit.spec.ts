import { describe, expect, it } from "vitest";

import { AdaptiveJournalCatalogueV1, adaptiveJournalPackObjectKeyV1 } from "./AdaptiveJournalCatalogue.ts";
import { createAdaptiveJournalManifestV1 } from "./AdaptiveJournalManifest.ts";
import {
    ADAPTIVE_JOURNAL_NOOP_CATALOGUE_LOADER_V1,
    createAdaptiveJournalObjectCatalogueLoaderV1,
} from "./AdaptiveJournalObjectCatalogueLoader.ts";
import { buildAdaptiveJournalPackV1 } from "./AdaptiveJournalPack.ts";
import { AdaptiveRecordKindV1, encodeRecordFrameV1 } from "./AdaptiveJournalRecord.ts";

function sequence(start: number): Uint8Array {
    return Uint8Array.from({ length: 32 }, (_, index) => (start + index) & 0xff);
}

describe("Adaptive Journal object catalogue loader", () => {
    it("rejects object routes when the native no-op loader is selected", async () => {
        await expect(
            ADAPTIVE_JOURNAL_NOOP_CATALOGUE_LOADER_V1.load({
                chunkPacks: [
                    {
                        container: "pack",
                        entries: [],
                        objectKey: "a1~pack~invalid.pack",
                        packBytes: 1,
                        packId: sequence(0x20),
                    },
                ],
                requiredChunkKeys: [],
                sequence: 1n,
                writerStreamId: sequence(0x40),
            })
        ).resolves.toEqual({ failure: { category: "invalid-response", retry: "never" }, status: "failed" });
    });

    it("derives catalogue locations from an authenticated Commit Bundle route without remote reads", async () => {
        const candidate = await createAdaptiveJournalManifestV1({
            encryption: "unencrypted",
            repositoryId: sequence(0x10),
            securitySeed: sequence(0x80),
        });
        const chunkKey = sequence(0x40);
        const chunk = await encodeRecordFrameV1({
            keys: candidate.keys,
            kind: AdaptiveRecordKindV1.Chunk,
            logicalKey: chunkKey,
            plaintext: new TextEncoder().encode("body"),
        });
        const pack = await buildAdaptiveJournalPackV1({
            chunks: [{ frame: chunk.bytes, key: chunkKey }],
            keys: candidate.keys,
        });
        const route = {
            container: "pack" as const,
            entries: pack.entries,
            objectKey: adaptiveJournalPackObjectKeyV1(pack.packId),
            packBytes: pack.packBytes.byteLength,
            packId: pack.packId,
        };
        const catalogue = new AdaptiveJournalCatalogueV1();
        const loader = createAdaptiveJournalObjectCatalogueLoaderV1({ catalogue });

        await expect(
            loader.load({
                chunkPacks: [route],
                requiredChunkKeys: [chunkKey],
                sequence: 2n,
                writerStreamId: sequence(0x50),
            })
        ).resolves.toEqual({ status: "ok" });
        expect(catalogue.locations(chunkKey)).toEqual([
            expect.objectContaining({ objectKey: route.objectKey, packId: pack.packId }),
        ]);

        await expect(
            loader.load({
                chunkPacks: [route],
                requiredChunkKeys: [chunkKey],
                sequence: 3n,
                writerStreamId: sequence(0x50),
            })
        ).resolves.toEqual({ status: "ok" });
        expect(catalogue.locations(chunkKey)).toHaveLength(1);

        await expect(
            loader.load({
                chunkPacks: [],
                requiredChunkKeys: [chunkKey],
                sequence: 4n,
                writerStreamId: sequence(0x50),
            })
        ).resolves.toEqual({ failure: { category: "invalid-response", retry: "never" }, status: "failed" });
    });
});
