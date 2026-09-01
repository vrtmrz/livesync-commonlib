import { describe, it, expect } from "vitest";
import { MinioStorageAdapter } from "./MinioStorageAdapter.ts";
import type { BucketSyncSetting } from "@lib/common/types.ts";
import type { LiveSyncJournalReplicatorEnv } from "@lib/replication/journal/LiveSyncJournalReplicatorEnv.ts";
import { reactiveSource } from "octagonal-wheels/dataobject/reactive";
import { JournalStorageReadStatuses } from "./JournalStorageAdapter.ts";

describe("MinioStorageAdapter Integration Tests", () => {
    const endpoint = process.env.minioEndpoint ?? "http://127.0.0.1:9000";
    const accessKey = process.env.accessKey ?? "minioadmin";
    const secretKey = process.env.secretKey ?? "minioadmin";
    const bucket = process.env.bucketName ?? "livesync-test-bucket";

    function createSettings(overrides: Partial<BucketSyncSetting> = {}): BucketSyncSetting {
        return {
            endpoint,
            accessKey,
            secretKey,
            bucket,
            region: "us-east-1",
            bucketPrefix: "test/",
            forcePathStyle: true,
            useCustomRequestHandler: false,
            bucketCustomHeaders: "",
            ...overrides,
        } as BucketSyncSetting;
    }

    function createEnvironment() {
        const requestCount = reactiveSource(0);
        const responseCount = reactiveSource(0);
        const env = {
            services: {
                API: {
                    getCustomFetchHandler: () => undefined,
                    requestCount,
                    responseCount,
                },
            },
        } as unknown as LiveSyncJournalReplicatorEnv;
        return { env, requestCount, responseCount };
    }

    it("should upload, download, and delete a file", async () => {
        const settings = createSettings();
        const { env, requestCount, responseCount } = createEnvironment();

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
        adapter.dispose();
    });

    it("preserves real missing-object and unavailable-bucket outcomes", async () => {
        const { env, requestCount, responseCount } = createEnvironment();
        const missingObjectAdapter = new MinioStorageAdapter(createSettings(), env);
        const unavailableBucketAdapter = new MinioStorageAdapter(
            createSettings({ bucket: `${bucket}-missing-${Date.now()}` }),
            env
        );

        try {
            await expect(
                missingObjectAdapter.downloadWithResult(`missing-object-${Date.now()}.json`, true)
            ).resolves.toEqual({ status: JournalStorageReadStatuses.NOT_FOUND });
            await expect(
                unavailableBucketAdapter.downloadWithResult("control-object.json", true)
            ).resolves.toMatchObject({
                status: JournalStorageReadStatuses.UNAVAILABLE,
                error: expect.anything(),
            });
        } finally {
            missingObjectAdapter.dispose();
            unavailableBucketAdapter.dispose();
        }

        expect(requestCount.value).toBeGreaterThanOrEqual(2);
        expect(responseCount.value).toBe(requestCount.value);
    });
});
