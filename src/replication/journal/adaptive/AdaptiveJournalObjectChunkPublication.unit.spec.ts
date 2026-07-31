import type { DocumentID } from "@lib/common/types.ts";
import { describe, expect, it } from "vitest";

import { AdaptiveJournalCatalogueV1, adaptiveJournalDeltaObjectKeyV1 } from "./AdaptiveJournalCatalogue.ts";
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
        const firstDependency = {
            digest: sequence(0xd0),
            key: adaptiveJournalDeltaObjectKeyV1(sequence(0x20), 1n),
        };
        catalogue.applyCommittedPack(
            sequence(0xa0),
            [
                {
                    frameDigest: first.digest,
                    frameLength: first.bytes.byteLength,
                    key: first.remoteChunkKey,
                    offset: 0,
                    plaintextLength: 5,
                },
            ],
            firstDependency
        );
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
        expect(result.catalogueDeltas).toEqual(
            expect.arrayContaining([
                firstDependency,
                expect.objectContaining({ key: adaptiveJournalDeltaObjectKeyV1(sequence(0x30), 1n) }),
            ])
        );
        expect(result.committedPackCandidates).toHaveLength(1);
        expect(result.committedPackCandidates[0].entries.map(({ key }) => key)).toEqual([second.remoteChunkKey]);
        expect(remote.objects.size).toBe(3);
    });

    it("reuses a catalogued Chunk by carrying its verified Delta dependency", async () => {
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
        const dependency = {
            digest: sequence(0xd1),
            key: adaptiveJournalDeltaObjectKeyV1(sequence(0x21), 1n),
        };
        catalogue.applyCommittedPack(
            sequence(0xa1),
            [
                {
                    frameDigest: chunk.digest,
                    frameLength: chunk.bytes.byteLength,
                    key: chunk.remoteChunkKey,
                    offset: 0,
                    plaintextLength: 4,
                },
            ],
            dependency
        );
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
        ).resolves.toMatchObject({ catalogueDeltas: [dependency], status: "ok" });
        expect(remote.objects.size).toBe(0);
    });
});
