import type { DocumentID } from "@lib/common/types.ts";
import { describe, expect, it, vi } from "vitest";

import type { AdaptiveJournalChunkStoreV1, StoredChunkRecordV1 } from "./AdaptiveJournalChunkStore.ts";
import { publishAdaptiveJournalNativeChunksV1 } from "./AdaptiveJournalNativeChunkPublication.ts";
import { createAdaptiveJournalManifestV1 } from "./AdaptiveJournalManifest.ts";
import { encodeAdaptiveJournalChunkRecordV1 } from "./AdaptiveJournalPayload.ts";

function sequence(start: number): Uint8Array {
    return Uint8Array.from({ length: 32 }, (_, index) => (start + index) & 0xff);
}

describe("Adaptive Journal native Chunk publication", () => {
    it("accepts inserted Chunks without HAS or GET requests", async () => {
        const candidate = await createAdaptiveJournalManifestV1({
            encryption: "unencrypted",
            repositoryId: sequence(0x10),
            securitySeed: sequence(0x80),
        });
        const record = await encodeAdaptiveJournalChunkRecordV1({
            data: "body",
            keys: candidate.keys,
            localChunkId: "h:chunk" as DocumentID,
        });
        const getMany = vi.fn();
        const hasMany = vi.fn();
        const store = {
            capabilities: { nativeBatch: true },
            getMany,
            hasMany,
            putMany: vi.fn(async () => ({ results: ["inserted"] as const, status: "ok" as const })),
        } as AdaptiveJournalChunkStoreV1;

        await expect(
            publishAdaptiveJournalNativeChunksV1(store, candidate.keys, [
                { localChunkId: "h:chunk" as DocumentID, record },
            ])
        ).resolves.toEqual({ status: "accepted" });
        expect(store.putMany).toHaveBeenCalledTimes(1);
        expect(hasMany).not.toHaveBeenCalled();
        expect(getMany).not.toHaveBeenCalled();
    });

    it("validates only conflicting entries in one batch and adopts equivalent encrypted frames", async () => {
        const candidate = await createAdaptiveJournalManifestV1({
            encryption: "encrypted",
            passphrase: "native Chunk publication passphrase",
            repositoryId: sequence(0x11),
            securitySeed: sequence(0x81),
        });
        const localChunkId = "h:chunk" as DocumentID;
        const existing = await encodeAdaptiveJournalChunkRecordV1({
            data: "same body",
            iv: new Uint8Array(12).fill(0x41),
            keys: candidate.keys,
            localChunkId,
            recordSalt: new Uint8Array(32).fill(0x42),
        });
        const intended = await encodeAdaptiveJournalChunkRecordV1({
            data: "same body",
            iv: new Uint8Array(12).fill(0x51),
            keys: candidate.keys,
            localChunkId,
            recordSalt: new Uint8Array(32).fill(0x52),
        });
        const getMany = vi.fn(async () => ({
            chunks: [
                {
                    frame: existing.bytes,
                    frameDigest: existing.digest,
                    key: existing.remoteChunkKey,
                },
            ],
            status: "ok" as const,
        }));
        const store = {
            capabilities: { nativeBatch: true },
            getMany,
            hasMany: vi.fn(),
            putMany: vi.fn(async () => ({ results: ["validate-existing"] as const, status: "ok" as const })),
        } as AdaptiveJournalChunkStoreV1;

        await expect(
            publishAdaptiveJournalNativeChunksV1(store, candidate.keys, [{ localChunkId, record: intended }])
        ).resolves.toEqual({ status: "accepted" });
        expect(getMany).toHaveBeenCalledTimes(1);
        expect(getMany.mock.calls[0][0]).toEqual([intended.remoteChunkKey]);
    });

    it("reports a collision when an existing key decrypts to different Chunk data", async () => {
        const candidate = await createAdaptiveJournalManifestV1({
            encryption: "unencrypted",
            repositoryId: sequence(0x12),
            securitySeed: sequence(0x82),
        });
        const localChunkId = "h:chunk" as DocumentID;
        const existing = await encodeAdaptiveJournalChunkRecordV1({
            data: "existing",
            keys: candidate.keys,
            localChunkId,
        });
        const intended = await encodeAdaptiveJournalChunkRecordV1({
            data: "intended",
            keys: candidate.keys,
            localChunkId,
        });
        const storedExisting: StoredChunkRecordV1 = {
            frame: existing.bytes,
            frameDigest: existing.digest,
            key: existing.remoteChunkKey,
        };
        const store = {
            capabilities: { nativeBatch: true },
            getMany: vi.fn(async () => ({ chunks: [storedExisting], status: "ok" as const })),
            hasMany: vi.fn(),
            putMany: vi.fn(async () => ({ results: ["validate-existing"] as const, status: "ok" as const })),
        } as AdaptiveJournalChunkStoreV1;

        await expect(
            publishAdaptiveJournalNativeChunksV1(store, candidate.keys, [{ localChunkId, record: intended }])
        ).resolves.toEqual({ key: intended.remoteChunkKey, status: "collision" });
    });
});
