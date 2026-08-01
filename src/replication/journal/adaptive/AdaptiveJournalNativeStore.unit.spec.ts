import type { DocumentID, EntryDoc } from "@lib/common/types.ts";
import { describe, expect, it } from "vitest";

import { bytesToHex, bytesEqual } from "./AdaptiveJournalBinary.ts";
import { digestAdaptiveJournalRequiredChunkKeysV1, encodeCommitEnvelopeV1 } from "./AdaptiveJournalCommit.ts";
import { encodeAdaptiveJournalCommitRecordV1 } from "./AdaptiveJournalControl.ts";
import type {
    AdaptiveJournalCommitSequenceListResultV1,
    AdaptiveJournalWriterListResultV1,
} from "./AdaptiveJournalDiscoveryStore.ts";
import type { AdaptiveImmutableRecordResultV1, AdaptiveWriterDescriptorRecordV1 } from "./AdaptiveJournalEventStore.ts";
import { createAdaptiveJournalManifestV1, sha256 } from "./AdaptiveJournalManifest.ts";
import {
    createAdaptiveJournalNativeEventStoreV1,
    type AdaptiveJournalNativeEventRemoteV1,
} from "./AdaptiveJournalNativeStore.ts";
import { encodeAdaptiveJournalMetadataRecordV1 } from "./AdaptiveJournalPayload.ts";
import type { RemoteRead } from "./AdaptiveJournalRepository.ts";
import { encodeAdaptiveJournalWriterDescriptorV1 } from "./AdaptiveJournalWriterDescriptor.ts";

function sequence(start: number): Uint8Array {
    return Uint8Array.from({ length: 32 }, (_, index) => (start + index) & 0xff);
}

function bundleKey(writerStreamId: Uint8Array, writerSequence: bigint): string {
    return `${bytesToHex(writerStreamId)}:${writerSequence}`;
}

class MemoryNativeEventRemote implements AdaptiveJournalNativeEventRemoteV1 {
    readonly bundles = new Map<string, Uint8Array>();
    readonly commitCalls: Uint8Array[] = [];
    readonly readBundleCalls: string[] = [];
    readonly readWriterCalls: string[] = [];
    readonly registrations: AdaptiveWriterDescriptorRecordV1[] = [];
    readonly writers = new Map<string, Uint8Array>();

    async commitMetadataBatch(envelope: Uint8Array): Promise<AdaptiveImmutableRecordResultV1> {
        this.commitCalls.push(envelope.slice());
        return { result: "inserted", status: "ok" };
    }

    async listCommitSequences(
        _writerStreamId: Uint8Array,
        _afterSequence: bigint
    ): Promise<AdaptiveJournalCommitSequenceListResultV1> {
        return { sequences: [], status: "ok" };
    }

    async listWriterStreamIds(): Promise<AdaptiveJournalWriterListResultV1> {
        return { status: "ok", writerStreamIds: [] };
    }

    async readCommitBundle(writerStreamId: Uint8Array, writerSequence: bigint): Promise<RemoteRead<Uint8Array>> {
        const key = bundleKey(writerStreamId, writerSequence);
        this.readBundleCalls.push(key);
        const value = this.bundles.get(key);
        return value ? { status: "found", value: value.slice() } : { status: "missing" };
    }

    async readWriter(writerStreamId: Uint8Array): Promise<RemoteRead<Uint8Array>> {
        const key = bytesToHex(writerStreamId);
        this.readWriterCalls.push(key);
        const value = this.writers.get(key);
        return value ? { status: "found", value: value.slice() } : { status: "missing" };
    }

    async registerWriter(record: AdaptiveWriterDescriptorRecordV1): Promise<AdaptiveImmutableRecordResultV1> {
        this.registrations.push(record);
        this.writers.set(bytesToHex(record.writerStreamId), record.descriptorFrame.slice());
        return { result: "inserted", status: "ok" };
    }
}

async function fixture(inlinePack?: Uint8Array) {
    const candidate = await createAdaptiveJournalManifestV1({
        encryption: "unencrypted",
        repositoryId: sequence(0x10),
        securitySeed: sequence(0x70),
    });
    const writer = await encodeAdaptiveJournalWriterDescriptorV1({
        hostId: "native-host",
        keys: candidate.keys,
        writerEpoch: "epoch-1",
    });
    const metadata = await encodeAdaptiveJournalMetadataRecordV1({
        documents: [
            {
                _id: "notes/native.md" as DocumentID,
                _rev: "1-native",
                children: [] as DocumentID[],
                type: "newnote",
            } as EntryDoc,
        ],
        keys: candidate.keys,
        sequence: 1n,
        writerStreamId: writer.writerStreamId,
    });
    const required = await digestAdaptiveJournalRequiredChunkKeysV1([]);
    const commit = await encodeAdaptiveJournalCommitRecordV1({
        chunkPacks: [],
        keys: candidate.keys,
        metadata: { bytes: metadata.bytes.byteLength, digest: metadata.digest },
        previousCommitDigest: null,
        requiredChunkKeysDigest: required.digest,
        sequence: 1n,
        writerStreamId: writer.writerStreamId,
    });
    const envelope = await encodeCommitEnvelopeV1({
        commitFrame: commit.bytes,
        ...(inlinePack ? { inlinePack } : {}),
        metadataDigest: metadata.digest,
        metadataFrame: metadata.bytes,
        previousCommitDigest: null,
        repositoryId: candidate.keys.repositoryId,
        requiredChunkKeys: [],
        sequence: 1n,
        writerStreamId: writer.writerStreamId,
    });
    return { candidate, commit, envelope, metadata, writer };
}

describe("Adaptive Journal native event store", () => {
    it("validates staged records locally and publishes one transactional Commit Bundle", async () => {
        const value = await fixture();
        const remote = new MemoryNativeEventRemote();
        const store = createAdaptiveJournalNativeEventStoreV1({ keys: value.candidate.keys, remote });

        await expect(
            store.registerWriter({
                descriptorDigest: value.writer.digest,
                descriptorFrame: value.writer.bytes,
                writerStreamId: value.writer.writerStreamId,
            })
        ).resolves.toMatchObject({ result: "inserted", status: "ok" });
        await expect(
            store.putMetadataBatch({
                metadataDigest: value.metadata.digest,
                metadataFrame: value.metadata.bytes,
                sequence: 1n,
                writerStreamId: value.writer.writerStreamId,
            })
        ).resolves.toEqual({ result: "inserted", status: "ok" });
        await expect(store.commitMetadataBatch(value.envelope.bytes)).resolves.toMatchObject({
            commitDigest: value.commit.digest,
            result: "inserted",
            status: "ok",
        });

        expect(remote.registrations).toHaveLength(1);
        expect(remote.commitCalls).toHaveLength(1);
        expect(bytesEqual(remote.commitCalls[0], value.envelope.bytes)).toBe(true);
    });

    it("serves Commit and Metadata frames from one remote bundle read", async () => {
        const value = await fixture();
        const remote = new MemoryNativeEventRemote();
        remote.bundles.set(bundleKey(value.writer.writerStreamId, 1n), value.envelope.bytes);
        const store = createAdaptiveJournalNativeEventStoreV1({ keys: value.candidate.keys, remote });

        await expect(store.readCommit(value.writer.writerStreamId, 1n)).resolves.toEqual({
            status: "found",
            value: value.commit.bytes,
        });
        await expect(store.readMetadata(value.writer.writerStreamId, 1n)).resolves.toEqual({
            status: "found",
            value: value.metadata.bytes,
        });

        expect(remote.readBundleCalls).toEqual([bundleKey(value.writer.writerStreamId, 1n)]);
    });

    it("reuses successful immutable Writer reads but retries a missing Writer", async () => {
        const value = await fixture();
        const remote = new MemoryNativeEventRemote();
        const writerKey = bytesToHex(value.writer.writerStreamId);
        remote.writers.set(writerKey, value.writer.bytes);
        const store = createAdaptiveJournalNativeEventStoreV1({ keys: value.candidate.keys, remote });

        await expect(store.readWriter(value.writer.writerStreamId)).resolves.toEqual({
            status: "found",
            value: value.writer.bytes,
        });
        await expect(store.readWriter(value.writer.writerStreamId)).resolves.toEqual({
            status: "found",
            value: value.writer.bytes,
        });
        expect(remote.readWriterCalls).toEqual([writerKey]);

        remote.writers.delete(writerKey);
        const missingWriter = sequence(0xe0);
        await expect(store.readWriter(missingWriter)).resolves.toEqual({ status: "missing" });
        await expect(store.readWriter(missingWriter)).resolves.toEqual({ status: "missing" });
        expect(remote.readWriterCalls).toEqual([writerKey, bytesToHex(missingWriter), bytesToHex(missingWriter)]);
    });

    it("rejects object-layout and invalid Writer records before mutation", async () => {
        const value = await fixture(new Uint8Array([1]));
        const remote = new MemoryNativeEventRemote();
        const store = createAdaptiveJournalNativeEventStoreV1({ keys: value.candidate.keys, remote });
        const invalidDescriptor = new Uint8Array([1]);

        await expect(
            store.registerWriter({
                descriptorDigest: await sha256(invalidDescriptor),
                descriptorFrame: invalidDescriptor,
                writerStreamId: value.writer.writerStreamId,
            })
        ).resolves.toEqual({ failure: { category: "invalid-response", retry: "never" }, status: "failed" });
        await expect(store.commitMetadataBatch(value.envelope.bytes)).resolves.toEqual({
            failure: { category: "invalid-response", retry: "never" },
            status: "failed",
        });

        expect(remote.registrations).toHaveLength(0);
        expect(remote.commitCalls).toHaveLength(0);
    });
});
