import type { RemoteDBSettings } from "@lib/common/types.ts";
import type { LiveSyncJournalReplicatorEnv } from "@lib/replication/journal/LiveSyncJournalReplicatorEnv.ts";
import type { IJournalStorage } from "./JournalStorageAdapter.ts";
import { MinioStorageAdapter } from "./MinioStorageAdapter.ts";
import { WebDAVStorageAdapter } from "./WebDAVStorageAdapter.ts";
import { REMOTE_WEBDAV } from "@lib/common/models/setting.const.ts";

export function createJournalStorageAdapter(
    settings: RemoteDBSettings,
    env: LiveSyncJournalReplicatorEnv
): IJournalStorage {
    return settings.remoteType === REMOTE_WEBDAV
        ? new WebDAVStorageAdapter(settings, env)
        : new MinioStorageAdapter(settings, env);
}

export function isJournalStorageAdapterCompatible(storage: IJournalStorage, settings: RemoteDBSettings): boolean {
    if (settings.remoteType === REMOTE_WEBDAV) {
        return storage instanceof WebDAVStorageAdapter;
    }
    return storage instanceof MinioStorageAdapter;
}

export function getJournalRemoteDisplayName(setting: RemoteDBSettings): string {
    if (setting.remoteType !== REMOTE_WEBDAV) {
        return setting.endpoint;
    }
    try {
        const url = new URL(setting.webDAVactiveConnectionURI.replace(/^sls\+webdav:/, "https:"));
        url.username = "";
        url.password = "";
        url.search = "";
        url.hash = "";
        return url.toString();
    } catch {
        return "WebDAV";
    }
}

export async function testJournalStorageConnectivity(
    storage: IJournalStorage,
    setting: RemoteDBSettings
): Promise<boolean> {
    if (setting.remoteType === REMOTE_WEBDAV) {
        return await storage.isAvailable();
    }
    await storage.listFiles("", 1);
    return true;
}
