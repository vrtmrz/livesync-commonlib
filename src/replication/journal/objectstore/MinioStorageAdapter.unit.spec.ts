import { DeleteObjectsCommand, GetObjectCommand, PutObjectCommand, type S3 } from "@aws-sdk/client-s3";
import type { FetchHttpHandler } from "@smithy/fetch-http-handler";
import { HttpResponse } from "@smithy/protocol-http";
import { reactiveSource } from "octagonal-wheels/dataobject/reactive";
import { promiseWithResolvers } from "octagonal-wheels/promises";
import { describe, expect, it, vi } from "vitest";

import type { BucketSyncSetting } from "@lib/common/types.ts";
import type { LiveSyncJournalReplicatorEnv } from "@lib/replication/journal/LiveSyncJournalReplicatorEnv.ts";
import { MinioStorageAdapter } from "./MinioStorageAdapter.ts";

type MockS3Client = {
    listObjectsV2?: ReturnType<typeof vi.fn>;
    send: ReturnType<typeof vi.fn>;
};

function createAdapter(client: MockS3Client) {
    const requestCount = reactiveSource(0);
    const responseCount = reactiveSource(0);
    const settings = {
        endpoint: "https://example.invalid",
        accessKey: "access-key",
        secretKey: "secret-key",
        bucket: "bucket",
        region: "us-east-1",
        bucketPrefix: "test/",
        forcePathStyle: true,
        useCustomRequestHandler: false,
        bucketCustomHeaders: "",
    } as BucketSyncSetting;
    const env = {
        services: {
            API: {
                getCustomFetchHandler: () => undefined,
                requestCount,
                responseCount,
            },
        },
    } as unknown as LiveSyncJournalReplicatorEnv;
    const adapter = new MinioStorageAdapter(settings, env);
    adapter._instance = client as unknown as S3;
    return { adapter, requestCount, responseCount, settings };
}

function createStatefulAdaptiveS3() {
    const objects = new Map<string, Uint8Array>();
    const send = vi.fn(async (command: unknown) => {
        if (command instanceof PutObjectCommand) {
            const key = command.input.Key!;
            if (command.input.IfNoneMatch === "*" && objects.has(key)) {
                throw Object.assign(new Error("precondition failed"), {
                    $metadata: { httpStatusCode: 412 },
                    name: "PreconditionFailed",
                });
            }
            objects.set(key, new Uint8Array(command.input.Body as Uint8Array));
            return { $metadata: { httpStatusCode: 200 }, ETag: `\"${key}\"` };
        }
        if (command instanceof GetObjectCommand) {
            const key = command.input.Key!;
            const stored = objects.get(key);
            if (!stored) {
                throw Object.assign(new Error("missing"), {
                    $metadata: { httpStatusCode: 404 },
                    name: "NoSuchKey",
                });
            }
            const range = command.input.Range?.match(/^bytes=([0-9]+)-([0-9]+)$/u);
            const value = range ? stored.slice(Number(range[1]), Number(range[2]) + 1) : stored.slice();
            return {
                $metadata: { httpStatusCode: range ? 206 : 200 },
                Body: { transformToByteArray: async () => value },
                ...(range ? { ContentRange: `bytes ${range[1]}-${range[2]}/${stored.byteLength}` } : {}),
                ETag: `\"${key}\"`,
            };
        }
        if (command instanceof DeleteObjectsCommand) {
            const deleted = (command.input.Delete?.Objects ?? []).map(({ Key }) => {
                if (Key) objects.delete(Key);
                return { Key };
            });
            return { $metadata: { httpStatusCode: 200 }, Deleted: deleted, Errors: [] };
        }
        throw new Error("Unexpected S3 command");
    });
    const listObjectsV2 = vi.fn(async (input: { Prefix?: string; StartAfter?: string }) => ({
        Contents: [...objects.keys()]
            .filter(
                (key) =>
                    (!input.Prefix || key.startsWith(input.Prefix)) && (!input.StartAfter || key > input.StartAfter)
            )
            .sort()
            .map((Key) => ({ Key })),
        IsTruncated: false,
    }));
    return { ...createAdapter({ listObjectsV2, send }), listObjectsV2, objects, send };
}

describe("MinioStorageAdapter physical request activity", () => {
    it("tracks an SDK command while it is in progress", async () => {
        const request = promiseWithResolvers<object>();
        const { adapter, requestCount, responseCount } = createAdapter({ send: vi.fn(() => request.promise) });

        const uploading = adapter.upload("file.txt", new TextEncoder().encode("content"), "text/plain");

        await vi.waitFor(() => expect(requestCount.value - responseCount.value).toBe(1));
        request.resolve({});
        await expect(uploading).resolves.toBe(true);
        expect(requestCount.value).toBe(1);
        expect(responseCount.value).toBe(1);
    });

    it("keeps a download active until its response body has been consumed", async () => {
        const body = promiseWithResolvers<Uint8Array>();
        const send = vi.fn(() =>
            Promise.resolve({
                Body: {
                    transformToByteArray: () => body.promise,
                },
            })
        );
        const { adapter, requestCount, responseCount } = createAdapter({ send });

        const downloading = adapter.download("file.txt");

        await vi.waitFor(() => expect(requestCount.value - responseCount.value).toBe(1));
        body.resolve(new Uint8Array([1, 2, 3]));
        await expect(downloading).resolves.toEqual(new Uint8Array([1, 2, 3]));
        expect(requestCount.value).toBe(1);
        expect(responseCount.value).toBe(1);
    });

    it("balances activity when an SDK command rejects", async () => {
        const { adapter, requestCount, responseCount } = createAdapter({
            send: vi.fn(() => Promise.reject(new Error("network failed"))),
        });

        await expect(adapter.upload("file.txt", new Uint8Array(), "text/plain")).resolves.toBe(false);

        expect(requestCount.value).toBe(1);
        expect(responseCount.value).toBe(1);
    });

    it("tracks each supported Object Storage command unit", async () => {
        const send = vi.fn(() => Promise.resolve({}));
        const listObjectsV2 = vi.fn(() => Promise.resolve({ Contents: [] }));
        const { adapter, requestCount, responseCount } = createAdapter({ listObjectsV2, send });

        await expect(adapter.listFiles("")).resolves.toEqual([]);
        await expect(adapter.deleteFiles(["file.txt"])).resolves.toBe(true);
        await expect(adapter.isAvailable()).resolves.toBe(true);
        await expect(adapter.getUsage()).resolves.toEqual({ estimatedSize: 0 });

        expect(requestCount.value).toBe(4);
        expect(responseCount.value).toBe(4);
    });

    it("tracks the custom request-handler path once at the SDK command boundary", async () => {
        const request = promiseWithResolvers<{ response: HttpResponse }>();
        const handle = vi.fn(() => request.promise);
        const requestCount = reactiveSource(0);
        const responseCount = reactiveSource(0);
        const env = {
            services: {
                API: {
                    getCustomFetchHandler: () => ({ handle }) as unknown as FetchHttpHandler,
                    requestCount,
                    responseCount,
                },
            },
        } as unknown as LiveSyncJournalReplicatorEnv;
        const settings = {
            endpoint: "https://example.invalid",
            accessKey: "access-key",
            secretKey: "secret-key",
            bucket: "bucket",
            region: "us-east-1",
            bucketPrefix: "test/",
            forcePathStyle: true,
            useCustomRequestHandler: true,
            bucketCustomHeaders: "",
        } as BucketSyncSetting;
        const adapter = new MinioStorageAdapter(settings, env);

        const uploading = adapter.upload("file.txt", new TextEncoder().encode("content"), "text/plain");

        await vi.waitFor(() => {
            expect(requestCount.value - responseCount.value).toBe(1);
            expect(handle).toHaveBeenCalledOnce();
        });
        request.resolve({ response: new HttpResponse({ headers: {}, statusCode: 200 }) });
        await expect(uploading).resolves.toBe(true);
        expect(requestCount.value).toBe(1);
        expect(responseCount.value).toBe(1);
    });

    it("retains the S3 client for protocol-only changes and replaces it for connection changes", () => {
        const client = { send: vi.fn() };
        const { adapter, settings } = createAdapter(client);
        const storageIdentity = adapter.storageIdentity;

        adapter.applyNewConfig({
            ...settings,
            journalFormat: "adaptive-v1",
            packReadPolicy: "range",
        });
        expect(adapter._instance).toBe(client);
        expect(adapter.storageIdentity).toBe(storageIdentity);

        adapter.applyNewConfig({ ...settings, secretKey: "rotated-secret" });
        expect(adapter._instance).toBeUndefined();
        expect(adapter.storageIdentity).toBe(storageIdentity);

        adapter.applyNewConfig({ ...settings, bucketPrefix: "another-vault/" });
        expect(adapter.storageIdentity).not.toBe(storageIdentity);
    });

    it("uses an S3 conditional create for immutable Adaptive objects", async () => {
        const send = vi.fn(async (command: unknown) => {
            expect(command).toBeInstanceOf(PutObjectCommand);
            expect((command as PutObjectCommand).input).toMatchObject({
                Bucket: "bucket",
                IfNoneMatch: "*",
                Key: "test/a1~manifest.json",
            });
            throw Object.assign(new Error("precondition failed"), {
                $metadata: { httpStatusCode: 412 },
                name: "PreconditionFailed",
            });
        });
        const { adapter } = createAdapter({ send });

        await expect(
            adapter.createAdaptiveObject("a1~manifest.json", new Uint8Array([1, 2, 3]), "application/json")
        ).resolves.toEqual({ status: "already-exists" });
    });

    it("returns an exact byte range for an Adaptive pack read", async () => {
        const send = vi.fn(async (command: unknown) => {
            expect(command).toBeInstanceOf(GetObjectCommand);
            expect((command as GetObjectCommand).input).toMatchObject({
                Bucket: "bucket",
                Key: "test/a1~pack~one.bin",
                Range: "bytes=1-3",
            });
            return {
                $metadata: { httpStatusCode: 206 },
                Body: { transformToByteArray: async () => new Uint8Array([2, 3, 4]) },
                ContentRange: "bytes 1-3/5",
                ETag: '"pack-etag"',
            };
        });
        const { adapter } = createAdapter({ send });

        await expect(adapter.readAdaptiveObject("a1~pack~one.bin", { length: 3, offset: 1 })).resolves.toEqual({
            identity: '"pack-etag"',
            status: "found",
            value: new Uint8Array([2, 3, 4]),
        });
    });

    it("paginates complete Adaptive prefix listings", async () => {
        const listObjectsV2 = vi
            .fn()
            .mockResolvedValueOnce({
                Contents: [{ Key: "test/a1~catalogue~one" }],
                IsTruncated: true,
                NextContinuationToken: "page-two",
            })
            .mockResolvedValueOnce({
                Contents: [{ Key: "test/a1~catalogue~two" }],
                IsTruncated: false,
            });
        const { adapter } = createAdapter({ listObjectsV2, send: vi.fn() });

        await expect(adapter.listAdaptiveObjects("a1~catalogue~")).resolves.toEqual({
            keys: ["a1~catalogue~one", "a1~catalogue~two"],
            status: "ok",
        });
        expect(listObjectsV2).toHaveBeenNthCalledWith(2, expect.objectContaining({ ContinuationToken: "page-two" }));
    });

    it.each([
        { expected: "empty", keys: [] },
        { expected: "empty", keys: [""] },
        { expected: "empty", keys: ["a1~probe~orphan.bin"] },
        { expected: "opaque-v1", keys: ["0001-journal.jsonl.gz"] },
        { expected: "opaque-v1", keys: ["a1~probe~orphan.bin", "z-opaque-object"] },
        { expected: "adaptive-v1", keys: ["a1~manifest.json", "a1~writer~one"] },
        { expected: "adaptive-v1", keys: ["a1~probe~orphan.bin", "a1~writer~one"] },
        { expected: "mixed", keys: ["a1~manifest.json", "z-opaque-object"] },
    ] as const)("detects $expected S3 Journal storage", async ({ expected, keys }) => {
        const listObjectsV2 = vi.fn(async (input: { MaxKeys?: number; Prefix?: string; StartAfter?: string }) => ({
            Contents: keys
                .map((key) => `test/${key}`)
                .filter(
                    (key) =>
                        (!input.Prefix || key.startsWith(input.Prefix)) && (!input.StartAfter || key > input.StartAfter)
                )
                .sort()
                .slice(0, input.MaxKeys)
                .map((Key) => ({ Key })),
            IsTruncated: false,
        }));
        const { adapter } = createAdapter({ listObjectsV2, send: vi.fn() });

        await expect(adapter.inspectRemoteFormat()).resolves.toBe(expected);
    });

    it("actively verifies and caches the selected Adaptive capabilities without leaving probe objects", async () => {
        const { adapter, objects, send, settings } = createStatefulAdaptiveS3();
        const required = [
            "binary-fidelity",
            "complete-listing",
            "conditional-create",
            "delete-visibility",
            "read-after-write",
            "byte-range",
        ];

        await expect(adapter.verifyCapabilities(required)).resolves.toEqual({ status: "verified" });
        expect(objects.size).toBe(0);
        const requestsAfterFirstProbe = send.mock.calls.length;

        adapter.applyNewConfig({ ...settings, journalFormat: "adaptive-v1" });
        await expect(adapter.verifyCapabilities(required)).resolves.toEqual({ status: "verified" });
        expect(send).toHaveBeenCalledTimes(requestsAfterFirstProbe);
    });

    it("retries a transient capability failure instead of caching it", async () => {
        const { adapter, objects, send } = createStatefulAdaptiveS3();
        send.mockRejectedValueOnce(
            Object.assign(new Error("upstream unavailable"), {
                $metadata: { httpStatusCode: 503 },
                name: "ServiceUnavailable",
            })
        );
        const required = [
            "binary-fidelity",
            "complete-listing",
            "conditional-create",
            "delete-visibility",
            "read-after-write",
        ];

        await expect(adapter.verifyCapabilities(required)).resolves.toEqual({
            failure: { category: "unavailable", retry: "verify-first" },
            status: "failed",
        });
        await expect(adapter.verifyCapabilities(required)).resolves.toEqual({ status: "verified" });
        expect(objects.size).toBe(0);
    });

    it("does not cache a capability probe whose owned-object cleanup failed", async () => {
        const { adapter, objects } = createStatefulAdaptiveS3();
        vi.spyOn(adapter, "deleteFiles").mockResolvedValueOnce(false);
        const required = [
            "binary-fidelity",
            "complete-listing",
            "conditional-create",
            "delete-visibility",
            "read-after-write",
        ];

        await expect(adapter.verifyCapabilities(required)).resolves.toEqual({
            failure: { category: "unavailable", retry: "later" },
            status: "failed",
        });
        await expect(adapter.verifyCapabilities(required)).resolves.toEqual({ status: "verified" });

        await expect(adapter.resetJournalStorage()).resolves.toBe(true);
        expect(objects.size).toBe(0);
    });

    it("marks ambiguous Adaptive writes for read-back verification", async () => {
        const send = vi.fn(async () => {
            throw Object.assign(new Error("upstream unavailable"), {
                $metadata: { httpStatusCode: 503 },
                name: "ServiceUnavailable",
            });
        });
        const { adapter } = createAdapter({ send });

        await expect(
            adapter.createAdaptiveObject("a1~commit~one", new Uint8Array([1]), "application/octet-stream")
        ).resolves.toEqual({
            failure: { category: "unavailable", retry: "verify-first" },
            status: "failed",
        });
    });

    it("marks an explicit conditional-write conflict as safe to retry later", async () => {
        const send = vi.fn(async () => {
            throw Object.assign(new Error("conditional request conflict"), {
                $metadata: { httpStatusCode: 409 },
                name: "ConditionalRequestConflict",
            });
        });
        const { adapter } = createAdapter({ send });

        await expect(
            adapter.createAdaptiveObject("a1~commit~one", new Uint8Array([1]), "application/octet-stream")
        ).resolves.toEqual({
            failure: { category: "unavailable", retry: "later" },
            status: "failed",
        });
    });

    it("removes every object under the configured prefix during a remote rebuild", async () => {
        const { adapter, objects } = createStatefulAdaptiveS3();
        objects.set("test/a1~manifest.json", new Uint8Array([1]));
        objects.set("test/a1~pack~one.bin", new Uint8Array([2]));

        await expect(adapter.resetJournalStorage()).resolves.toBe(true);
        expect(objects.size).toBe(0);
        await expect(adapter.inspectRemoteFormat()).resolves.toBe("empty");
    });
});
