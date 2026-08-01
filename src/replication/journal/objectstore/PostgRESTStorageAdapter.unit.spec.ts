import { reactiveSource } from "octagonal-wheels/dataobject/reactive";
import { describe, expect, it, vi } from "vitest";

import type { PostgRESTSyncSetting } from "@lib/common/types.ts";
import type { LiveSyncJournalReplicatorEnv } from "../LiveSyncJournalReplicatorEnv.ts";
import {
    AdaptiveBatchOperationV1,
    decodeBatchRequestV1,
    encodeBatchResponseV1,
} from "../adaptive/AdaptiveJournalBatch.ts";
import { bytesToBase64Url } from "../adaptive/AdaptiveJournalBinary.ts";
import { ADAPTIVE_JOURNAL_NATIVE_REQUIRED_CAPABILITIES_V1, sha256 } from "../adaptive/AdaptiveJournalManifest.ts";
import { PostgRESTStorageAdapter } from "./PostgRESTStorageAdapter.ts";

const CONNECTION =
    "sls+postgrest://vault-a:vault-credential@example.invalid/rest/v1?apiKey=publishable-key&schema=livesync_api";

function createAdapter(webCompatFetch: ReturnType<typeof vi.fn>, uri = CONNECTION) {
    const requestCount = reactiveSource(0);
    const responseCount = reactiveSource(0);
    const env = {
        services: {
            API: {
                nativeFetch: vi.fn(),
                requestCount,
                responseCount,
                webCompatFetch,
            },
        },
    } as unknown as LiveSyncJournalReplicatorEnv;
    return {
        adapter: new PostgRESTStorageAdapter(
            { journalFormat: "adaptive-v1", postgrestActiveConnectionURI: uri } as PostgRESTSyncSetting,
            env
        ),
        requestCount,
        responseCount,
    };
}

function binaryResponse(bytes: Uint8Array): Response {
    return new Response(bytes, { headers: { "content-type": "application/octet-stream" }, status: 200 });
}

describe("PostgRESTStorageAdapter", () => {
    it("uses scoped client credentials and keeps secrets out of its storage identity", async () => {
        const fetch = vi.fn(async () => new Response(JSON.stringify({ estimated_size: 12 }), { status: 200 }));
        const { adapter } = createAdapter(fetch);

        expect(adapter.storageIdentity).toBe(
            'postgrest:{"endpoint":"https://example.invalid/rest/v1","schema":"livesync_api","vaultId":"vault-a"}'
        );
        await expect(adapter.getUsage()).resolves.toEqual({ estimatedSize: 12 });

        const headers = new Headers(fetch.mock.calls[0][1].headers);
        expect(headers.get("apikey")).toBe("publishable-key");
        expect(headers.get("authorization")).toBeNull();
        expect(headers.get("accept-profile")).toBe("livesync_api");
        expect(headers.get("content-profile")).toBe("livesync_api");
        expect(headers.get("x-livesync-vault-id")).toBe("vault-a");
        expect(headers.get("x-livesync-vault-credential")).toBe("vault-credential");
        expect(adapter.storageIdentity).not.toContain("credential");
        expect(adapter.storageIdentity).not.toContain("publishable-key");
    });

    it("rejects privileged Supabase credentials and every Opaque operation before a request", async () => {
        const fetch = vi.fn();
        const secret = createAdapter(
            fetch,
            "sls+postgrest://vault:credential@example.invalid/rest/v1?apiKey=sb_secret_private"
        ).adapter;

        expect(() => secret.storageIdentity).toThrow("secret API key");
        const { adapter } = createAdapter(fetch);
        await expect(adapter.upload("opaque", new Uint8Array(), "application/octet-stream")).rejects.toThrow(
            "only the Adaptive format"
        );
        await expect(adapter.download("opaque")).rejects.toThrow("only the Adaptive format");
        await expect(adapter.listFiles("")).rejects.toThrow("only the Adaptive format");
        await expect(adapter.deleteFiles([])).rejects.toThrow("only the Adaptive format");
        expect(fetch).not.toHaveBeenCalled();
    });

    it("actively verifies native capabilities and binary fidelity once", async () => {
        const fetch = vi.fn(async (url: string, init: RequestInit) => {
            if (url.endsWith("/livesync_adaptive_capabilities")) {
                return new Response(
                    JSON.stringify({
                        capabilities: ADAPTIVE_JOURNAL_NATIVE_REQUIRED_CAPABILITIES_V1,
                        format_version: 1,
                    }),
                    { headers: { "content-type": "application/json" }, status: 200 }
                );
            }
            if (url.endsWith("/livesync_adaptive_binary_echo")) {
                return binaryResponse(new Uint8Array(await new Response(init.body).arrayBuffer()));
            }
            return new Response(null, { status: 500 });
        });
        const { adapter, requestCount, responseCount } = createAdapter(fetch);

        await expect(adapter.verifyCapabilities(ADAPTIVE_JOURNAL_NATIVE_REQUIRED_CAPABILITIES_V1)).resolves.toEqual({
            status: "verified",
        });
        await expect(adapter.verifyCapabilities(ADAPTIVE_JOURNAL_NATIVE_REQUIRED_CAPABILITIES_V1)).resolves.toEqual({
            status: "verified",
        });

        expect(fetch).toHaveBeenCalledTimes(2);
        expect(requestCount.value).toBe(2);
        expect(responseCount.value).toBe(2);
    });

    it("dispatches batched HAS, GET, and PUT through one binary Chunk RPC", async () => {
        const firstKey = new Uint8Array(32).fill(1);
        const secondKey = new Uint8Array(32).fill(2);
        const firstFrame = new TextEncoder().encode("first-frame");
        const secondFrame = new TextEncoder().encode("second-frame");
        const firstDigest = await sha256(firstFrame);
        const secondDigest = await sha256(secondFrame);
        const operations: AdaptiveBatchOperationV1[] = [];
        const fetch = vi.fn(async (url: string, init: RequestInit) => {
            expect(url).toBe("https://example.invalid/rest/v1/rpc/livesync_adaptive_chunks");
            const request = decodeBatchRequestV1(new Uint8Array(await new Response(init.body).arrayBuffer()));
            operations.push(request.operation);
            if (request.operation === AdaptiveBatchOperationV1.Has) {
                return binaryResponse(
                    encodeBatchResponseV1({
                        entries: [{ status: "missing" }, { status: "present" }],
                        operation: request.operation,
                    })
                );
            }
            if (request.operation === AdaptiveBatchOperationV1.Get) {
                return binaryResponse(
                    encodeBatchResponseV1({
                        entries: [
                            { status: "missing" },
                            { frame: secondFrame, frameDigest: secondDigest, status: "found" },
                        ],
                        operation: request.operation,
                    })
                );
            }
            return binaryResponse(
                encodeBatchResponseV1({
                    entries: [{ status: "inserted" }, { status: "exact-existing" }],
                    operation: request.operation,
                })
            );
        });
        const { adapter } = createAdapter(fetch);
        const repositoryId = new Uint8Array(32).fill(0x77);
        const store = adapter.createAdaptiveJournalNativeStores(repositoryId).chunks;

        await expect(store.hasMany([firstKey, secondKey])).resolves.toEqual({
            availability: [false, true],
            status: "ok",
        });
        await expect(store.getMany([firstKey, secondKey])).resolves.toEqual({
            chunks: [undefined, { frame: secondFrame, frameDigest: secondDigest, key: secondKey }],
            status: "ok",
        });
        await expect(
            store.putMany([
                { frame: firstFrame, frameDigest: firstDigest, key: firstKey },
                { frame: secondFrame, frameDigest: secondDigest, key: secondKey },
            ])
        ).resolves.toEqual({ results: ["inserted", "exact-existing"], status: "ok" });

        expect(operations).toEqual([
            AdaptiveBatchOperationV1.Has,
            AdaptiveBatchOperationV1.Get,
            AdaptiveBatchOperationV1.Put,
        ]);
        expect(new Headers(fetch.mock.calls[0][1].headers).get("x-livesync-repository-id")).toBe(
            bytesToBase64Url(repositoryId)
        );
    });

    it("partitions large Chunk PUT bodies below the preferred request target", async () => {
        const frameBytes = 17 * 1024 * 1024;
        const firstFrame = new Uint8Array(frameBytes).fill(0x31);
        const secondFrame = new Uint8Array(frameBytes).fill(0x32);
        const firstKey = new Uint8Array(32).fill(0x41);
        const secondKey = new Uint8Array(32).fill(0x42);
        const putBatchSizes: number[] = [];
        const fetch = vi.fn(async (_url: string, init: RequestInit) => {
            const request = decodeBatchRequestV1(init.body as Uint8Array);
            expect(request.operation).toBe(AdaptiveBatchOperationV1.Put);
            putBatchSizes.push(request.entries.length);
            return binaryResponse(
                encodeBatchResponseV1({
                    entries: request.entries.map(() => ({ status: "inserted" as const })),
                    operation: request.operation,
                })
            );
        });
        const store = createAdapter(fetch).adapter.createAdaptiveJournalNativeStores(
            new Uint8Array(32).fill(0x33)
        ).chunks;

        await expect(
            store.putMany([
                { frame: firstFrame, frameDigest: await sha256(firstFrame), key: firstKey },
                { frame: secondFrame, frameDigest: await sha256(secondFrame), key: secondKey },
            ])
        ).resolves.toEqual({ results: ["inserted", "inserted"], status: "ok" });
        expect(putBatchSizes).toEqual([1, 1]);
    });

    it("bisects a Chunk PUT when the gateway rejects its request body size", async () => {
        const firstFrame = new TextEncoder().encode("first request frame");
        const secondFrame = new TextEncoder().encode("second request frame");
        const putBatchSizes: number[] = [];
        const fetch = vi.fn(async (_url: string, init: RequestInit) => {
            const request = decodeBatchRequestV1(init.body as Uint8Array);
            expect(request.operation).toBe(AdaptiveBatchOperationV1.Put);
            putBatchSizes.push(request.entries.length);
            if (request.entries.length > 1) return new Response(null, { status: 413 });
            return binaryResponse(
                encodeBatchResponseV1({
                    entries: [{ status: "inserted" }],
                    operation: request.operation,
                })
            );
        });
        const store = createAdapter(fetch).adapter.createAdaptiveJournalNativeStores(
            new Uint8Array(32).fill(0x43)
        ).chunks;

        await expect(
            store.putMany([
                {
                    frame: firstFrame,
                    frameDigest: await sha256(firstFrame),
                    key: new Uint8Array(32).fill(0x44),
                },
                {
                    frame: secondFrame,
                    frameDigest: await sha256(secondFrame),
                    key: new Uint8Array(32).fill(0x45),
                },
            ])
        ).resolves.toEqual({ results: ["inserted", "inserted"], status: "ok" });
        expect(putBatchSizes).toEqual([2, 1, 1]);
    });

    it("bisects a Chunk GET when the server reports that its response would be too large", async () => {
        const firstKey = new Uint8Array(32).fill(0x51);
        const secondKey = new Uint8Array(32).fill(0x52);
        const firstFrame = new TextEncoder().encode("first response frame");
        const secondFrame = new TextEncoder().encode("second response frame");
        const getBatchSizes: number[] = [];
        const fetch = vi.fn(async (_url: string, init: RequestInit) => {
            const request = decodeBatchRequestV1(init.body as Uint8Array);
            expect(request.operation).toBe(AdaptiveBatchOperationV1.Get);
            getBatchSizes.push(request.entries.length);
            if (request.entries.length > 1) return new Response(null, { status: 413 });
            const frame = request.entries[0].key[0] === firstKey[0] ? firstFrame : secondFrame;
            return binaryResponse(
                encodeBatchResponseV1({
                    entries: [{ frame, frameDigest: await sha256(frame), status: "found" }],
                    operation: request.operation,
                })
            );
        });
        const store = createAdapter(fetch).adapter.createAdaptiveJournalNativeStores(
            new Uint8Array(32).fill(0x53)
        ).chunks;

        await expect(store.getMany([firstKey, secondKey])).resolves.toEqual({
            chunks: [
                { frame: firstFrame, frameDigest: await sha256(firstFrame), key: firstKey },
                { frame: secondFrame, frameDigest: await sha256(secondFrame), key: secondKey },
            ],
            status: "ok",
        });
        expect(getBatchSizes).toEqual([2, 1, 1]);
    });

    it("accepts an explicit mutation response without a read-back and marks transport ambiguity verify-first", async () => {
        const key = new Uint8Array(32).fill(1);
        const frame = new TextEncoder().encode("frame");
        const digest = await sha256(frame);
        const successfulFetch = vi.fn(async (_url: string, init: RequestInit) => {
            const request = decodeBatchRequestV1(new Uint8Array(await new Response(init.body).arrayBuffer()));
            return binaryResponse(
                encodeBatchResponseV1({ entries: [{ status: "inserted" }], operation: request.operation })
            );
        });
        const successful = createAdapter(successfulFetch).adapter.createAdaptiveJournalNativeStores(
            new Uint8Array(32).fill(2)
        ).chunks;

        await expect(successful.putMany([{ frame, frameDigest: digest, key }])).resolves.toEqual({
            results: ["inserted"],
            status: "ok",
        });
        expect(successfulFetch).toHaveBeenCalledOnce();

        const failedFetch = vi.fn(async () => {
            throw new Error("connection closed after commit");
        });
        const ambiguous = createAdapter(failedFetch).adapter.createAdaptiveJournalNativeStores(
            new Uint8Array(32).fill(2)
        ).chunks;
        await expect(ambiguous.putMany([{ frame, frameDigest: digest, key }])).resolves.toEqual({
            failure: { category: "unavailable", retry: "verify-first" },
            status: "failed",
        });
        expect(failedFetch).toHaveBeenCalledOnce();
    });

    it("maps native Writer and Commit discovery to scoped typed RPCs", async () => {
        const repositoryId = new Uint8Array(32).fill(0x31);
        const writerStreamId = new Uint8Array(32).fill(0x32);
        const descriptor = new Uint8Array([1, 2]);
        const bundle = new Uint8Array([3, 4]);
        const fetch = vi.fn(async (url: string) => {
            if (url.endsWith("/livesync_adaptive_writer_create")) return new Response("0", { status: 200 });
            if (url.endsWith("/livesync_adaptive_commit_create")) return new Response("1", { status: 200 });
            if (url.endsWith("/livesync_adaptive_writer_get")) return binaryResponse(descriptor);
            if (url.endsWith("/livesync_adaptive_commit_get")) return binaryResponse(bundle);
            if (url.endsWith("/livesync_adaptive_writer_list")) {
                return new Response(JSON.stringify([bytesToBase64Url(writerStreamId)]), { status: 200 });
            }
            if (url.includes("/livesync_adaptive_commit_list?")) {
                return new Response(JSON.stringify(["2", "3"]), { status: 200 });
            }
            return new Response(null, { status: 500 });
        });
        const events = createAdapter(fetch).adapter.createAdaptiveJournalNativeStores(repositoryId).events;

        await expect(
            events.registerWriter({
                descriptorDigest: await sha256(descriptor),
                descriptorFrame: descriptor,
                writerStreamId,
            })
        ).resolves.toEqual({ result: "inserted", status: "ok" });
        await expect(events.commitMetadataBatch(bundle)).resolves.toEqual({ result: "exact-existing", status: "ok" });
        await expect(events.readWriter(writerStreamId)).resolves.toEqual({ status: "found", value: descriptor });
        await expect(events.readCommitBundle(writerStreamId, 1n)).resolves.toEqual({ status: "found", value: bundle });
        await expect(events.listWriterStreamIds()).resolves.toEqual({
            status: "ok",
            writerStreamIds: [writerStreamId],
        });
        await expect(events.listCommitSequences(writerStreamId, 1n)).resolves.toEqual({
            sequences: [2n, 3n],
            status: "ok",
        });

        expect(fetch).toHaveBeenCalledTimes(6);
        expect(new Headers(fetch.mock.calls[0][1].headers).get("x-livesync-writer-stream-id")).toBe(
            bytesToBase64Url(writerStreamId)
        );
    });

    it("reports only empty or Adaptive format and resets all scoped native rows transactionally", async () => {
        let manifest: Uint8Array | undefined;
        const fetch = vi.fn(async (url: string, init: RequestInit) => {
            if (url.endsWith("/livesync_adaptive_manifest_get")) {
                return manifest ? binaryResponse(manifest) : new Response(null, { status: 404 });
            }
            if (url.endsWith("/livesync_adaptive_manifest_create")) {
                if (manifest) return new Response("1", { status: 200 });
                manifest = new Uint8Array(await new Response(init.body).arrayBuffer());
                return new Response("0", { status: 200 });
            }
            if (url.endsWith("/livesync_adaptive_reset")) {
                manifest = undefined;
                return new Response("4", { status: 200 });
            }
            return new Response(null, { status: 500 });
        });
        const { adapter } = createAdapter(fetch);
        const bytes = new TextEncoder().encode("manifest");

        await expect(adapter.inspectRemoteFormat()).resolves.toBe("empty");
        await expect(adapter.createManifest(bytes)).resolves.toEqual({ status: "created" });
        await expect(adapter.inspectRemoteFormat()).resolves.toBe("adaptive-v1");
        await expect(adapter.resetJournalStorage()).resolves.toBe(true);
        await expect(adapter.inspectRemoteFormat()).resolves.toBe("empty");
    });
});
