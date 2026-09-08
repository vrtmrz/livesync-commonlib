import { describe, it, expect } from "vitest";
import { MinioStorageAdapter } from "./MinioStorageAdapter.ts";
import {
    DEFAULT_SETTINGS,
    DEVICE_ID_PREFERRED,
    MILESTONE_DOCID,
    type BucketSyncSetting,
    type EntryMilestoneInfo,
    type RemoteDBSettings,
} from "@lib/common/types.ts";
import type { LiveSyncJournalReplicatorEnv } from "@lib/replication/journal/LiveSyncJournalReplicatorEnv.ts";
import { reactiveSource } from "octagonal-wheels/dataobject/reactive";
import { JournalStorageReadStatuses } from "./JournalStorageAdapter.ts";
import { LiveSyncJournalReplicator } from "../LiveSyncJournalReplicator.ts";
import {
    CENTRAL_COMPATIBILITY_REJECTION_REASONS,
    type CentralCompatibilityDecision,
} from "@lib/replication/CentralCompatibility.ts";

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

    it("rejects a real Object Storage connection when filename-case semantics differ", async () => {
        const bucketPrefix = `tweak-compatibility-${Date.now()}-${Math.random().toString(36).slice(2)}/`;
        const settings = {
            ...DEFAULT_SETTINGS,
            ...createSettings({ bucketPrefix }),
            handleFilenameCaseSensitive: true,
        } as RemoteDBSettings;
        const requestCount = reactiveSource(0);
        const responseCount = reactiveSource(0);
        const checkpoints = new Map<string, unknown>();
        const env = {
            services: {
                API: {
                    getAppVersion: () => "integration-test",
                    getPluginVersion: () => "integration-test",
                    getCustomFetchHandler: () => undefined,
                    requestCount,
                    responseCount,
                },
                context: { translate: (key: string) => key },
                keyValueDB: {
                    simpleStore: {
                        get: async (key: string) => checkpoints.get(key),
                        set: async (key: string, value: unknown) => {
                            checkpoints.set(key, value);
                        },
                    },
                },
                replication: { parseSynchroniseResult: async () => true },
                replicator: { replicationStatics: reactiveSource(undefined) },
                setting: { currentSettings: () => settings },
                vault: {
                    getVaultName: () => "integration-device",
                    vaultName: () => "integration-vault",
                },
            },
        } as unknown as LiveSyncJournalReplicatorEnv;
        const administration = new MinioStorageAdapter(settings as BucketSyncSetting, env);
        const milestone: EntryMilestoneInfo = {
            _id: MILESTONE_DOCID,
            type: "milestoneinfo",
            created: Date.now(),
            locked: false,
            accepted_nodes: ["remote-node"],
            node_chunk_info: { "remote-node": { min: 0, max: 2400, current: 2 } },
            node_info: {
                "remote-node": {
                    app_version: "integration-test",
                    plugin_version: "integration-test",
                    vault_name: "integration-vault",
                    device_name: "remote-device",
                    progress: "",
                    last_connected: Date.now(),
                },
            },
            tweak_values: { [DEVICE_ID_PREFERRED]: {} },
        };
        const replicator = new LiveSyncJournalReplicator(env);
        replicator.nodeid = "local-node";
        let decision: CentralCompatibilityDecision | undefined;

        try {
            expect(
                await administration.upload(
                    "_00000000-milestone.json",
                    new TextEncoder().encode(JSON.stringify(milestone)),
                    "application/json"
                )
            ).toBe(true);

            await expect(
                replicator.checkReplicationConnectivity(false, false, false, settings, undefined, (next) => {
                    decision = next;
                })
            ).resolves.toBe(false);
            expect(decision).toMatchObject({
                status: "rejected",
                reason: CENTRAL_COMPATIBILITY_REJECTION_REASONS.TWEAK_MISMATCH,
                preferredTweakValue: {},
                tweakAssessment: {
                    alignment: "mismatched",
                    currentValues: expect.objectContaining({ handleFilenameCaseSensitive: true }),
                    preferredValues: {},
                },
            });
        } finally {
            await replicator.closeReplication();
            const files = await administration.listFiles("");
            if (files.length > 0) await administration.deleteFiles(files);
            administration.dispose();
        }

        expect(requestCount.value).toBeGreaterThan(0);
        expect(responseCount.value).toBe(requestCount.value);
    });
});
