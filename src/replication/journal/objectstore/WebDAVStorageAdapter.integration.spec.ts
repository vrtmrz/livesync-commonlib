import { reactiveSource } from "octagonal-wheels/dataobject/reactive";
import { describe, expect, it } from "vitest";

import type { WebDAVSyncSetting } from "@lib/common/types.ts";
import type { LiveSyncJournalReplicatorEnv } from "@lib/replication/journal/LiveSyncJournalReplicatorEnv.ts";
import { ADAPTIVE_JOURNAL_REQUIRED_CAPABILITIES_V1 } from "../adaptive/AdaptiveJournalManifest.ts";
import { WebDAVStorageAdapter } from "./WebDAVStorageAdapter.ts";

function createAdapter(label: string) {
    const endpoint = process.env.webdavEndpoint;
    if (!endpoint) return undefined;
    const url = new URL(endpoint);
    const prefix = `${label}-${process.pid}-${Date.now()}/`;
    const connection = new URL(`sls+webdav://${url.host}${url.pathname}`);
    connection.searchParams.set("insecure", url.protocol === "http:" ? "true" : "false");
    connection.searchParams.set("prefix", prefix);
    const requestCount = reactiveSource(0);
    const responseCount = reactiveSource(0);
    const settings = {
        journalFormat: label.startsWith("adaptive") ? "adaptive-v1" : "opaque-v1",
        packReadPolicy: label.startsWith("adaptive") ? "range" : "whole-pack",
        webDAVactiveConnectionURI: connection.toString(),
    } as WebDAVSyncSetting;
    const env = {
        services: {
            API: {
                nativeFetch: fetch,
                requestCount,
                responseCount,
                webCompatFetch: fetch,
            },
        },
    } as unknown as LiveSyncJournalReplicatorEnv;
    return {
        adapter: new WebDAVStorageAdapter(settings, env),
        requestCount,
        responseCount,
    };
}

describe("WebDAVStorageAdapter integration", () => {
    it("uploads, lists, downloads, and removes Opaque objects", async () => {
        const fixture = createAdapter("opaque-adapter");
        if (!fixture) return;
        const { adapter, requestCount, responseCount } = fixture;
        const key = "0001-journal.jsonl.gz";
        const bytes = new TextEncoder().encode("WebDAV integration payload");

        try {
            await expect(adapter.upload(key, bytes, "application/gzip")).resolves.toBe(true);
            await expect(adapter.listFiles("")).resolves.toEqual([key]);
            await expect(adapter.download(key, true)).resolves.toEqual(bytes);
            await expect(adapter.inspectRemoteFormat()).resolves.toBe("opaque-v1");
            await expect(adapter.deleteFiles([key])).resolves.toBe(true);
            await expect(adapter.listFiles("")).resolves.toEqual([]);
            expect(responseCount.value).toBe(requestCount.value);
        } finally {
            await expect(adapter.resetJournalStorage()).resolves.toBe(true);
        }
    });

    it("proves the Adaptive object semantics against an external DAV implementation", async () => {
        const fixture = createAdapter("adaptive-adapter");
        if (!fixture) return;
        const { adapter, requestCount, responseCount } = fixture;
        const key = "a1~pack~integration.bin";
        const bytes = new Uint8Array([0, 1, 2, 3, 4, 5]);

        try {
            await expect(
                adapter.verifyCapabilities([...ADAPTIVE_JOURNAL_REQUIRED_CAPABILITIES_V1, "byte-range"])
            ).resolves.toEqual({ status: "verified" });
            await expect(adapter.createAdaptiveObject(key, bytes, "application/octet-stream")).resolves.toMatchObject({
                status: "created",
            });
            await expect(
                adapter.createAdaptiveObject(key, new Uint8Array([9]), "application/octet-stream")
            ).resolves.toEqual({ status: "already-exists" });
            await expect(adapter.readAdaptiveObject(key, { length: 3, offset: 2 })).resolves.toMatchObject({
                status: "found",
                value: new Uint8Array([2, 3, 4]),
            });
            await expect(adapter.inspectRemoteFormat()).resolves.toBe("adaptive-v1");

            const requestsBeforeReceivePhase = requestCount.value;
            await adapter.runAdaptiveJournalReceivePhase(async () => {
                await expect(adapter.listAdaptiveObjects("a1~pack~")).resolves.toEqual({
                    keys: [key],
                    status: "ok",
                });
                await expect(adapter.listAdaptiveObjects("a1~commit~")).resolves.toEqual({
                    keys: [],
                    status: "ok",
                });
            });
            expect(requestCount.value - requestsBeforeReceivePhase).toBe(1);
            expect(responseCount.value).toBe(requestCount.value);
        } finally {
            await expect(adapter.resetJournalStorage()).resolves.toBe(true);
        }
        await expect(adapter.inspectRemoteFormat()).resolves.toBe("empty");
    });
});
