import { describe, expect, it } from "vitest";
import { reactiveSource } from "octagonal-wheels/dataobject/reactive";
import {
    DEFAULT_SETTINGS,
    DEVICE_ID_PREFERRED,
    REMOTE_MINIO,
    type EntryMilestoneInfo,
    type RemoteDBSettings,
} from "@lib/common/types.ts";
import { CENTRAL_COMPATIBILITY_REJECTION_REASONS, type CentralCompatibilityDecision } from "@lib/replication/CentralCompatibility.ts";
import { LiveSyncJournalReplicator } from "../LiveSyncJournalReplicator.ts";
import type { LiveSyncJournalReplicatorEnv } from "../LiveSyncJournalReplicatorEnv.ts";
import { MinioStorageAdapter } from "./MinioStorageAdapter.ts";

const endpoint = process.env.minioEndpoint ?? "http://127.0.0.1:9000";
const accessKey = process.env.accessKey ?? "minioadmin";
const secretKey = process.env.secretKey ?? "minioadmin";
const bucket = process.env.bucketName ?? "livesync-test-bucket";
const firstKey = "ab".repeat(32);
const secondKey = "cd".repeat(32);
const journalMilestoneKey = "_00000000-milestone.json";

function settings(bucketPrefix: string, key: string, usePathObfuscation: boolean): RemoteDBSettings {
    return {
        ...DEFAULT_SETTINGS,
        remoteType: REMOTE_MINIO,
        endpoint,
        accessKey,
        secretKey,
        bucket,
        bucketPrefix,
        region: "us-east-1",
        forcePathStyle: true,
        useCustomRequestHandler: false,
        bucketCustomHeaders: "",
        encrypt: true,
        passphrase: "journal-id-integration-passphrase",
        usePathObfuscation,
        idDerivationVersion: 1,
        idDerivationKey: key,
    };
}

function makeReplicator(setting: RemoteDBSettings, nodeId: string): LiveSyncJournalReplicator {
    const checkpoints = new Map<string, unknown>();
    const env = {
        services: {
            API: {
                getAppVersion: () => "integration-test",
                getPluginVersion: () => "integration-test",
                getCustomFetchHandler: () => undefined,
                requestCount: reactiveSource(0),
                responseCount: reactiveSource(0),
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
            setting: { currentSettings: () => setting },
            vault: {
                getVaultName: () => nodeId,
                vaultName: () => "integration-vault",
            },
        },
    } as unknown as LiveSyncJournalReplicatorEnv;
    const replicator = new LiveSyncJournalReplicator(env);
    replicator.nodeid = nodeId;
    return replicator;
}

async function withRemote(
    usePathObfuscation: boolean,
    run: (setting: RemoteDBSettings, admin: MinioStorageAdapter, track: (replicator: LiveSyncJournalReplicator) => LiveSyncJournalReplicator) => Promise<void>
): Promise<void> {
    const bucketPrefix = "id-derivation-" + Date.now() + "-" + Math.random().toString(36).slice(2) + "/";
    const setting = settings(bucketPrefix, firstKey, usePathObfuscation);
    const admin = new MinioStorageAdapter(setting, {
        services: {
            API: {
                getCustomFetchHandler: () => undefined,
                requestCount: reactiveSource(0),
                responseCount: reactiveSource(0),
            },
        },
    } as unknown as LiveSyncJournalReplicatorEnv);
    const replicators: LiveSyncJournalReplicator[] = [];
    const track = (replicator: LiveSyncJournalReplicator) => {
        replicators.push(replicator);
        return replicator;
    };
    try {
        await run(setting, admin, track);
    } finally {
        for (const replicator of replicators) await replicator.closeReplication();
        const files = await admin.listFiles("");
        if (files.length > 0) await admin.deleteFiles(files);
        admin.dispose();
    }
}

async function milestone(admin: MinioStorageAdapter): Promise<EntryMilestoneInfo> {
    const bytes = await admin.download(journalMilestoneKey, true);
    expect(bytes).not.toBe(false);
    return JSON.parse(new TextDecoder().decode(bytes as Uint8Array)) as EntryMilestoneInfo;
}

describe("Journal ID-key agreement against real Object Storage", () => {
    it("admits the same key and rejects a different document ID key without changing the milestone", async () => {
        await withRemote(true, async (setting, admin, track) => {
            const first = track(makeReplicator(setting, "id-first"));
            await expect(first.checkReplicationConnectivity(false, false, false, setting)).resolves.toBe(true);
            const initial = await milestone(admin);
            expect(initial.encrypted_id_derivation_proof).toEqual(expect.any(String));
            expect(initial.encrypted_id_derivation_proof).not.toContain(firstKey);
            expect(initial.tweak_values[DEVICE_ID_PREFERRED]?.idDerivationVersion).toBe(1);

            const matching = track(makeReplicator(setting, "id-matching"));
            await expect(matching.checkReplicationConnectivity(false, false, false, setting)).resolves.toBe(true);
            const beforeMismatch = await milestone(admin);

            const differentSettings = { ...setting, idDerivationKey: secondKey };
            const different = track(makeReplicator(differentSettings, "id-different"));
            let decision: CentralCompatibilityDecision | undefined;
            await expect(
                different.checkReplicationConnectivity(false, false, false, differentSettings, undefined, (next) => {
                    decision = next;
                })
            ).resolves.toBe(false);
            expect(decision).toMatchObject({
                status: "rejected",
                reason: CENTRAL_COMPATIBILITY_REJECTION_REASONS.ID_DERIVATION_MISMATCH,
            });
            expect(await milestone(admin)).toEqual(beforeMismatch);
        });
    });

    it("admits different Chunk ID keys when document paths are unobfuscated", async () => {
        await withRemote(false, async (setting, admin, track) => {
            const first = track(makeReplicator(setting, "chunk-first"));
            await expect(first.checkReplicationConnectivity(false, false, false, setting)).resolves.toBe(true);
            expect((await milestone(admin)).encrypted_id_derivation_proof).toBeUndefined();

            const differentSettings = { ...setting, idDerivationKey: secondKey };
            const different = track(makeReplicator(differentSettings, "chunk-different"));
            await expect(
                different.checkReplicationConnectivity(false, false, false, differentSettings)
            ).resolves.toBe(true);
        });
    });
});
