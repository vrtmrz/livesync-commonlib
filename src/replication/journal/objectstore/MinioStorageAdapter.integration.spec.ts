import { describe, it, expect } from "vitest";
import { MinioStorageAdapter } from "./MinioStorageAdapter.ts";
import type { BucketSyncSetting } from "@lib/common/types.ts";
import type { LiveSyncJournalReplicatorEnv } from "@lib/replication/journal/LiveSyncJournalReplicatorEnv.ts";
import { reactiveSource } from "octagonal-wheels/dataobject/reactive";

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
});
