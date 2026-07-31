import { describe, expect, it } from "vitest";

import type { AdaptiveJournalEventStoreV1 } from "./AdaptiveJournalEventStore.ts";
import { createAdaptiveJournalManifestV1 } from "./AdaptiveJournalManifest.ts";
import type {
    AdaptiveJournalPendingWriterDescriptorV1,
    AdaptiveJournalWriterStateV1,
} from "./AdaptiveJournalWriter.ts";
import { encodeAdaptiveJournalWriterDescriptorV1 } from "./AdaptiveJournalWriterDescriptor.ts";
import {
    publishAdaptiveJournalPendingWriterDescriptorV1,
    stageAdaptiveJournalWriterDescriptorV1,
    type AdaptiveJournalWriterRegistrationStoreV1,
} from "./AdaptiveJournalWriterRegistration.ts";

function sequence(start: number): Uint8Array {
    return Uint8Array.from({ length: 32 }, (_, index) => (start + index) & 0xff);
}

class MemoryRegistrationStore implements AdaptiveJournalWriterRegistrationStoreV1 {
    readonly events: string[] = [];

    constructor(public state: AdaptiveJournalWriterStateV1) {}

    async load(): Promise<AdaptiveJournalWriterStateV1> {
        return structuredClone(this.state);
    }

    async stagePendingWriterDescriptor(pending: AdaptiveJournalPendingWriterDescriptorV1): Promise<void> {
        this.events.push("stage");
        this.state = { ...this.state, pendingWriterDescriptor: structuredClone(pending) };
    }

    async acceptPendingWriterDescriptor(expectedDigest: Uint8Array): Promise<void> {
        this.events.push("accept");
        expect(this.state.pendingWriterDescriptor?.descriptorDigest).toEqual(expectedDigest);
        this.state = { ...this.state, pendingWriterDescriptor: undefined };
    }
}

function eventStore(registerWriter: AdaptiveJournalEventStoreV1["registerWriter"]): AdaptiveJournalEventStoreV1 {
    return {
        commitMetadataBatch: async () => ({
            failure: { category: "unknown", retry: "never" },
            status: "failed",
        }),
        putMetadataBatch: async () => ({ result: "inserted", status: "ok" }),
        readCommit: async () => ({ status: "missing" }),
        readMetadata: async () => ({ status: "missing" }),
        readWriter: async () => ({ status: "missing" }),
        registerWriter,
    };
}

describe("Adaptive Journal Writer descriptor recovery", () => {
    it("stages exact bytes before publication and clears them after an acknowledged insert", async () => {
        const candidate = await createAdaptiveJournalManifestV1({
            encryption: "encrypted",
            passphrase: "Writer registration passphrase",
            repositoryId: sequence(0x10),
            securitySeed: sequence(0x80),
        });
        const descriptor = await encodeAdaptiveJournalWriterDescriptorV1({
            hostId: "host-a",
            keys: candidate.keys,
            writerEpoch: "epoch-a",
        });
        const store = new MemoryRegistrationStore({
            lastCommitDigest: null,
            lastCommittedSequence: 0n,
            repositoryId: candidate.keys.repositoryId,
            writerEpoch: "epoch-a",
            writerStreamId: descriptor.writerStreamId,
        });
        const events = store.events;
        const remote = eventStore(async () => {
            events.push("publish");
            return { result: "inserted", status: "ok" };
        });

        await expect(stageAdaptiveJournalWriterDescriptorV1(store, candidate.keys, descriptor)).resolves.toBe("staged");
        await expect(
            publishAdaptiveJournalPendingWriterDescriptorV1(store, remote, candidate.keys)
        ).resolves.toEqual({ status: "registered" });
        expect(events).toEqual(["stage", "publish", "accept"]);
        expect(store.state.pendingWriterDescriptor).toBeUndefined();
    });

    it("keeps exact pending bytes when an unknown publication remains missing", async () => {
        const candidate = await createAdaptiveJournalManifestV1({
            encryption: "unencrypted",
            repositoryId: sequence(0x11),
            securitySeed: sequence(0x81),
        });
        const descriptor = await encodeAdaptiveJournalWriterDescriptorV1({
            hostId: "host-b",
            keys: candidate.keys,
            writerEpoch: "epoch-b",
        });
        const store = new MemoryRegistrationStore({
            lastCommitDigest: null,
            lastCommittedSequence: 0n,
            repositoryId: candidate.keys.repositoryId,
            writerEpoch: "epoch-b",
            writerStreamId: descriptor.writerStreamId,
        });
        await stageAdaptiveJournalWriterDescriptorV1(store, candidate.keys, descriptor);
        const failure = { category: "unavailable", retry: "verify-first" } as const;
        const remote = eventStore(async () => ({ failure, status: "failed" }));

        await expect(
            publishAdaptiveJournalPendingWriterDescriptorV1(store, remote, candidate.keys)
        ).resolves.toEqual({ failure, status: "pending" });
        expect(store.state.pendingWriterDescriptor?.exactBytes).toEqual(descriptor.bytes);
    });
});
