import { reactiveSource } from "octagonal-wheels/dataobject/reactive";
import { describe, expect, it, vi } from "vitest";

import type { DocumentID, EntryDoc, PostgRESTSyncSetting } from "@lib/common/types.ts";
import type { LiveSyncJournalReplicatorEnv } from "../LiveSyncJournalReplicatorEnv.ts";
import { bytesEqual, bytesToBase64Url } from "../adaptive/AdaptiveJournalBinary.ts";
import { digestAdaptiveJournalRequiredChunkKeysV1, encodeCommitEnvelopeV1 } from "../adaptive/AdaptiveJournalCommit.ts";
import { encodeAdaptiveJournalCommitRecordV1 } from "../adaptive/AdaptiveJournalControl.ts";
import { createAdaptiveJournalManifestV1, sha256 } from "../adaptive/AdaptiveJournalManifest.ts";
import { publishAdaptiveJournalNativeChunksV1 } from "../adaptive/AdaptiveJournalNativeChunkPublication.ts";
import { createAdaptiveJournalNativeEventStoreV1 } from "../adaptive/AdaptiveJournalNativeStore.ts";
import {
    encodeAdaptiveJournalChunkRecordV1,
    encodeAdaptiveJournalMetadataRecordV1,
} from "../adaptive/AdaptiveJournalPayload.ts";
import { encodeAdaptiveJournalWriterDescriptorV1 } from "../adaptive/AdaptiveJournalWriterDescriptor.ts";
import { serialisePostgRESTConnectionURI } from "./JournalStorageConnection.ts";
import { PostgRESTStorageAdapter } from "./PostgRESTStorageAdapter.ts";

const endpoint = process.env.postgrestEndpoint ?? "http://127.0.0.1:3001";
const vaultId = process.env.postgrestVaultId ?? "integration-vault-01";
const vaultCredential = process.env.postgrestVaultCredential ?? "integration-vault-credential-0000000000001";
const secondaryVaultId = process.env.postgrestSecondaryVaultId;
const secondaryVaultCredential = process.env.postgrestSecondaryVaultCredential;

function createAdapter(credential = vaultCredential, configuredVaultId = vaultId) {
    const requestCount = reactiveSource(0);
    const responseCount = reactiveSource(0);
    const env = {
        services: {
            API: {
                nativeFetch: vi.fn(),
                requestCount,
                responseCount,
                webCompatFetch: globalThis.fetch.bind(globalThis),
            },
        },
    } as unknown as LiveSyncJournalReplicatorEnv;
    const postgrestActiveConnectionURI = serialisePostgRESTConnectionURI({
        apiKey: "",
        endpoint,
        schema: "livesync_api",
        useCustomRequestHandler: false,
        vaultCredential: credential,
        vaultId: configuredVaultId,
    });
    return {
        adapter: new PostgRESTStorageAdapter(
            { journalFormat: "adaptive-v1", postgrestActiveConnectionURI } as PostgRESTSyncSetting,
            env
        ),
        requestCount,
        responseCount,
    };
}

function oversizedHasBatchHeader(): Uint8Array {
    const bytes = new Uint8Array(20);
    bytes.set([0x4c, 0x53, 0x41, 0x42, 1, 1]);
    const view = new DataView(bytes.buffer);
    view.setUint32(8, 4_097);
    view.setBigUint64(12, BigInt(bytes.byteLength));
    return bytes;
}

describe("PostgRESTStorageAdapter integration", () => {
    it("publishes and receives native Chunks and exact transactional Commit Bundles", async () => {
        const { adapter, requestCount } = createAdapter();
        await expect(adapter.resetJournalStorage()).resolves.toBe(true);
        try {
            await expect(
                adapter.verifyCapabilities(["native-batch-chunk-cas", "transactional-metadata-commit"])
            ).resolves.toEqual({ status: "verified" });
            const candidate = await createAdaptiveJournalManifestV1({ encryption: "unencrypted" });
            await expect(adapter.createManifest(candidate.bytes)).resolves.toEqual({ status: "created" });
            await expect(adapter.readManifest()).resolves.toEqual({ status: "found", value: candidate.bytes });

            const stores = adapter.createAdaptiveJournalNativeStores(candidate.keys.repositoryId);
            const events = createAdaptiveJournalNativeEventStoreV1({ keys: candidate.keys, remote: stores.events });
            const writer = await encodeAdaptiveJournalWriterDescriptorV1({
                hostId: "postgrest-integration",
                keys: candidate.keys,
                writerEpoch: "epoch-1",
            });
            await expect(
                events.registerWriter({
                    descriptorDigest: writer.digest,
                    descriptorFrame: writer.bytes,
                    writerStreamId: writer.writerStreamId,
                })
            ).resolves.toMatchObject({ result: "inserted", status: "ok" });

            const localChunkId = "h:postgrest-integration" as DocumentID;
            const chunk = await encodeAdaptiveJournalChunkRecordV1({
                data: "native PostgREST body",
                keys: candidate.keys,
                localChunkId,
            });
            await expect(
                publishAdaptiveJournalNativeChunksV1(stores.chunks, candidate.keys, [{ localChunkId, record: chunk }])
            ).resolves.toEqual({ status: "accepted" });
            const beforeRepeatedChunk = requestCount.value;
            await expect(
                publishAdaptiveJournalNativeChunksV1(stores.chunks, candidate.keys, [{ localChunkId, record: chunk }])
            ).resolves.toEqual({ status: "accepted" });
            expect(requestCount.value).toBe(beforeRepeatedChunk + 1);
            await expect(stores.chunks.hasMany([chunk.remoteChunkKey])).resolves.toEqual({
                availability: [true],
                status: "ok",
            });
            await expect(stores.chunks.getMany([chunk.remoteChunkKey])).resolves.toEqual({
                chunks: [
                    {
                        frame: chunk.bytes,
                        frameDigest: chunk.digest,
                        key: chunk.remoteChunkKey,
                    },
                ],
                status: "ok",
            });

            const metadata = await encodeAdaptiveJournalMetadataRecordV1({
                documents: [
                    {
                        _id: "notes/postgrest.md" as DocumentID,
                        _rev: "1-integration",
                        children: [localChunkId],
                        type: "newnote",
                    } as EntryDoc,
                ],
                keys: candidate.keys,
                sequence: 1n,
                writerStreamId: writer.writerStreamId,
            });
            const missingRequired = await digestAdaptiveJournalRequiredChunkKeysV1([new Uint8Array(32).fill(0xee)]);
            const missingCommit = await encodeAdaptiveJournalCommitRecordV1({
                chunkPacks: [],
                keys: candidate.keys,
                metadata: { bytes: metadata.bytes.byteLength, digest: metadata.digest },
                previousCommitDigest: null,
                requiredChunkKeysDigest: missingRequired.digest,
                sequence: 1n,
                writerStreamId: writer.writerStreamId,
            });
            const missingEnvelope = await encodeCommitEnvelopeV1({
                commitFrame: missingCommit.bytes,
                metadataDigest: metadata.digest,
                metadataFrame: metadata.bytes,
                previousCommitDigest: null,
                repositoryId: candidate.keys.repositoryId,
                requiredChunkKeys: missingRequired.keys,
                sequence: 1n,
                writerStreamId: writer.writerStreamId,
            });
            await expect(events.commitMetadataBatch(missingEnvelope.bytes)).resolves.toEqual({
                failure: { category: "invalid-response", retry: "never" },
                status: "failed",
            });
            await expect(events.listCommitSequences(writer.writerStreamId, 0n)).resolves.toEqual({
                sequences: [],
                status: "ok",
            });

            const required = await digestAdaptiveJournalRequiredChunkKeysV1([chunk.remoteChunkKey]);
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
                metadataDigest: metadata.digest,
                metadataFrame: metadata.bytes,
                previousCommitDigest: null,
                repositoryId: candidate.keys.repositoryId,
                requiredChunkKeys: required.keys,
                sequence: 1n,
                writerStreamId: writer.writerStreamId,
            });
            await expect(
                events.putMetadataBatch({
                    metadataDigest: metadata.digest,
                    metadataFrame: metadata.bytes,
                    sequence: 1n,
                    writerStreamId: writer.writerStreamId,
                })
            ).resolves.toEqual({ result: "inserted", status: "ok" });
            await expect(events.commitMetadataBatch(envelope.bytes)).resolves.toMatchObject({
                commitDigest: commit.digest,
                result: "inserted",
                status: "ok",
            });
            await expect(events.commitMetadataBatch(envelope.bytes)).resolves.toMatchObject({
                result: "exact-existing",
                status: "ok",
            });

            const receiver = createAdaptiveJournalNativeEventStoreV1({
                keys: candidate.keys,
                remote: adapter.createAdaptiveJournalNativeStores(candidate.keys.repositoryId).events,
            });
            const beforeBundleRead = requestCount.value;
            const commitRead = await receiver.readCommit(writer.writerStreamId, 1n);
            expect(commitRead).toEqual({ status: "found", value: commit.bytes });
            const afterCommitRead = requestCount.value;
            const metadataRead = await receiver.readMetadata(writer.writerStreamId, 1n);
            expect(metadataRead).toEqual({ status: "found", value: metadata.bytes });
            expect(afterCommitRead).toBe(beforeBundleRead + 1);
            expect(requestCount.value).toBe(afterCommitRead);
            if (metadataRead.status !== "found") throw new Error("Metadata was not found");
            expect(bytesEqual(metadataRead.value, metadata.bytes)).toBe(true);
            await expect(receiver.listWriterStreamIds()).resolves.toEqual({
                status: "ok",
                writerStreamIds: [writer.writerStreamId],
            });
            await expect(receiver.listCommitSequences(writer.writerStreamId, 0n)).resolves.toEqual({
                sequences: [1n],
                status: "ok",
            });
            await expect(adapter.getUsage()).resolves.toEqual({ estimatedSize: expect.any(Number) });
        } finally {
            await adapter.resetJournalStorage();
        }
    });

    it("enforces binary limits and immutable Chunk conflicts in PostgreSQL", async () => {
        const { adapter } = createAdapter();
        await adapter.resetJournalStorage();
        try {
            const candidate = await createAdaptiveJournalManifestV1({ encryption: "unencrypted" });
            await expect(adapter.createManifest(candidate.bytes)).resolves.toEqual({ status: "created" });
            const chunks = adapter.createAdaptiveJournalNativeStores(candidate.keys.repositoryId).chunks;

            const malformedFrame = new Uint8Array(20);
            const malformedKey = new Uint8Array(32).fill(0x81);
            await expect(
                chunks.putMany([
                    { frame: malformedFrame, frameDigest: await sha256(malformedFrame), key: malformedKey },
                ])
            ).resolves.toEqual({
                failure: { category: "invalid-response", retry: "never" },
                status: "failed",
            });
            await expect(chunks.hasMany([malformedKey])).resolves.toEqual({
                availability: [false],
                status: "ok",
            });

            const limitResponse = await fetch(`${endpoint}/rpc/livesync_adaptive_chunks`, {
                body: oversizedHasBatchHeader(),
                headers: {
                    Accept: "application/octet-stream",
                    "Accept-Profile": "livesync_api",
                    "Content-Profile": "livesync_api",
                    "Content-Type": "application/octet-stream",
                    "X-LiveSync-Repository-ID": bytesToBase64Url(candidate.keys.repositoryId),
                    "X-LiveSync-Vault-Credential": vaultCredential,
                    "X-LiveSync-Vault-ID": vaultId,
                },
                method: "POST",
            });
            expect(limitResponse.status).toBe(400);
            await limitResponse.body?.cancel();

            const first = await encodeAdaptiveJournalChunkRecordV1({
                data: "first concurrent value",
                keys: candidate.keys,
                localChunkId: "h:postgrest-concurrent-a" as DocumentID,
            });
            const second = await encodeAdaptiveJournalChunkRecordV1({
                data: "second concurrent value",
                keys: candidate.keys,
                localChunkId: "h:postgrest-concurrent-b" as DocumentID,
            });
            const duplicateKey = new Uint8Array(32).fill(0x82);
            await expect(
                chunks.putMany([
                    { frame: first.bytes, frameDigest: first.digest, key: duplicateKey },
                    { frame: second.bytes, frameDigest: second.digest, key: duplicateKey },
                ])
            ).resolves.toEqual({
                failure: { category: "invalid-response", retry: "never" },
                status: "failed",
            });
            await expect(chunks.hasMany([duplicateKey])).resolves.toEqual({
                availability: [false],
                status: "ok",
            });

            const concurrentKey = new Uint8Array(32).fill(0x83);
            const concurrent = await Promise.all([
                chunks.putMany([{ frame: first.bytes, frameDigest: first.digest, key: concurrentKey }]),
                chunks.putMany([{ frame: second.bytes, frameDigest: second.digest, key: concurrentKey }]),
            ]);
            expect(concurrent.every(({ status }) => status === "ok")).toBe(true);
            const statuses = concurrent.flatMap((result) => (result.status === "ok" ? result.results : [])).sort();
            expect(statuses).toEqual(["inserted", "validate-existing"]);
            const winner = await chunks.getMany([concurrentKey]);
            expect(winner.status).toBe("ok");
            if (winner.status !== "ok" || !winner.chunks[0]) throw new Error("Concurrent Chunk winner was not stored");
            expect(
                bytesEqual(winner.chunks[0].frame, first.bytes) || bytesEqual(winner.chunks[0].frame, second.bytes)
            ).toBe(true);
        } finally {
            await adapter.resetJournalStorage();
        }
    });

    it("rejects an invalid Vault credential before exposing remote format", async () => {
        const { adapter } = createAdapter("invalid-credential");

        await expect(adapter.readManifest()).resolves.toEqual({
            failure: { category: "authentication", retry: "never" },
            status: "failed",
        });
    });

    it.skipIf(!secondaryVaultId || !secondaryVaultCredential)(
        "isolates valid Vault credentials and repository data",
        async () => {
            const primary = createAdapter().adapter;
            const secondary = createAdapter(secondaryVaultCredential!, secondaryVaultId!).adapter;
            await primary.resetJournalStorage();
            await secondary.resetJournalStorage();
            try {
                const primaryManifest = await createAdaptiveJournalManifestV1({ encryption: "unencrypted" });
                await expect(primary.createManifest(primaryManifest.bytes)).resolves.toEqual({ status: "created" });
                await expect(secondary.readManifest()).resolves.toEqual({ status: "missing" });
                await expect(createAdapter(secondaryVaultCredential!, vaultId).adapter.readManifest()).resolves.toEqual(
                    {
                        failure: { category: "authentication", retry: "never" },
                        status: "failed",
                    }
                );

                const secondaryManifest = await createAdaptiveJournalManifestV1({ encryption: "unencrypted" });
                await expect(secondary.createManifest(secondaryManifest.bytes)).resolves.toEqual({ status: "created" });
                await expect(primary.readManifest()).resolves.toEqual({
                    status: "found",
                    value: primaryManifest.bytes,
                });
                await expect(secondary.readManifest()).resolves.toEqual({
                    status: "found",
                    value: secondaryManifest.bytes,
                });
            } finally {
                await primary.resetJournalStorage();
                await secondary.resetJournalStorage();
            }
        }
    );
});
