import { describe, expect, it } from "vitest";

import { encodeCommitEnvelopeV1 } from "./AdaptiveJournalCommit.ts";
import type { AdaptiveJournalEventStoreV1 } from "./AdaptiveJournalEventStore.ts";
import { sha256 } from "./AdaptiveJournalManifest.ts";
import {
    publishAdaptiveJournalPendingCommitV1,
    stageAdaptiveJournalCommitV1,
    type AdaptiveJournalPendingCommitV1,
    type AdaptiveJournalWriterStateStoreV1,
    type AdaptiveJournalWriterStateV1,
} from "./AdaptiveJournalWriter.ts";

function sequence(start: number): Uint8Array {
    return Uint8Array.from({ length: 32 }, (_, index) => (start + index) & 0xff);
}

class MemoryWriterStateStore implements AdaptiveJournalWriterStateStoreV1 {
    readonly events: string[] = [];

    constructor(public state: AdaptiveJournalWriterStateV1) {}

    async load(): Promise<AdaptiveJournalWriterStateV1> {
        return structuredClone(this.state);
    }

    async stagePendingCommit(pending: AdaptiveJournalPendingCommitV1): Promise<void> {
        this.events.push("stage");
        if (this.state.pendingCommit) throw new Error("pending Commit already exists");
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

function eventStore(
    overrides: Partial<AdaptiveJournalEventStoreV1>,
    events: string[] = []
): AdaptiveJournalEventStoreV1 {
    return {
        commitMetadataBatch: async () => {
            events.push("publish");
            throw new Error("unexpected Commit publication");
        },
        putMetadataBatch: async () => ({ status: "ok", result: "inserted" }),
        readCommit: async () => ({ status: "missing" }),
        readMetadata: async () => ({ status: "missing" }),
        readWriter: async () => ({ status: "missing" }),
        registerWriter: async () => ({ status: "ok", result: "inserted" }),
        ...overrides,
    };
}

async function commitFixture(sequenceValue = 1n, previousCommitDigest: Uint8Array | null = null) {
    const repositoryId = sequence(0x10);
    const writerStreamId = sequence(0x40);
    const commitFrame = new TextEncoder().encode(`commit-frame-${sequenceValue}`);
    const metadataFrame = new TextEncoder().encode(`metadata-frame-${sequenceValue}`);
    const encoded = await encodeCommitEnvelopeV1({
        commitFrame,
        metadataDigest: await sha256(metadataFrame),
        metadataFrame,
        previousCommitDigest,
        repositoryId,
        requiredChunkKeys: [sequence(0xc0)],
        sequence: sequenceValue,
        writerStreamId,
    });
    return { commitFrame, encoded, repositoryId, writerStreamId };
}

describe("Adaptive Journal writer recovery", () => {
    it("durably stages exact Commit bytes before making them remotely visible", async () => {
        const fixture = await commitFixture();
        const events: string[] = [];
        const store = new MemoryWriterStateStore({
            lastCommitDigest: null,
            lastCommittedSequence: 0n,
            repositoryId: fixture.repositoryId,
            writerEpoch: "epoch-a",
            writerStreamId: fixture.writerStreamId,
        });
        const originalStage = store.stagePendingCommit.bind(store);
        store.stagePendingCommit = async (pending) => {
            events.push("stage");
            await originalStage(pending);
        };
        const remote = eventStore(
            {
                commitMetadataBatch: async () => {
                    events.push("publish");
                    return {
                        status: "ok",
                        result: "inserted",
                        commitDigest: fixture.encoded.commitFrameDigest,
                    };
                },
            },
            events
        );

        await expect(stageAdaptiveJournalCommitV1(store, fixture.encoded.bytes)).resolves.toBe("staged");
        await expect(publishAdaptiveJournalPendingCommitV1(store, remote)).resolves.toEqual({
            status: "committed",
            sequence: 1n,
        });
        expect(events).toEqual(["stage", "publish"]);
        expect(store.state.pendingCommit).toBeUndefined();
        expect(store.state.lastCommittedSequence).toBe(1n);
        expect(store.state.lastCommitDigest).toEqual(fixture.encoded.commitFrameDigest);
    });

    it("resolves an uncertain create by reading and comparing the exact stored Commit frame", async () => {
        const fixture = await commitFixture();
        const store = new MemoryWriterStateStore({
            lastCommitDigest: null,
            lastCommittedSequence: 0n,
            repositoryId: fixture.repositoryId,
            writerEpoch: "epoch-a",
            writerStreamId: fixture.writerStreamId,
        });
        await stageAdaptiveJournalCommitV1(store, fixture.encoded.bytes);
        const remote = eventStore({
            commitMetadataBatch: async () => ({
                status: "failed",
                failure: { category: "unavailable", retry: "verify-first" },
            }),
            readCommit: async () => ({ status: "found", value: fixture.commitFrame.slice() }),
        });

        await expect(publishAdaptiveJournalPendingCommitV1(store, remote)).resolves.toEqual({
            status: "committed",
            sequence: 1n,
        });
        expect(store.state.pendingCommit).toBeUndefined();
    });

    it("keeps a pending Commit when an uncertain create is still explicitly missing", async () => {
        const fixture = await commitFixture();
        const store = new MemoryWriterStateStore({
            lastCommitDigest: null,
            lastCommittedSequence: 0n,
            repositoryId: fixture.repositoryId,
            writerEpoch: "epoch-a",
            writerStreamId: fixture.writerStreamId,
        });
        await stageAdaptiveJournalCommitV1(store, fixture.encoded.bytes);
        const failure = { category: "unavailable", retry: "verify-first" } as const;
        const remote = eventStore({
            commitMetadataBatch: async () => ({ status: "failed", failure }),
            readCommit: async () => ({ status: "missing" }),
        });

        await expect(publishAdaptiveJournalPendingCommitV1(store, remote)).resolves.toEqual({
            status: "pending",
            failure,
        });
        expect(store.state.lastCommittedSequence).toBe(0n);
        expect(store.state.pendingCommit?.exactBytes).toEqual(fixture.encoded.bytes);
    });

    it("stops a writer stream when the occupied sequence contains a different Commit", async () => {
        const fixture = await commitFixture();
        const store = new MemoryWriterStateStore({
            lastCommitDigest: null,
            lastCommittedSequence: 0n,
            repositoryId: fixture.repositoryId,
            writerEpoch: "epoch-a",
            writerStreamId: fixture.writerStreamId,
        });
        await stageAdaptiveJournalCommitV1(store, fixture.encoded.bytes);
        const remote = eventStore({
            commitMetadataBatch: async () => ({
                status: "ok",
                result: "validate-existing",
                commitDigest: fixture.encoded.commitFrameDigest,
            }),
            readCommit: async () => ({
                status: "found",
                value: new TextEncoder().encode("a different Commit frame"),
            }),
        });

        await expect(publishAdaptiveJournalPendingCommitV1(store, remote)).resolves.toEqual({
            status: "collision",
            sequence: 1n,
        });
        expect(store.state.lastCommittedSequence).toBe(0n);
        expect(store.state.pendingCommit).toBeDefined();
    });

    it("rejects a sequence gap, a wrong predecessor, or replacing an unresolved pending Commit", async () => {
        const first = await commitFixture();
        const previousDigest = await sha256(first.commitFrame);
        const gap = await commitFixture(2n, previousDigest);
        const store = new MemoryWriterStateStore({
            lastCommitDigest: null,
            lastCommittedSequence: 0n,
            repositoryId: first.repositoryId,
            writerEpoch: "epoch-a",
            writerStreamId: first.writerStreamId,
        });

        await expect(stageAdaptiveJournalCommitV1(store, gap.encoded.bytes)).rejects.toMatchObject({
            code: "writer-sequence-mismatch",
        });
        await stageAdaptiveJournalCommitV1(store, first.encoded.bytes);
        await expect(stageAdaptiveJournalCommitV1(store, first.encoded.bytes)).resolves.toBe("already-staged");
        const different = await encodeCommitEnvelopeV1({
            commitFrame: new TextEncoder().encode("different frame"),
            metadataDigest: await sha256(new TextEncoder().encode("different metadata")),
            metadataFrame: new TextEncoder().encode("different metadata"),
            previousCommitDigest: null,
            repositoryId: first.repositoryId,
            requiredChunkKeys: [sequence(0xc0)],
            sequence: 1n,
            writerStreamId: first.writerStreamId,
        });
        await expect(stageAdaptiveJournalCommitV1(store, different.bytes)).rejects.toMatchObject({
            code: "pending-commit-mismatch",
        });
    });
});
