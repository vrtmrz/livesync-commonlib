import type { DocumentID, EntryDoc } from "@lib/common/types.ts";
import { describe, expect, it, vi } from "vitest";

import { createAdaptiveJournalNativeChunkDeliveryV1 } from "./AdaptiveJournalChunkDelivery.ts";
import type { AdaptiveJournalChunkStoreV1 } from "./AdaptiveJournalChunkStore.ts";
import { decodeCommitEnvelopeV1 } from "./AdaptiveJournalCommit.ts";
import { decodeAdaptiveJournalCommitRecordV1 } from "./AdaptiveJournalControl.ts";
import type { AdaptiveJournalEventStoreV1 } from "./AdaptiveJournalEventStore.ts";
import { createAdaptiveJournalManifestV1 } from "./AdaptiveJournalManifest.ts";
import { publishAdaptiveJournalMetadataBatchV1 } from "./AdaptiveJournalPublisher.ts";
import type {
    AdaptiveJournalPendingCommitV1,
    AdaptiveJournalWriterStateStoreV1,
    AdaptiveJournalWriterStateV1,
} from "./AdaptiveJournalWriter.ts";

function sequence(start: number): Uint8Array {
    return Uint8Array.from({ length: 32 }, (_, index) => (start + index) & 0xff);
}

class MemoryWriterState implements AdaptiveJournalWriterStateStoreV1 {
    constructor(
        public state: AdaptiveJournalWriterStateV1,
        readonly events: string[]
    ) {}

    async load(): Promise<AdaptiveJournalWriterStateV1> {
        return structuredClone(this.state);
    }

    async stagePendingCommit(pending: AdaptiveJournalPendingCommitV1): Promise<void> {
        this.events.push("stage");
        this.state = { ...this.state, pendingCommit: structuredClone(pending) };
    }

    async acceptPendingCommit(expectedEnvelopeDigest: Uint8Array, commitFrameDigest: Uint8Array): Promise<void> {
        this.events.push("accept");
        expect(this.state.pendingCommit?.envelopeDigest).toEqual(expectedEnvelopeDigest);
        this.state = {
            ...this.state,
            lastCommitDigest: commitFrameDigest.slice(),
            lastCommittedSequence: this.state.pendingCommit!.sequence,
            pendingCommit: undefined,
        };
    }
}

function document(): EntryDoc {
    return {
        _id: "notes/a.md" as DocumentID,
        _rev: "1-first",
        children: ["h:chunk"],
        ctime: 1,
        mtime: 1,
        path: "notes/a.md",
        size: 4,
        type: "newnote",
    } as EntryDoc;
}

describe("Adaptive Journal Metadata batch publisher", () => {
    it("publishes Chunks, Metadata, and one crash-staged Commit in order", async () => {
        const candidate = await createAdaptiveJournalManifestV1({
            encryption: "unencrypted",
            repositoryId: sequence(0x10),
            securitySeed: sequence(0x80),
        });
        const writerStreamId = sequence(0x30);
        const events: string[] = [];
        const writerState = new MemoryWriterState(
            {
                lastCommitDigest: null,
                lastCommittedSequence: 0n,
                repositoryId: candidate.keys.repositoryId,
                writerEpoch: "epoch-a",
                writerStreamId,
            },
            events
        );
        const chunkStore = {
            capabilities: { nativeBatch: true },
            getMany: vi.fn(),
            hasMany: vi.fn(),
            putMany: vi.fn(async () => {
                events.push("chunks");
                return { results: ["inserted"] as const, status: "ok" as const };
            }),
        } as AdaptiveJournalChunkStoreV1;
        let committedEnvelope: Uint8Array | undefined;
        const remote: AdaptiveJournalEventStoreV1 = {
            commitMetadataBatch: async (envelope) => {
                events.push("commit");
                committedEnvelope = envelope.slice();
                const decoded = await decodeCommitEnvelopeV1(envelope);
                return { commitDigest: decoded.commitFrameDigest, result: "inserted", status: "ok" };
            },
            putMetadataBatch: async () => {
                events.push("metadata");
                return { result: "inserted", status: "ok" };
            },
            readCommit: async () => ({ status: "missing" }),
            readMetadata: async () => ({ status: "missing" }),
            readWriter: async () => ({ status: "missing" }),
            registerWriter: async () => ({ result: "inserted", status: "ok" }),
        };

        await expect(
            publishAdaptiveJournalMetadataBatchV1({
                chunkDelivery: createAdaptiveJournalNativeChunkDeliveryV1(chunkStore, candidate.keys),
                chunks: [{ data: "body", localChunkId: "h:chunk" as DocumentID }],
                documents: [document()],
                keys: candidate.keys,
                remote,
                writerState,
            })
        ).resolves.toEqual({ sequence: 1n, status: "committed" });
        expect(events).toEqual(["chunks", "metadata", "stage", "commit", "accept"]);
        expect(writerState.state.lastCommittedSequence).toBe(1n);
        const envelope = await decodeCommitEnvelopeV1(committedEnvelope!);
        const control = await decodeAdaptiveJournalCommitRecordV1({
            bytes: envelope.commitFrame,
            keys: candidate.keys,
            sequence: 1n,
            writerStreamId,
        });
        expect(control.payload.requiredChunkKeysDigest).toBeDefined();
        expect(envelope.requiredChunkKeys).toHaveLength(1);
    });

    it("rejects an incomplete Chunk source set before making remote requests", async () => {
        const candidate = await createAdaptiveJournalManifestV1({
            encryption: "unencrypted",
            repositoryId: sequence(0x11),
            securitySeed: sequence(0x81),
        });
        const writerState = new MemoryWriterState(
            {
                lastCommitDigest: null,
                lastCommittedSequence: 0n,
                repositoryId: candidate.keys.repositoryId,
                writerEpoch: "epoch-b",
                writerStreamId: sequence(0x31),
            },
            []
        );
        const putMany = vi.fn();
        const chunkStore = {
            capabilities: { nativeBatch: true },
            getMany: vi.fn(),
            hasMany: vi.fn(),
            putMany,
        } as AdaptiveJournalChunkStoreV1;

        await expect(
            publishAdaptiveJournalMetadataBatchV1({
                chunkDelivery: createAdaptiveJournalNativeChunkDeliveryV1(chunkStore, candidate.keys),
                chunks: [],
                documents: [document()],
                keys: candidate.keys,
                remote: {} as AdaptiveJournalEventStoreV1,
                writerState,
            })
        ).rejects.toMatchObject({ code: "invalid-metadata-payload" });
        expect(putMany).not.toHaveBeenCalled();
    });
});
