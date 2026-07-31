import type { DocumentID } from "@lib/common/types.ts";
import { describe, expect, it } from "vitest";

import {
    AdaptiveJournalCatalogueV1,
    adaptiveJournalCommitObjectKeyV1,
    adaptiveJournalPackObjectKeyV1,
} from "./AdaptiveJournalCatalogue.ts";
import { createAdaptiveJournalManifestV1 } from "./AdaptiveJournalManifest.ts";
import { publishAdaptiveJournalObjectChunksV1 } from "./AdaptiveJournalObjectChunkPublication.ts";
import type { AdaptiveJournalObjectListV1, AdaptiveJournalObjectRemoteV1 } from "./AdaptiveJournalObjectStore.ts";
import { encodeAdaptiveJournalChunkRecordV1 } from "./AdaptiveJournalPayload.ts";
import type { ImmutableCreate, RemoteRead } from "./AdaptiveJournalRepository.ts";

function sequence(start: number): Uint8Array {
    return Uint8Array.from({ length: 32 }, (_, index) => (start + index) & 0xff);
}

class MemoryObjectRemote implements AdaptiveJournalObjectRemoteV1 {
    readonly objects = new Map<string, Uint8Array>();

    async createAdaptiveObject(key: string, bytes: Uint8Array): Promise<ImmutableCreate> {
        if (this.objects.has(key)) return { status: "already-exists" };
        this.objects.set(key, bytes.slice());
        return { status: "created" };
    }

    async listAdaptiveObjects(prefix: string): Promise<AdaptiveJournalObjectListV1> {
        return { keys: [...this.objects.keys()].filter((key) => key.startsWith(prefix)).sort(), status: "ok" };
    }

    async readAdaptiveObject(key: string): Promise<RemoteRead<Uint8Array>> {
        const value = this.objects.get(key);
        return value ? { status: "found", value: value.slice() } : { status: "missing" };
    }
}

describe("Adaptive Journal object Chunk publication", () => {
    it("packs only Chunks absent from the committed catalogue", async () => {
        const candidate = await createAdaptiveJournalManifestV1({
            encryption: "unencrypted",
            repositoryId: sequence(0x10),
            securitySeed: sequence(0x80),
        });
        const first = await encodeAdaptiveJournalChunkRecordV1({
            data: "first",
            keys: candidate.keys,
            localChunkId: "h:first" as DocumentID,
        });
        const second = await encodeAdaptiveJournalChunkRecordV1({
            data: "second",
            keys: candidate.keys,
            localChunkId: "h:second" as DocumentID,
        });
        const catalogue = new AdaptiveJournalCatalogueV1();
        const firstPackId = sequence(0xa0);
        const firstRoute = {
            container: "pack" as const,
            entries: [
                {
                    frameDigest: first.digest,
                    frameLength: first.bytes.byteLength,
                    key: first.remoteChunkKey,
                    offset: 0,
                },
            ],
            objectKey: adaptiveJournalPackObjectKeyV1(firstPackId),
            packBytes: first.bytes.byteLength,
            packId: firstPackId,
        };
        catalogue.applyCommittedPack(firstRoute);
        const remote = new MemoryObjectRemote();

        const result = await publishAdaptiveJournalObjectChunksV1({
            catalogue,
            items: [
                { localChunkId: "h:first" as DocumentID, record: first },
                { localChunkId: "h:second" as DocumentID, record: second },
            ],
            keys: candidate.keys,
            remote,
            sequence: 1n,
            writerStreamId: sequence(0x30),
        });

        expect(result.status).toBe("ok");
        if (result.status !== "ok") return;
        expect(result.requiredChunkKeys).toEqual([first.remoteChunkKey, second.remoteChunkKey]);
        expect(result.chunkPacks).toEqual(
            expect.arrayContaining([
                firstRoute,
                expect.objectContaining({
                    container: "bundle",
                    objectKey: adaptiveJournalCommitObjectKeyV1(sequence(0x30), 1n),
                }),
            ])
        );
        expect(result.inlinePack).toBeInstanceOf(Uint8Array);
        expect(result.committedPackCandidates).toHaveLength(1);
        expect(result.committedPackCandidates[0].entries.map(({ key }) => key)).toEqual([second.remoteChunkKey]);
        expect(remote.objects.size).toBe(0);
    });

    it("reuses an authenticated Pack route without a remote request", async () => {
        const candidate = await createAdaptiveJournalManifestV1({
            encryption: "unencrypted",
            repositoryId: sequence(0x11),
            securitySeed: sequence(0x81),
        });
        const chunk = await encodeAdaptiveJournalChunkRecordV1({
            data: "body",
            keys: candidate.keys,
            localChunkId: "h:chunk" as DocumentID,
        });
        const catalogue = new AdaptiveJournalCatalogueV1();
        const packId = sequence(0xa1);
        const route = {
            container: "pack" as const,
            entries: [
                {
                    frameDigest: chunk.digest,
                    frameLength: chunk.bytes.byteLength,
                    key: chunk.remoteChunkKey,
                    offset: 0,
                },
            ],
            objectKey: adaptiveJournalPackObjectKeyV1(packId),
            packBytes: chunk.bytes.byteLength,
            packId,
        };
        catalogue.applyCommittedPack(route);
        const remote = new MemoryObjectRemote();

        await expect(
            publishAdaptiveJournalObjectChunksV1({
                catalogue,
                items: [{ localChunkId: "h:chunk" as DocumentID, record: chunk }],
                keys: candidate.keys,
                remote,
                sequence: 2n,
                writerStreamId: sequence(0x31),
            })
        ).resolves.toMatchObject({ chunkPacks: [route], status: "ok" });
        expect(remote.objects.size).toBe(0);
    });

    it("publishes one external Pack when the inline threshold is exceeded", async () => {
        const candidate = await createAdaptiveJournalManifestV1({
            encryption: "unencrypted",
            repositoryId: sequence(0x12),
            securitySeed: sequence(0x82),
        });
        const chunk = await encodeAdaptiveJournalChunkRecordV1({
            data: "external",
            keys: candidate.keys,
            localChunkId: "h:external" as DocumentID,
        });
        const remote = new MemoryObjectRemote();
        const result = await publishAdaptiveJournalObjectChunksV1({
            catalogue: new AdaptiveJournalCatalogueV1(),
            inlinePackMaxBytes: 0,
            items: [{ localChunkId: "h:external" as DocumentID, record: chunk }],
            keys: candidate.keys,
            remote,
            sequence: 1n,
            writerStreamId: sequence(0x32),
        });

        expect(result).toMatchObject({
            chunkPacks: [expect.objectContaining({ container: "pack" })],
            status: "ok",
        });
        expect(remote.objects.size).toBe(1);
        expect([...remote.objects.keys()][0]).toMatch(/^a1~pack~/u);
    });

    it("partitions a publication which exceeds one Pack", async () => {
        const candidate = await createAdaptiveJournalManifestV1({
            encryption: "unencrypted",
            repositoryId: sequence(0x14),
            securitySeed: sequence(0x84),
        });
        const first = await encodeAdaptiveJournalChunkRecordV1({
            data: "first partition",
            keys: candidate.keys,
            localChunkId: "h:partition-first" as DocumentID,
        });
        const second = await encodeAdaptiveJournalChunkRecordV1({
            data: "second partition",
            keys: candidate.keys,
            localChunkId: "h:partition-second" as DocumentID,
        });
        const remote = new MemoryObjectRemote();
        const result = await publishAdaptiveJournalObjectChunksV1({
            catalogue: new AdaptiveJournalCatalogueV1(),
            items: [
                { localChunkId: "h:partition-first" as DocumentID, record: first },
                { localChunkId: "h:partition-second" as DocumentID, record: second },
            ],
            keys: candidate.keys,
            packMaxBytes: Math.max(first.bytes.byteLength, second.bytes.byteLength),
            remote,
            sequence: 1n,
            writerStreamId: sequence(0x34),
        });

        expect(result.status).toBe("ok");
        if (result.status !== "ok") return;
        expect(result.chunkPacks).toHaveLength(2);
        expect(result.chunkPacks.every(({ container }) => container === "pack")).toBe(true);
        expect(result.committedPackCandidates).toHaveLength(2);
        expect(result.inlinePack).toBeUndefined();
        expect(remote.objects.size).toBe(2);
    });

    it("rejects an inline threshold which the Commit Bundle cannot encode", async () => {
        const candidate = await createAdaptiveJournalManifestV1({
            encryption: "unencrypted",
            repositoryId: sequence(0x13),
            securitySeed: sequence(0x83),
        });
        const chunk = await encodeAdaptiveJournalChunkRecordV1({
            data: "body",
            keys: candidate.keys,
            localChunkId: "h:limit" as DocumentID,
        });

        await expect(
            publishAdaptiveJournalObjectChunksV1({
                catalogue: new AdaptiveJournalCatalogueV1(),
                inlinePackMaxBytes: 8 * 1024 * 1024 + 1,
                items: [{ localChunkId: "h:limit" as DocumentID, record: chunk }],
                keys: candidate.keys,
                remote: new MemoryObjectRemote(),
                sequence: 1n,
                writerStreamId: sequence(0x33),
            })
        ).rejects.toThrowError(RangeError);
    });
});
