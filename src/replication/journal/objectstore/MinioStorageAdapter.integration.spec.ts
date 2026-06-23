import { describe, it, expect } from "vitest";
import { MinioStorageAdapter } from "./MinioStorageAdapter.ts";
import type { BucketSyncSetting } from "@lib/common/types.ts";
import type { LiveSyncJournalReplicatorEnv } from "@lib/replication/journal/LiveSyncJournalReplicatorEnv.ts";

describe("MinioStorageAdapter Integration Tests", () => {
    // Requires minioEndpoint, accessKey, secretKey, bucketName in env
    const endpoint = process.env.minioEndpoint;
    const accessKey = process.env.accessKey;
    const secretKey = process.env.secretKey;
    const bucket = process.env.bucketName || "test-bucket";

    const isIntegrationEnvironmentReady = !!(endpoint && accessKey && secretKey);

    it.runIf(isIntegrationEnvironmentReady)("should upload, download, and delete a file", async () => {
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

        // Mock env
        const env = {
            services: {
                API: {
                    getCustomFetchHandler: () => undefined,
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
    });

    it("skips tests if MinIO environment variables are not set", () => {
        if (!isIntegrationEnvironmentReady) {
            console.warn(
                "Skipping MinioStorageAdapter integration tests. Please set minioEndpoint, accessKey, secretKey."
            );
        }
        expect(true).toBe(true);
    });
});
