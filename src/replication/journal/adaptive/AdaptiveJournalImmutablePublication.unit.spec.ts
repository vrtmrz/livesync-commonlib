import type { DocumentID, EntryDoc } from "@lib/common/types.ts";
import { describe, expect, it, vi } from "vitest";

import type {
    AdaptiveCommitPublicationResultV1,
    AdaptiveJournalEventStoreV1,
    AdaptiveMetadataBatchRecordV1,
    AdaptiveWriterDescriptorRecordV1,
} from "./AdaptiveJournalEventStore.ts";
import {
    publishAdaptiveJournalMetadataRecordV1,
    publishAdaptiveJournalWriterDescriptorV1,
} from "./AdaptiveJournalImmutablePublication.ts";
import { createAdaptiveJournalManifestV1 } from "./AdaptiveJournalManifest.ts";
import { encodeAdaptiveJournalMetadataRecordV1 } from "./AdaptiveJournalPayload.ts";
import type { RemoteRead } from "./AdaptiveJournalRepository.ts";
import { encodeAdaptiveJournalWriterDescriptorV1 } from "./AdaptiveJournalWriterDescriptor.ts";

function sequence(start: number): Uint8Array {
    return Uint8Array.from({ length: 32 }, (_, index) => (start + index) & 0xff);
}

function metadata(path: string): EntryDoc {
    return {
        _id: path as DocumentID,
        _rev: "1-first",
        children: ["h:chunk"],
        ctime: 1,
        mtime: 1,
        path,
        size: 5,
        type: "newnote",
    } as EntryDoc;
}

function eventStore(options: {
    metadataCreate?: AdaptiveJournalEventStoreV1["putMetadataBatch"];
    metadataRead?: AdaptiveJournalEventStoreV1["readMetadata"];
    writerCreate?: AdaptiveJournalEventStoreV1["registerWriter"];
    writerRead?: AdaptiveJournalEventStoreV1["readWriter"];
}): AdaptiveJournalEventStoreV1 {
    const missing = async (): Promise<RemoteRead<Uint8Array>> => ({ status: "missing" });
    return {
        commitMetadataBatch: async (): Promise<AdaptiveCommitPublicationResultV1> => ({
            failure: { category: "unknown", retry: "never" },
            status: "failed",
        }),
        putMetadataBatch:
            options.metadataCreate ??
            (async (_record: AdaptiveMetadataBatchRecordV1) => ({ result: "inserted", status: "ok" })),
        readCommit: missing,
        readMetadata: options.metadataRead ?? missing,
        readWriter: options.writerRead ?? missing,
        registerWriter:
            options.writerCreate ??
            (async (_record: AdaptiveWriterDescriptorRecordV1) => ({ result: "inserted", status: "ok" })),
    };
}

describe("Adaptive Journal immutable publication", () => {
    it("trusts an acknowledged Writer insertion without an additional read", async () => {
        const candidate = await createAdaptiveJournalManifestV1({
            encryption: "encrypted",
            passphrase: "immutable publication passphrase",
            repositoryId: sequence(0x10),
            securitySeed: sequence(0x80),
        });
        const descriptor = await encodeAdaptiveJournalWriterDescriptorV1({
            hostId: "host-a",
            keys: candidate.keys,
            writerEpoch: "epoch-a",
        });
        const readWriter = vi.fn(async (): Promise<RemoteRead<Uint8Array>> => ({ status: "missing" }));

        await expect(
            publishAdaptiveJournalWriterDescriptorV1(eventStore({ writerRead: readWriter }), candidate.keys, descriptor)
        ).resolves.toEqual({
            bytes: descriptor.bytes.byteLength,
            digest: descriptor.digest,
            disposition: "inserted",
            status: "accepted",
        });
        expect(readWriter).not.toHaveBeenCalled();
    });

    it("adopts a differently encrypted existing Metadata frame with the same logical payload", async () => {
        const candidate = await createAdaptiveJournalManifestV1({
            encryption: "encrypted",
            passphrase: "immutable publication passphrase",
            repositoryId: sequence(0x11),
            securitySeed: sequence(0x81),
        });
        const writerStreamId = sequence(0x30);
        const existing = await encodeAdaptiveJournalMetadataRecordV1({
            documents: [metadata("same.md")],
            iv: new Uint8Array(12).fill(0x41),
            keys: candidate.keys,
            recordSalt: new Uint8Array(32).fill(0x42),
            sequence: 1n,
            writerStreamId,
        });
        const intended = await encodeAdaptiveJournalMetadataRecordV1({
            documents: [metadata("same.md")],
            iv: new Uint8Array(12).fill(0x51),
            keys: candidate.keys,
            recordSalt: new Uint8Array(32).fill(0x52),
            sequence: 1n,
            writerStreamId,
        });
        const readMetadata = vi.fn(async (): Promise<RemoteRead<Uint8Array>> => ({
            status: "found",
            value: existing.bytes,
        }));

        await expect(
            publishAdaptiveJournalMetadataRecordV1({
                keys: candidate.keys,
                record: intended,
                remote: eventStore({
                    metadataCreate: async () => ({ result: "validate-existing", status: "ok" }),
                    metadataRead: readMetadata,
                }),
                sequence: 1n,
                writerStreamId,
            })
        ).resolves.toEqual({
            bytes: existing.bytes.byteLength,
            digest: existing.digest,
            disposition: "equivalent-existing",
            status: "accepted",
        });
        expect(readMetadata).toHaveBeenCalledTimes(1);
    });

    it("rejects a different logical Metadata payload at the same writer sequence", async () => {
        const candidate = await createAdaptiveJournalManifestV1({
            encryption: "unencrypted",
            repositoryId: sequence(0x12),
            securitySeed: sequence(0x82),
        });
        const writerStreamId = sequence(0x31);
        const existing = await encodeAdaptiveJournalMetadataRecordV1({
            documents: [metadata("existing.md")],
            keys: candidate.keys,
            sequence: 2n,
            writerStreamId,
        });
        const intended = await encodeAdaptiveJournalMetadataRecordV1({
            documents: [metadata("intended.md")],
            keys: candidate.keys,
            sequence: 2n,
            writerStreamId,
        });

        await expect(
            publishAdaptiveJournalMetadataRecordV1({
                keys: candidate.keys,
                record: intended,
                remote: eventStore({
                    metadataCreate: async () => ({ result: "validate-existing", status: "ok" }),
                    metadataRead: async () => ({ status: "found", value: existing.bytes }),
                }),
                sequence: 2n,
                writerStreamId,
            })
        ).resolves.toEqual({ status: "collision" });
    });

    it("keeps an unknown write pending when verify-first still observes a missing object", async () => {
        const candidate = await createAdaptiveJournalManifestV1({
            encryption: "unencrypted",
            repositoryId: sequence(0x13),
            securitySeed: sequence(0x83),
        });
        const writerStreamId = sequence(0x32);
        const record = await encodeAdaptiveJournalMetadataRecordV1({
            documents: [metadata("pending.md")],
            keys: candidate.keys,
            sequence: 3n,
            writerStreamId,
        });
        const failure = { category: "unavailable", retry: "verify-first" } as const;

        await expect(
            publishAdaptiveJournalMetadataRecordV1({
                keys: candidate.keys,
                record,
                remote: eventStore({
                    metadataCreate: async () => ({ failure, status: "failed" }),
                }),
                sequence: 3n,
                writerStreamId,
            })
        ).resolves.toEqual({ failure, status: "pending" });
    });
});
