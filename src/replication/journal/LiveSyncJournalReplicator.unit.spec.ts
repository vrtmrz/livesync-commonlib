import { describe, expect, it, vi } from "vitest";

import { DEFAULT_SETTINGS, REMOTE_MINIO, REMOTE_WEBDAV } from "@lib/common/types.ts";
import { AdaptiveJournalSyncCore } from "./AdaptiveJournalSyncCore.ts";
import { JournalSyncCore } from "./JournalSyncCore.ts";
import { LiveSyncJournalReplicator } from "./LiveSyncJournalReplicator.ts";
import type { LiveSyncJournalReplicatorEnv } from "./LiveSyncJournalReplicatorEnv.ts";

function makeReplicatorWithSettings(settings: Record<string, unknown>): LiveSyncJournalReplicator {
    const replicator = Object.create(LiveSyncJournalReplicator.prototype) as LiveSyncJournalReplicator;
    const saveSettingData = vi.fn(async () => undefined);
    replicator.env = {
        services: {
            setting: {
                currentSettings: () => settings,
                saveSettingData,
                updateSettings: vi.fn(async (update: (current: Record<string, unknown>) => Record<string, unknown>) => {
                    update(settings);
                }),
            },
            keyValueDB: {
                simpleStore: {
                    delete: vi.fn(),
                    get: vi.fn(),
                    keys: vi.fn(),
                    set: vi.fn(),
                },
            },
            replication: {
                parseSynchroniseResult: vi.fn(async () => true),
            },
        },
    } as unknown as LiveSyncJournalReplicatorEnv;
    return replicator;
}

describe("LiveSyncJournalReplicator S3 Journal selection", () => {
    it("selects S3-compatible Object Storage and keeps existing profiles on Opaque Journal", () => {
        const replicator = makeReplicatorWithSettings({
            ...DEFAULT_SETTINGS,
            remoteType: REMOTE_MINIO,
        });

        const client = replicator.setupJournalSyncClient();

        expect(client).toBeInstanceOf(JournalSyncCore);
        expect(client.storage.kind).toBe("s3");
    });

    it("recreates the core but reuses the S3 adapter when the selected format changes", () => {
        const settings: Record<string, unknown> = {
            ...DEFAULT_SETTINGS,
            remoteType: REMOTE_MINIO,
        };
        const replicator = makeReplicatorWithSettings(settings);
        const opaque = replicator.setupJournalSyncClient();

        settings.journalFormat = "adaptive-v1";
        const adaptive = replicator.setupJournalSyncClient();

        expect(adaptive).toBeInstanceOf(AdaptiveJournalSyncCore);
        expect(adaptive).not.toBe(opaque);
        expect(adaptive.storage).toBe(opaque.storage);
    });

    it("selects WebDAV storage while retaining the default Opaque Journal format", () => {
        const replicator = makeReplicatorWithSettings({
            ...DEFAULT_SETTINGS,
            remoteType: REMOTE_WEBDAV,
            webDAVactiveConnectionURI: "sls+webdav://example.invalid/dav",
        });

        const client = replicator.setupJournalSyncClient();

        expect(client).toBeInstanceOf(JournalSyncCore);
        expect(client.storage.kind).toBe("webdav");
    });

    it("retries local host ID initialisation after an early failure", async () => {
        const replicator = makeReplicatorWithSettings({
            ...DEFAULT_SETTINGS,
            remoteType: REMOTE_MINIO,
            journalFormat: "adaptive-v1",
        });
        Object.assign(replicator, { nodeInitialisation: Promise.resolve(false) });
        const initialise = vi.fn(async () => {
            replicator.nodeid = "receiving-host";
            return true;
        });
        replicator.initializeDatabaseForReplication = initialise;

        const client = replicator.setupJournalSyncClient();
        const resolveHostId = (
            client as unknown as {
                resolveHostId: () => Promise<string>;
            }
        ).resolveHostId;

        await expect(resolveHostId()).resolves.toBe("receiving-host");
        expect(initialise).toHaveBeenCalledOnce();
    });

    it("persists a first accepted repository identity in the active profile", async () => {
        const repositoryId = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
        const settings: Record<string, unknown> = {
            ...DEFAULT_SETTINGS,
            activeConfigurationId: "adaptive",
            expectedRepositoryId: "",
            journalFormat: "adaptive-v1",
            packReadPolicy: "whole-pack",
            remoteConfigurations: {
                adaptive: {
                    id: "adaptive",
                    isEncrypted: false,
                    name: "Adaptive remote",
                    uri: "sls+s3://key:secret@storage.example/?bucket=notes&journalFormat=adaptive-v1",
                },
            },
            remoteType: REMOTE_MINIO,
        };
        const replicator = makeReplicatorWithSettings(settings);
        const client = replicator.setupJournalSyncClient();
        const acceptRepository = (
            client as unknown as {
                onRepositoryAccepted: (acceptedRepositoryId: string) => Promise<void>;
            }
        ).onRepositoryAccepted;

        await acceptRepository(repositoryId);

        expect(settings.expectedRepositoryId).toBe(repositoryId);
        expect((settings.remoteConfigurations as Record<string, { uri: string }>).adaptive.uri).toContain(
            `expectedRepositoryId=${repositoryId}`
        );
        expect(replicator.env.services.setting.saveSettingData).toHaveBeenCalledOnce();

        await acceptRepository(repositoryId);
        expect(replicator.env.services.setting.saveSettingData).toHaveBeenCalledOnce();
    });
});

describe("LiveSyncJournalReplicator", () => {
    it("propagates a Journal core synchronisation failure", async () => {
        const replicator = Object.create(LiveSyncJournalReplicator.prototype) as LiveSyncJournalReplicator;
        replicator.checkReplicationConnectivity = vi.fn(async () => true);
        const sync = vi.fn(async () => false);
        replicator.setupJournalSyncClient = vi.fn(() => ({ sync }) as unknown as JournalSyncCore);

        await expect(replicator.openReplication(DEFAULT_SETTINGS, false, true, false)).resolves.toBe(false);
        expect(sync).toHaveBeenCalledWith(true);
    });

    it("uses the typed Journal inspection boundary for connection tests", async () => {
        const settings = {
            ...DEFAULT_SETTINGS,
            remoteType: REMOTE_WEBDAV,
            webDAVactiveConnectionURI: "sls+webdav://example.invalid/dav",
        };
        const replicator = makeReplicatorWithSettings(settings);
        const inspectJournalStorageConnection = vi.fn(async () => ({
            available: true,
            remoteFormat: "empty" as const,
        }));
        replicator.inspectJournalStorageConnection = inspectJournalStorageConnection;

        await expect(replicator.tryConnectRemote(settings, false)).resolves.toBe(true);
        expect(inspectJournalStorageConnection).toHaveBeenCalledWith(settings);
    });
});
