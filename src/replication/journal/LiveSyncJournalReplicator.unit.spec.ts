import { describe, expect, it, vi } from "vitest";

import { DEFAULT_SETTINGS, REMOTE_MINIO } from "@lib/common/types.ts";
import { AdaptiveJournalSyncCore } from "./AdaptiveJournalSyncCore.ts";
import { JournalSyncCore } from "./JournalSyncCore.ts";
import { LiveSyncJournalReplicator } from "./LiveSyncJournalReplicator.ts";
import type { LiveSyncJournalReplicatorEnv } from "./LiveSyncJournalReplicatorEnv.ts";

function makeReplicatorWithSettings(settings: Record<string, unknown>): LiveSyncJournalReplicator {
    const replicator = Object.create(LiveSyncJournalReplicator.prototype) as LiveSyncJournalReplicator;
    replicator.env = {
        services: {
            setting: {
                currentSettings: () => settings,
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
});
