import { describe, it, expect } from "vitest";
import { MinioStorageAdapter } from "./MinioStorageAdapter.ts";
import type { BucketSyncSetting } from "@lib/common/types.ts";
import type { LiveSyncJournalReplicatorEnv } from "@lib/replication/journal/LiveSyncJournalReplicatorEnv.ts";
import { reactiveSource } from "octagonal-wheels/dataobject/reactive";
import { ADAPTIVE_JOURNAL_REQUIRED_CAPABILITIES_V1 } from "../adaptive/AdaptiveJournalManifest.ts";

describe("MinioStorageAdapter Integration Tests", () => {
    const endpoint = process.env.minioEndpoint ?? "http://127.0.0.1:9000";
    const accessKey = process.env.accessKey ?? "minioadmin";
    const secretKey = process.env.secretKey ?? "minioadmin";
    const bucket = process.env.bucketName ?? "livesync-test-bucket";

    it("should upload, download, and delete a file", async () => {
        const settings = {
            endpoint,
            accessKey,
            secretKey,
            bucket,
            region: "us-east-1",
            bucketPrefix: "test/",
            forcePathStyle: true,
            useCustomRequestHandler: false,
            bucketCustomHeaders: "",
        } as BucketSyncSetting;

        const requestCount = reactiveSource(0);
        const responseCount = reactiveSource(0);

        // Mock env
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

        const isAvailable = await adapter.isAvailable();
        expect(isAvailable).toBe(true);

        const testContent = new TextEncoder().encode("Hello Integration Test");
        const testKey = `integration-test-${Date.now()}.txt`;

        // Upload
        const uploadResult = await adapter.upload(testKey, testContent, "text/plain");
        expect(uploadResult).toBe(true);

        // List
        const files = await adapter.listFiles("");
        expect(files).toContain(testKey);

        // Download
        const downloaded = await adapter.download(testKey, true);
        expect(downloaded).toBeTruthy();
        expect(new TextDecoder().decode(downloaded as Uint8Array)).toBe("Hello Integration Test");

        // Delete
        const deleteResult = await adapter.deleteFiles([testKey]);
        expect(deleteResult).toBe(true);

        // List again
        const filesAfterDelete = await adapter.listFiles("");
        expect(filesAfterDelete).not.toContain(testKey);
        expect(requestCount.value).toBeGreaterThan(0);
        expect(responseCount.value).toBe(requestCount.value);
    });

    it("supports the Adaptive immutable-object contract, Range reads, and rebuilds", async () => {
        const settings = {
            endpoint,
            accessKey,
            secretKey,
            bucket,
            region: "us-east-1",
            bucketPrefix: `adaptive-adapter-${process.pid}-${Date.now()}/`,
            forcePathStyle: true,
            useCustomRequestHandler: false,
            bucketCustomHeaders: "",
            journalFormat: "adaptive-v1",
            packReadPolicy: "range",
        } as BucketSyncSetting;
        const env = {
            services: {
                API: {
                    getCustomFetchHandler: () => undefined,
                    requestCount: reactiveSource(0),
                    responseCount: reactiveSource(0),
                },
            },
        } as unknown as LiveSyncJournalReplicatorEnv;
        const adapter = new MinioStorageAdapter(settings, env);
        const key = "a1~pack~integration.bin";
        const bytes = new Uint8Array([0, 1, 2, 3, 4, 5]);

        try {
            await expect(
                adapter.verifyCapabilities([...ADAPTIVE_JOURNAL_REQUIRED_CAPABILITIES_V1, "byte-range"])
            ).resolves.toEqual({ status: "verified" });
            await expect(adapter.createAdaptiveObject(key, bytes, "application/octet-stream")).resolves.toMatchObject({
                status: "created",
            });
            await expect(
                adapter.createAdaptiveObject(key, new Uint8Array([9]), "application/octet-stream")
            ).resolves.toMatchObject({ status: "already-exists" });
            await expect(adapter.readAdaptiveObject(key, { length: 3, offset: 2 })).resolves.toMatchObject({
                status: "found",
                value: new Uint8Array([2, 3, 4]),
            });
            await expect(adapter.listAdaptiveObjects("a1~pack~")).resolves.toEqual({
                keys: [key],
                status: "ok",
            });
            await expect(adapter.inspectRemoteFormat()).resolves.toBe("adaptive-v1");
        } finally {
            await expect(adapter.resetJournalStorage()).resolves.toBe(true);
        }
        await expect(adapter.inspectRemoteFormat()).resolves.toBe("empty");
    });
});
