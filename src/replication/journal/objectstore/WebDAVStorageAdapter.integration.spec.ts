import { describe, expect, it } from "vitest";
import { WebDAVStorageAdapter } from "./WebDAVStorageAdapter.ts";
import type { LiveSyncJournalReplicatorEnv } from "@lib/replication/journal/LiveSyncJournalReplicatorEnv.ts";
import type { WebDAVSyncSetting } from "@lib/common/types.ts";

describe("WebDAVStorageAdapter Integration Tests", () => {
    const connectionURI =
        process.env.webDAVactiveConnectionURI ||
        (process.env.webdavEndpoint && process.env.webdavUsername && process.env.webdavPassword
            ? `sls+webdav://${encodeURIComponent(process.env.webdavUsername)}:${encodeURIComponent(
                  process.env.webdavPassword
              )}@${new URL(process.env.webdavEndpoint).host}${new URL(process.env.webdavEndpoint).pathname}?prefix=test%2F&insecure=${
                  new URL(process.env.webdavEndpoint).protocol === "http:" ? "true" : "false"
              }`
            : "");

    const isIntegrationEnvironmentReady = connectionURI !== "";

    it.runIf(isIntegrationEnvironmentReady)("should upload, download, list, and delete a file", async () => {
        const settings: WebDAVSyncSetting = {
            webDAVactiveConnectionURI: connectionURI,
        };
        // eslint-disable-next-line obsidianmd/no-global-this
        const fetchForTest = globalThis.fetch.bind(globalThis);

        const env = {
            services: {
                API: {
                    webCompatFetch: fetchForTest,
                    nativeFetch: fetchForTest,
                },
            },
        } as unknown as LiveSyncJournalReplicatorEnv;

        const adapter = new WebDAVStorageAdapter(settings, env);

        const isAvailable = await adapter.isAvailable();
        expect(isAvailable).toBe(true);

        const testContent = new TextEncoder().encode("Hello WebDAV Integration Test");
        const testKey = `integration-test-${Date.now()}.txt`;

        expect(await adapter.upload(testKey, testContent, "text/plain")).toBe(true);
        expect(await adapter.listFiles("")).toContain(testKey);

        const downloaded = await adapter.download(testKey, true);
        expect(downloaded).toBeTruthy();
        expect(new TextDecoder().decode(downloaded as Uint8Array)).toBe("Hello WebDAV Integration Test");

        expect(await adapter.deleteFiles([testKey])).toBe(true);
        expect(await adapter.listFiles("")).not.toContain(testKey);
    });

    it("skips tests if WebDAV environment variables are not set", () => {
        if (!isIntegrationEnvironmentReady) {
            console.warn(
                "Skipping WebDAVStorageAdapter integration tests. Please set webDAVactiveConnectionURI or webdavEndpoint, webdavUsername, and webdavPassword."
            );
        }
        expect(true).toBe(true);
    });
});
