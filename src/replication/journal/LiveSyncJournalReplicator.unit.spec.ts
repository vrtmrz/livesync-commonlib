import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, REMOTE_MINIO, REMOTE_WEBDAV } from "@lib/common/types.ts";
import { LiveSyncJournalReplicator } from "./LiveSyncJournalReplicator.ts";
import type { LiveSyncJournalReplicatorEnv } from "./LiveSyncJournalReplicatorEnv.ts";
import { WebDAVStorageAdapter } from "./objectstore/WebDAVStorageAdapter.ts";
import { MinioStorageAdapter } from "./objectstore/MinioStorageAdapter.ts";
import { getJournalRemoteDisplayName } from "./objectstore/JournalStorageAdapterFactory.ts";

function makeReplicatorWithSettings(settings: Record<string, unknown>): LiveSyncJournalReplicator {
    const replicator = Object.create(LiveSyncJournalReplicator.prototype) as LiveSyncJournalReplicator;
    replicator.env = {
        services: {
            setting: {
                currentSettings: () => settings,
            },
            keyValueDB: {
                simpleStore: {
                    get: vi.fn(),
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

describe("LiveSyncJournalReplicator storage selection", () => {
    it("should use WebDAVStorageAdapter for WebDAV remotes", () => {
        const replicator = makeReplicatorWithSettings({
            ...DEFAULT_SETTINGS,
            remoteType: REMOTE_WEBDAV,
            webDAVactiveConnectionURI: "sls+webdav://user:pass@example.com/dav",
        });

        expect(replicator.setupJournalSyncClient().storage).toBeInstanceOf(WebDAVStorageAdapter);
    });

    it("should keep MinioStorageAdapter for Object Storage remotes", () => {
        const replicator = makeReplicatorWithSettings({
            ...DEFAULT_SETTINGS,
            remoteType: REMOTE_MINIO,
        });

        expect(replicator.setupJournalSyncClient().storage).toBeInstanceOf(MinioStorageAdapter);
    });

    it("should recreate the storage adapter when the remote type changes", () => {
        const settings: Record<string, unknown> = {
            ...DEFAULT_SETTINGS,
            remoteType: REMOTE_MINIO,
            webDAVactiveConnectionURI: "",
        };
        const replicator = makeReplicatorWithSettings(settings);

        expect(replicator.setupJournalSyncClient().storage).toBeInstanceOf(MinioStorageAdapter);

        settings.remoteType = REMOTE_WEBDAV;
        settings.webDAVactiveConnectionURI = "sls+webdav://user:pass@example.com/dav";

        expect(replicator.setupJournalSyncClient().storage).toBeInstanceOf(WebDAVStorageAdapter);
    });

    it("should test WebDAV connectivity with WebDAVStorageAdapter", async () => {
        const webDAVIsAvailable = vi.spyOn(WebDAVStorageAdapter.prototype, "isAvailable").mockResolvedValue(true);
        const webDAVListFiles = vi.spyOn(WebDAVStorageAdapter.prototype, "listFiles").mockResolvedValue([]);
        const minioListFiles = vi.spyOn(MinioStorageAdapter.prototype, "listFiles").mockResolvedValue([]);
        const replicator = makeReplicatorWithSettings({
            ...DEFAULT_SETTINGS,
            remoteType: REMOTE_WEBDAV,
            webDAVactiveConnectionURI: "sls+webdav://user:pass@example.com/dav",
        });

        await expect(
            replicator.tryConnectRemote({
                ...DEFAULT_SETTINGS,
                remoteType: REMOTE_WEBDAV,
                webDAVactiveConnectionURI: "sls+webdav://user:pass@example.com/dav",
            })
        ).resolves.toBe(true);

        expect(webDAVIsAvailable).toHaveBeenCalled();
        expect(webDAVListFiles).not.toHaveBeenCalled();
        expect(minioListFiles).not.toHaveBeenCalled();

        webDAVIsAvailable.mockRestore();
        webDAVListFiles.mockRestore();
        minioListFiles.mockRestore();
    });

    it("should fail WebDAV connectivity when the collection is unavailable", async () => {
        const webDAVIsAvailable = vi.spyOn(WebDAVStorageAdapter.prototype, "isAvailable").mockResolvedValue(false);
        const replicator = makeReplicatorWithSettings({
            ...DEFAULT_SETTINGS,
            remoteType: REMOTE_WEBDAV,
            webDAVactiveConnectionURI: "sls+webdav://user:pass@example.com/dav",
        });

        await expect(
            replicator.tryConnectRemote({
                ...DEFAULT_SETTINGS,
                remoteType: REMOTE_WEBDAV,
                webDAVactiveConnectionURI: "sls+webdav://user:pass@example.com/dav",
            })
        ).resolves.toBe(false);

        webDAVIsAvailable.mockRestore();
    });

    it("should mask WebDAV credentials and query parameters in the remote display name", () => {
        expect(
            getJournalRemoteDisplayName({
                ...DEFAULT_SETTINGS,
                remoteType: REMOTE_WEBDAV,
                webDAVactiveConnectionURI:
                    "sls+webdav://user:pass@example.com/dav?prefix=vault%2F&headers=Authorization%3A%20Bearer%20token",
            })
        ).toBe("https://example.com/dav");
    });
});
