import { reactiveSource } from "octagonal-wheels/dataobject/reactive";
import { describe, expect, it } from "vitest";

import { DEFAULT_SETTINGS, REMOTE_WEBDAV, type RemoteDBSettings, type WebDAVSyncSetting } from "@lib/common/types.ts";
import {
    expectAdaptiveObjectJournalLayout,
    runAdaptiveJournalTwoClientIntegration,
} from "@lib/replication/journal/AdaptiveJournalIntegrationHarness.spec.ts";
import type { LiveSyncJournalReplicatorEnv } from "@lib/replication/journal/LiveSyncJournalReplicatorEnv.ts";
import { ADAPTIVE_JOURNAL_REQUIRED_CAPABILITIES_V1 } from "../adaptive/AdaptiveJournalManifest.ts";
import { serialiseWebDAVConnectionURI } from "./JournalStorageConnection.ts";
import { WebDAVStorageAdapter } from "./WebDAVStorageAdapter.ts";

function createSettings(label: string): RemoteDBSettings | undefined {
    const endpoint = process.env.webdavEndpoint;
    if (!endpoint) return undefined;
    const prefix = `${label}-${process.pid}-${Date.now()}/`;
    return {
        ...DEFAULT_SETTINGS,
        journalFormat: label.startsWith("adaptive") ? "adaptive-v1" : "opaque-v1",
        packReadPolicy: label.startsWith("adaptive") ? "range" : "whole-pack",
        remoteType: REMOTE_WEBDAV,
        webDAVactiveConnectionURI: serialiseWebDAVConnectionURI({
            customHeaders: "",
            endpoint,
            password: "",
            prefix,
            useCustomRequestHandler: false,
            username: "",
        }),
    };
}

function createAdapter(label: string) {
    const settings = createSettings(label);
    if (!settings) return undefined;
    const requestCount = reactiveSource(0);
    const responseCount = reactiveSource(0);
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
        adapter: new WebDAVStorageAdapter(settings as WebDAVSyncSetting, env),
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

    it.each(["whole-pack", "range"] as const)(
        "sends and receives Adaptive Journal changes through the real WebDAV adapter with %s retrieval",
        async (packReadPolicy) => {
            const settings = createSettings(`adaptive-${packReadPolicy}-journal-core`);
            if (!settings) return;
            settings.packReadPolicy = packReadPolicy;
            await runAdaptiveJournalTwoClientIntegration({
                inspectRemote: expectAdaptiveObjectJournalLayout,
                label: `adaptive-webdav-${packReadPolicy}-journal-core`,
                settings,
            });
        }
    );
});
