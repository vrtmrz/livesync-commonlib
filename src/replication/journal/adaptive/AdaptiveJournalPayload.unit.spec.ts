import type { DocumentID, EntryDoc } from "@lib/common/types.ts";
import { describe, expect, it } from "vitest";

import { createAdaptiveJournalManifestV1 } from "./AdaptiveJournalManifest.ts";
import {
    decodeAdaptiveJournalChunkRecordV1,
    decodeAdaptiveJournalMetadataPayloadV1,
    decodeAdaptiveJournalMetadataRecordV1,
    encodeAdaptiveJournalChunkRecordV1,
    encodeAdaptiveJournalMetadataPayloadV1,
    encodeAdaptiveJournalMetadataRecordV1,
} from "./AdaptiveJournalPayload.ts";

function sequence(start: number): Uint8Array {
    return Uint8Array.from({ length: 32 }, (_, index) => (start + index) & 0xff);
}

const documents: EntryDoc[] = [
    {
        _id: "notes/a.md" as DocumentID,
        _rev: "2-second",
        _revisions: { start: 2, ids: ["second", "first"] },
        children: ["h:shared", "h:embedded", "h:shared"],
        mtime: 20,
        ctime: 10,
        path: "notes/a.md",
        size: 12,
        type: "newnote",
    },
    {
        _deleted: true,
        _id: "notes/deleted.md" as DocumentID,
        _rev: "3-deleted",
        _revisions: { start: 3, ids: ["deleted", "second", "first"] },
        children: ["h:deleted-branch"],
        mtime: 30,
        ctime: 10,
        path: "notes/deleted.md",
        size: 0,
        type: "newnote",
    },
] as EntryDoc[];

describe("Adaptive Journal Metadata and Chunk payloads", () => {
    it("preserves PouchDB revisions while deriving unique Chunk dependencies", () => {
        const encoded = encodeAdaptiveJournalMetadataPayloadV1(documents);
        const decoded = decodeAdaptiveJournalMetadataPayloadV1(encoded.bytes);

        expect(decoded.documents).toEqual(documents);
        expect(decoded.localChunkIds).toEqual(["h:deleted-branch", "h:embedded", "h:shared"]);
        expect(decoded.bytes).toEqual(encoded.bytes);
    });

    it("wraps Metadata in the writer route and rejects Chunk documents or duplicate revisions", async () => {
        const candidate = await createAdaptiveJournalManifestV1({
            encryption: "unencrypted",
            repositoryId: sequence(0x10),
            securitySeed: sequence(0x80),
        });
        const writerStreamId = sequence(0x30);
        const record = await encodeAdaptiveJournalMetadataRecordV1({
            codec: "deflate",
            documents,
            keys: candidate.keys,
            sequence: 1n,
            writerStreamId,
        });
        const decoded = await decodeAdaptiveJournalMetadataRecordV1({
            bytes: record.bytes,
            keys: candidate.keys,
            sequence: 1n,
            writerStreamId,
        });
        expect(decoded.documents).toEqual(documents);
        expect(decoded.localChunkIds).toEqual(record.localChunkIds);

        expect(() =>
            encodeAdaptiveJournalMetadataPayloadV1([
                { _id: "h:not-metadata", _rev: "1-a", data: "body", type: "leaf" } as EntryDoc,
            ])
        ).toThrow("Metadata batch entry must have a non-Chunk document ID");
        expect(() => encodeAdaptiveJournalMetadataPayloadV1([documents[0], documents[0]])).toThrow(
            "Metadata batch contains a duplicate document revision"
        );
    });

    it("derives and validates the same remote key when a Chunk frame is decoded", async () => {
        const candidate = await createAdaptiveJournalManifestV1({
            encryption: "encrypted",
            passphrase: "payload test passphrase",
            repositoryId: sequence(0x11),
            securitySeed: sequence(0x81),
        });
        const localChunkId = "h:payload-chunk" as DocumentID;
        const record = await encodeAdaptiveJournalChunkRecordV1({
            codec: "deflate",
            data: "Chunk payload|".repeat(16),
            iv: new Uint8Array(12).fill(0x42),
            keys: candidate.keys,
            localChunkId,
            recordSalt: new Uint8Array(32).fill(0x43),
        });
        const decoded = await decodeAdaptiveJournalChunkRecordV1({
            bytes: record.bytes,
            keys: candidate.keys,
            localChunkId,
        });
        expect(decoded).toMatchObject({
            _id: localChunkId,
            data: "Chunk payload|".repeat(16),
            type: "leaf",
        });
        expect(decoded.remoteChunkKey).toEqual(record.remoteChunkKey);
    });
});
