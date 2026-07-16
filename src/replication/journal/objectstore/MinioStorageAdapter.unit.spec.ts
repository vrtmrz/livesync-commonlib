import type { S3 } from "@aws-sdk/client-s3";
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
    return { adapter, requestCount, responseCount };
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
});
