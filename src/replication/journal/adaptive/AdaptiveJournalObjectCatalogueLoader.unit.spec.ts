import { describe, expect, it } from "vitest";

import { AdaptiveJournalCatalogueV1 } from "./AdaptiveJournalCatalogue.ts";
import { createAdaptiveJournalManifestV1 } from "./AdaptiveJournalManifest.ts";
import { createAdaptiveJournalObjectCatalogueLoaderV1 } from "./AdaptiveJournalObjectCatalogueLoader.ts";
import type { AdaptiveJournalObjectListV1, AdaptiveJournalObjectRemoteV1 } from "./AdaptiveJournalObjectStore.ts";
import { publishAdaptiveJournalPackV1 } from "./AdaptiveJournalObjectRepository.ts";
import { buildAdaptiveJournalPackV1 } from "./AdaptiveJournalPack.ts";
import type { ImmutableCreate, RemoteRead } from "./AdaptiveJournalRepository.ts";
import { AdaptiveRecordKindV1, encodeRecordFrameV1 } from "./AdaptiveJournalRecord.ts";

function sequence(start: number): Uint8Array {
    return Uint8Array.from({ length: 32 }, (_, index) => (start + index) & 0xff);
}

class MemoryRemote implements AdaptiveJournalObjectRemoteV1 {
    readonly objects = new Map<string, Uint8Array>();
    readonly reads: string[] = [];

    async createAdaptiveObject(key: string, bytes: Uint8Array): Promise<ImmutableCreate> {
        if (this.objects.has(key)) return { status: "already-exists" };
        this.objects.set(key, bytes.slice());
        return { status: "created" };
    }

    async listAdaptiveObjects(prefix: string): Promise<AdaptiveJournalObjectListV1> {
        return { keys: [...this.objects.keys()].filter((key) => key.startsWith(prefix)), status: "ok" };
    }

    async readAdaptiveObject(key: string): Promise<RemoteRead<Uint8Array>> {
        this.reads.push(key);
        const value = this.objects.get(key);
        return value ? { status: "found", value: value.slice() } : { status: "missing" };
    }
}

describe("Adaptive Journal object catalogue loader", () => {
    it("authenticates Delta and Index without downloading the Pack", async () => {
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
        const remote = new MemoryRemote();
        const writerStreamId = sequence(0x30);
        const published = await publishAdaptiveJournalPackV1({
            keys: candidate.keys,
            pack,
            remote,
            sequence: 1n,
            writerStreamId,
        });
        if (published.status !== "ok") throw new Error("Pack publication failed");
        remote.reads.length = 0;
        const catalogue = new AdaptiveJournalCatalogueV1();
        const loader = createAdaptiveJournalObjectCatalogueLoaderV1({ catalogue, keys: candidate.keys, remote });
        const consumerWriterStreamId = sequence(0x50);

        await expect(
            loader.load({
                dependencies: [{ digest: published.deltaDigest, key: published.deltaKey }],
                sequence: 2n,
                writerStreamId: consumerWriterStreamId,
            })
        ).resolves.toEqual({ status: "ok" });
        expect(catalogue.locations(chunkKey)).toEqual([
            expect.objectContaining({
                catalogueDependency: {
                    digest: published.deltaDigest,
                    key: published.deltaKey,
                },
            }),
        ]);
        expect(remote.reads).toEqual([published.deltaKey, published.indexKey]);

        remote.reads.length = 0;
        await expect(
            loader.load({
                dependencies: [{ digest: published.deltaDigest, key: published.deltaKey }],
                sequence: 3n,
                writerStreamId: consumerWriterStreamId,
            })
        ).resolves.toEqual({ status: "ok" });
        expect(remote.reads).toEqual([]);
    });
});
